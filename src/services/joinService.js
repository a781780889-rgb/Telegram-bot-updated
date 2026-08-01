/**
 * Join-to-Links Service
 *
 * Core engine for the "الانضمام للروابط" feature:
 *  - Parses / validates group links (public @username or invite hash)
 *  - Resolves a link to its Telegram group ID WITHOUT joining first
 *  - Enforces global dedup by Telegram ID (never the raw link)
 *  - Distributes queued links across enabled, available accounts —
 *    ONE independent, durable, strictly-in-order queue per account
 *    (see the "Queueing model" note in joinDb.js)
 *  - Never runs more than one join for the same account at the same time —
 *    each account has exactly one worker, and that worker awaits every
 *    step of every attempt before moving on. There is no code path that
 *    starts a second concurrent attempt for an account.
 *  - Randomizes the delay between joins AND the rest between batches
 *    (per-account, re-rolled every time) so accounts don't all move in
 *    lockstep and don't look automated.
 *  - Detects FloodWait / limit / ban-type errors, pauses the affected
 *    account WITHOUT losing the link it was working on, and auto-resumes
 *    once the cooldown elapses.
 *  - Retries transient failures a bounded number of times before giving
 *    up on a link; permanent errors (invalid/expired/private/etc.) are
 *    never retried.
 *  - Logs every attempt in detail (duration, result, FloodWait seconds).
 *
 * One in-memory runner per userId; all durable state (queue position,
 * counters, retry schedule) lives in joinDb so a restart never loses
 * queued links — see joinDb.initJoinSchema()'s crash-recovery sweep.
 */

const { Api } = require('telegram');
const logger = require('../utils/logger');
const { accountQueries } = require('../database/db');
const {
  joinGroupQueries,
  joinLinkQueries,
  joinAccountQueries,
  joinSettingsQueries,
  joinLogQueries,
  toSqliteUtc,
  fromSqliteUtc,
} = require('../database/joinDb');
const { loadSession, restoreSessionFile } = require('./telegramClient');

// A FloodWait longer than this is not worth sleeping through in-process
// (the container may well restart before it elapses anyway — Railway logs
// showed exactly that kind of instability). The account is marked banned
// with the real cooldown and the link is freed for a future run/account
// instead of holding a worker asleep for hours.
const FLOOD_WAIT_SLEEP_CAP_SECONDS = 3 * 60 * 60; // 3 hours

// ─── In-memory run registry ───────────────────────────────────────────────────

/**
 * userId → {
 *   running: boolean,        // the run as a whole is still active
 *   stopping: boolean,       // a stop was requested
 *   accountIds: number[],    // accounts participating in this run
 *   workers: Map<accountId, boolean>  // true while that account's worker is alive
 * }
 */
const activeRuns = new Map();

const isRunning = (userId) => !!activeRuns.get(String(userId))?.running;

const requestStop = (userId) => {
  const run = activeRuns.get(String(userId));
  if (run) run.stopping = true;
};

// ─── Link parsing ─────────────────────────────────────────────────────────────

const INVITE_HASH_RE = /(?:t\.me\/joinchat\/|t\.me\/\+)([\w-]+)/i;
const PUBLIC_USERNAME_RE = /t\.me\/([a-zA-Z0-9_]{4,32})\/?$/;

/**
 * Classify a raw string as a valid public link, valid invite link, or invalid.
 * @param {string} raw
 * @returns {{ valid: boolean, type: 'public'|'invite'|null, value: string|null }}
 */
const parseLink = (raw) => {
  const text = (raw || '').trim();
  if (!text) return { valid: false, type: null, value: null };

  const inviteMatch = text.match(INVITE_HASH_RE);
  if (inviteMatch) return { valid: true, type: 'invite', value: inviteMatch[1] };

  const usernameMatch = text.match(PUBLIC_USERNAME_RE);
  if (usernameMatch) {
    const reserved = ['joinchat', 'share', 'addstickers', 'proxy'];
    if (reserved.includes(usernameMatch[1].toLowerCase())) {
      return { valid: false, type: null, value: null };
    }
    return { valid: true, type: 'public', value: usernameMatch[1] };
  }

  // Bare @username or username without t.me prefix
  if (/^@?[a-zA-Z0-9_]{4,32}$/.test(text)) {
    return { valid: true, type: 'public', value: text.replace(/^@/, '') };
  }

  return { valid: false, type: null, value: null };
};

/**
 * Split raw multi-line text into an array of validated, deduplicated links.
 * (De-dup here is WITHIN this one submission; joinLinkQueries.insertMany
 * separately de-dupes against links already queued from earlier submissions.)
 * @param {string} text
 * @returns {{ links: string[], invalidCount: number }}
 */
const extractLinksFromText = (text) => {
  const lines = (text || '')
    .split(/[\n\r]+|\s+/)
    .map((l) => l.trim())
    .filter(Boolean);

  const seen = new Set();
  const links = [];
  let invalidCount = 0;

  for (const line of lines) {
    const parsed = parseLink(line);
    if (!parsed.valid) {
      invalidCount++;
      continue;
    }
    const key = `${parsed.type}:${parsed.value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(line);
  }

  return { links, invalidCount };
};

// ─── Small helpers ────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Inclusive random integer in [min, max] (order-independent). */
const randomInt = (min, max) => {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
};

const POLL_INTERVAL_MS = 1000;

/**
 * Sleeps up to `ms`, checking run.stopping roughly every second so a
 * user-requested stop takes effect within ~1s instead of waiting out
 * whatever long delay/rest/FloodWait was in progress.
 * @returns {Promise<boolean>} true if interrupted by a stop request
 */
const sleepInterruptible = async (ms, run) => {
  let remaining = ms;
  while (remaining > 0) {
    if (run.stopping) return true;
    const chunk = Math.min(POLL_INTERVAL_MS, remaining);
    await sleep(chunk);
    remaining -= chunk;
  }
  return !!run.stopping;
};

// ─── Client acquisition ───────────────────────────────────────────────────────

/**
 * Get (or open) an authenticated GramJS client for an account, configured
 * for a LONG-LIVED connection (autoReconnect on) — join runs can last many
 * minutes with rests/FloodWaits in between, unlike the short-lived
 * "forSearch" connections used elsewhere in the app. Using the short-lived
 * profile here was causing the connection to give up silently on the first
 * network hiccup and then spin retrying forever (visible in production as
 * a continuous stream of "Error: TIMEOUT" in the deploy logs).
 * @param {object} account  full row from accounts table
 * @returns {Promise<TelegramClient>}
 */
const getClientForAccount = async (account) => {
  const sessionFile = restoreSessionFile(account) || account.session_file;
  if (!sessionFile) throw new Error('NO_SESSION_FILE');
  return loadSession(sessionFile, { longLived: true });
};

// ─── Error classification ──────────────────────────────────────────────────────

/**
 * Classify a thrown MTProto error into an actionable category.
 *
 * IMPORTANT: GramJS's FloodWaitError does NOT put "FLOOD_WAIT" in
 * `error.errorMessage` — that field is a fixed generic label ("FLOOD") for
 * every flood error regardless of the wait length; the actual duration is
 * only ever available on `error.seconds`. Matching on the message string
 * alone (as Telegram's raw wire error "FLOOD_WAIT_<n>" would suggest) never
 * matches a real GramJS FloodWaitError — every FloodWait fell through to a
 * generic unhandled failure, so accounts never paused and the queue kept
 * firing requests straight through the rate limit. This is checked first
 * and via multiple signals so it can never be missed.
 */
const classifyJoinError = (error) => {
  const isFloodWait =
    error?.constructor?.name === 'FloodWaitError' ||
    typeof error?.seconds === 'number' ||
    error?.errorMessage === 'FLOOD' ||
    error?.code === 420;

  const rawMsg = error?.errorMessage || error?.message || String(error || '');

  if (isFloodWait || /FLOOD_WAIT/i.test(rawMsg)) {
    const seconds =
      typeof error?.seconds === 'number'
        ? error.seconds
        : parseInt(rawMsg.match(/(\d+)\s*second/i)?.[1] || rawMsg.match(/\d+/)?.[0] || '60', 10);
    return { kind: 'flood_wait', seconds, message: `FloodWait: يجب الانتظار ${seconds} ثانية قبل أي طلب جديد` };
  }
  if (/USER_ALREADY_PARTICIPANT/i.test(rawMsg)) {
    return { kind: 'already_member', seconds: 0, message: 'الحساب عضو بالفعل في هذه المجموعة' };
  }
  if (/INVITE_HASH_EXPIRED/i.test(rawMsg)) {
    return { kind: 'link_terminal', linkStatus: 'expired', seconds: 0, message: 'رابط الدعوة منتهي الصلاحية' };
  }
  if (/INVITE_HASH_INVALID|USERNAME_NOT_OCCUPIED|USERNAME_INVALID/i.test(rawMsg)) {
    return { kind: 'link_terminal', linkStatus: 'invalid', seconds: 0, message: 'الرابط أو اسم المستخدم غير موجود' };
  }
  if (/INVITE_REQUEST_SENT/i.test(rawMsg)) {
    return { kind: 'link_terminal', linkStatus: 'needs_approval', seconds: 0, message: 'تم إرسال طلب الانضمام — بانتظار موافقة المشرف' };
  }
  if (/CHANNEL_PRIVATE/i.test(rawMsg)) {
    return { kind: 'link_terminal', linkStatus: 'private', seconds: 0, message: 'المجموعة خاصة أو غير متاحة لهذا الحساب' };
  }
  if (/CHANNELS_TOO_MUCH|USER_CHANNELS_TOO_MUCH/i.test(rawMsg)) {
    return { kind: 'account_limit', seconds: 0, message: 'وصل الحساب للحد الأقصى لعدد المجموعات المسموح به في تيليجرام' };
  }
  if (/USER_DEACTIVATED_BAN|USER_DEACTIVATED|AUTH_KEY_UNREGISTERED|SESSION_REVOKED/i.test(rawMsg)) {
    return { kind: 'account_dead', seconds: 0, message: 'الحساب معطل أو انتهت صلاحية الجلسة — يحتاج تسجيل دخول' };
  }
  if (/USER_BANNED_IN_CHANNEL|CHAT_ADMIN_REQUIRED|USER_RESTRICTED|JOIN_AS_PEER_INVALID|CHAT_WRITE_FORBIDDEN/i.test(rawMsg)) {
    return { kind: 'link_terminal', linkStatus: 'failed_privacy', seconds: 0, message: 'ممنوع الانضمام لهذه المجموعة (قيود خصوصية)' };
  }
  return { kind: 'transient', seconds: 0, message: rawMsg.slice(0, 150) };
};

// ─── Resolve + join a single link with one account ───────────────────────────

/**
 * Attempt to join one link with one client. Resolves the group ID first
 * (via CheckChatInvite for invite links, or entity resolution for public
 * links) so duplicates can be skipped WITHOUT ever attempting the join.
 *
 * @returns {Promise<{ status: 'joined'|'skipped'|'invalid'|'failed', telegramId?, title?, reason?, errorInfo? }>}
 */
const joinOneLink = async (client, userId, linkRow) => {
  const parsed = parseLink(linkRow.url);
  if (!parsed.valid) {
    return { status: 'invalid', reason: 'رابط غير صالح' };
  }

  try {
    let telegramId = null;
    let title = null;

    if (parsed.type === 'invite') {
      const info = await client.invoke(new Api.messages.CheckChatInvite({ hash: parsed.value }));
      if (info.chat) {
        telegramId = String(info.chat.id);
        title = info.chat.title;
      } else if (info.className === 'ChatInviteAlready' && info.chat) {
        telegramId = String(info.chat.id);
        title = info.chat.title;
      }
    } else {
      const entity = await client.getEntity(parsed.value);
      telegramId = String(entity.id);
      title = entity.title || entity.username || parsed.value;
    }

    if (telegramId && joinGroupQueries.exists(userId, telegramId)) {
      return { status: 'skipped', reason: 'مجموعة مكررة (تم الانضمام إليها مسبقًا)', telegramId, title };
    }

    // Not a duplicate (or ID unresolved before join) — perform the join.
    if (parsed.type === 'invite') {
      const result = await client.invoke(new Api.messages.ImportChatInvite({ hash: parsed.value }));
      const chat = result?.chats?.[0];
      if (chat) {
        telegramId = String(chat.id);
        title = chat.title;
      }
    } else {
      const entity = await client.getEntity(parsed.value);
      await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
      telegramId = String(entity.id);
      title = entity.title || entity.username || parsed.value;
    }

    if (!telegramId) {
      return { status: 'failed', errorInfo: { kind: 'transient', seconds: 0, message: 'تعذر تحديد هوية المجموعة بعد الانضمام' } };
    }

    // Re-check race condition: another account may have registered it
    // between our first check and the join completing.
    if (joinGroupQueries.exists(userId, telegramId)) {
      return { status: 'skipped', reason: 'مجموعة مكررة (تم الانضمام إليها بواسطة حساب آخر)', telegramId, title };
    }

    return { status: 'joined', telegramId, title };
  } catch (error) {
    const info = classifyJoinError(error);

    if (info.kind === 'already_member') {
      return { status: 'skipped', reason: info.message };
    }

    logger.error('joinOneLink error:', error?.message || error);
    return { status: 'failed', errorInfo: info };
  }
};

// ─── Drive one link to a final disposition (handles retries in place) ────────

/**
 * Attempts `linkRow` to completion, handling FloodWait (sleep in place,
 * retry the SAME link — never skip ahead) and transient-error backoff
 * (bounded retries, also in place) internally. The caller only ever sees
 * one of three outcomes:
 *
 *  - 'done'          the link reached a final status (joined / skipped /
 *                     invalid / expired / private / needs_approval / etc.)
 *  - 'account_stop'  the ACCOUNT (not the link) hit a hard stop — Telegram's
 *                     own channel-limit, a dead session, or a FloodWait too
 *                     long to sleep through. The link has already been
 *                     freed (back to 'pending', unassigned) for another
 *                     account/run to pick up; the account's new state has
 *                     already been recorded.
 *  - 'abandoned'     a stop was requested mid-attempt. The link has been
 *                     reopened to 'pending' so a fresh run picks it straight
 *                     back up.
 */
const processLinkToCompletion = async (client, userId, account, linkRow, run, getSettings) => {
  const currentLink = linkRow;
  let attempt = 0;

  const abandon = () => {
    joinLinkQueries.updateStatus(currentLink.id, 'pending', {});
    joinAccountQueries.setCurrentLink(userId, account.id, null);
    return { outcome: 'abandoned' };
  };

  while (true) {
    if (run.stopping) return abandon();

    joinAccountQueries.setCurrentLink(userId, account.id, currentLink.id);
    joinLinkQueries.updateStatus(currentLink.id, 'in_progress', { assigned_account_id: account.id });
    joinAccountQueries.updateState(userId, account.id, 'working');

    const startedAt = Date.now();
    const result = await joinOneLink(client, userId, currentLink);
    const durationMs = Date.now() - startedAt;

    if (result.status === 'joined') {
      joinGroupQueries.register(userId, result.telegramId, result.title, account.id, currentLink.url, {
        linkType: currentLink.url_type || parseLink(currentLink.url).type,
        source: 'join',
      });
      joinLinkQueries.updateStatus(currentLink.id, 'joined', { telegram_id: result.telegramId });
      joinAccountQueries.registerJoin(userId, account.id);
      joinLogQueries.add(userId, account.id, currentLink.url, result.title, 'joined', null, { durationMs, linkStatus: 'joined' });
      joinAccountQueries.setCurrentLink(userId, account.id, null);
      return { outcome: 'done' };
    }

    if (result.status === 'skipped') {
      joinLinkQueries.updateStatus(currentLink.id, 'skipped', {
        telegram_id: result.telegramId || null,
        skip_reason: result.reason,
      });
      joinLogQueries.add(userId, account.id, currentLink.url, result.title || null, 'skipped', result.reason, { durationMs, linkStatus: 'skipped' });
      joinAccountQueries.setCurrentLink(userId, account.id, null);
      return { outcome: 'done' };
    }

    if (result.status === 'invalid') {
      joinLinkQueries.updateStatus(currentLink.id, 'invalid', { skip_reason: result.reason });
      joinLogQueries.add(userId, account.id, currentLink.url, null, 'invalid', result.reason, { durationMs, linkStatus: 'invalid' });
      joinAccountQueries.setCurrentLink(userId, account.id, null);
      return { outcome: 'done' };
    }

    // result.status === 'failed' from here on — branch on the classified kind.
    const info = result.errorInfo || { kind: 'transient', seconds: 0, message: result.reason || 'خطأ غير معروف' };

    if (info.kind === 'link_terminal') {
      joinLinkQueries.updateStatus(currentLink.id, info.linkStatus, { skip_reason: info.message });
      joinLogQueries.add(userId, account.id, currentLink.url, null, info.linkStatus, info.message, { durationMs, linkStatus: info.linkStatus });
      joinAccountQueries.setCurrentLink(userId, account.id, null);
      return { outcome: 'done' };
    }

    if (info.kind === 'account_limit') {
      // Telegram's own hard cap on this account — not this link's fault.
      joinLinkQueries.updateStatus(currentLink.id, 'pending', { assigned_account_id: null, next_retry_at: null });
      joinLogQueries.add(userId, account.id, currentLink.url, null, 'account_full', info.message, { durationMs });
      joinAccountQueries.updateState(userId, account.id, 'full', { ban_reason: info.message });
      joinAccountQueries.setCurrentLink(userId, account.id, null);
      return { outcome: 'account_stop' };
    }

    if (info.kind === 'account_dead') {
      joinLinkQueries.updateStatus(currentLink.id, 'pending', { assigned_account_id: null, next_retry_at: null });
      joinLogQueries.add(userId, account.id, currentLink.url, null, 'account_needs_login', info.message, { durationMs });
      joinAccountQueries.updateState(userId, account.id, 'needs_login', { ban_reason: info.message });
      joinAccountQueries.setCurrentLink(userId, account.id, null);
      return { outcome: 'account_stop' };
    }

    if (info.kind === 'flood_wait') {
      joinLinkQueries.updateStatus(currentLink.id, 'failed_flood', { skip_reason: info.message });
      joinLogQueries.add(userId, account.id, currentLink.url, null, 'floodwait_start', info.message, {
        durationMs, floodWaitSeconds: info.seconds, linkStatus: 'failed_flood',
      });

      if (info.seconds > FLOOD_WAIT_SLEEP_CAP_SECONDS) {
        joinAccountQueries.startFloodWait(userId, account.id, info.seconds, info.message);
        joinLinkQueries.updateStatus(currentLink.id, 'pending', { assigned_account_id: null, next_retry_at: null });
        joinAccountQueries.setCurrentLink(userId, account.id, null);
        return { outcome: 'account_stop' };
      }

      joinAccountQueries.startFloodWait(userId, account.id, info.seconds, info.message);
      const interrupted = await sleepInterruptible(info.seconds * 1000, run);
      if (interrupted) return abandon();

      joinAccountQueries.clearBan(userId, account.id);
      joinLogQueries.add(userId, account.id, null, null, 'floodwait_end', null);
      continue; // retry the SAME link now that the account has cooled down
    }

    // Generic transient error (timeout / unknown) — bounded retry with backoff.
    const settings = getSettings();
    attempt += 1;
    if (settings.retry_enabled && attempt <= settings.max_retries) {
      const backoffSeconds = settings.retry_delay_seconds * attempt;
      joinLinkQueries.updateStatus(currentLink.id, 'pending', {
        retry_count: attempt,
        next_retry_at: toSqliteUtc(new Date(Date.now() + backoffSeconds * 1000)),
      });
      joinLogQueries.add(
        userId, account.id, currentLink.url, null, 'retry_scheduled',
        `${info.message} — إعادة المحاولة خلال ${backoffSeconds}ث (محاولة ${attempt}/${settings.max_retries})`,
        { durationMs }
      );
      const interrupted = await sleepInterruptible(backoffSeconds * 1000, run);
      if (interrupted) return abandon();
      continue; // retry the SAME link, in place, in order
    }

    joinLinkQueries.updateStatus(currentLink.id, 'failed', { skip_reason: info.message });
    joinLogQueries.add(userId, account.id, currentLink.url, null, 'failed', info.message, { durationMs, linkStatus: 'failed' });
    joinAccountQueries.setCurrentLink(userId, account.id, null);
    return { outcome: 'done' };
  }
};

// ─── Per-account worker loop ───────────────────────────────────────────────────

/**
 * Owns one account for the lifetime of a run: opens one client connection
 * (reused for every attempt — never reopened per link), then repeatedly
 * pulls this account's own next due link, drives it to completion, and
 * paces itself with a fresh random delay before the next one. Every step
 * is awaited before the next begins, so two joins for this account can
 * never be in flight at once.
 *
 * Exits when: a stop is requested, the account's queue is empty right now,
 * or the account hits a hard stop (Telegram's own limit / dead session /
 * an unreasonably long FloodWait).
 */
const runAccountWorker = async (userId, account, run) => {
  joinAccountQueries.ensure(userId, account.id);
  run.workers.set(account.id, true);

  let client;
  try {
    client = await getClientForAccount(account);
  } catch (error) {
    joinAccountQueries.updateState(userId, account.id, 'needs_login', {
      ban_reason: 'تعذر تحميل الجلسة — يحتاج تسجيل دخول',
    });
    joinLogQueries.add(userId, account.id, null, null, 'account_needs_login', 'تعذر تحميل جلسة الحساب');
    run.workers.set(account.id, false);
    return;
  }

  const getSettings = () => joinSettingsQueries.get(userId);

  try {
    while (true) {
      if (run.stopping) break;

      const settings = getSettings();
      const { row: acc, limited } = joinAccountQueries.assessAccount(userId, account.id);
      if (!acc) break;

      if (limited) {
        if (limited.type === 'total' || limited.type === 'session') {
          joinAccountQueries.updateState(userId, account.id, 'full', { ban_reason: limited.message });
          joinLogQueries.add(
            userId, account.id, null, null,
            limited.type === 'total' ? 'account_full' : 'limit_session_reached',
            limited.message
          );
          break;
        }
        // hour / day: purely time-based — wait it out in place, then re-assess.
        joinAccountQueries.updateState(userId, account.id, 'resting', { ban_reason: limited.message });
        joinLogQueries.add(
          userId, account.id, null, null,
          limited.type === 'hour' ? 'limit_hour_reached' : 'limit_day_reached',
          limited.message
        );
        const waitMs = Math.max(1000, fromSqliteUtc(limited.resumeAt).getTime() - Date.now());
        if (await sleepInterruptible(waitMs, run)) break;
        joinAccountQueries.updateState(userId, account.id, 'idle', { ban_reason: null });
        continue;
      }

      if (acc.batch_progress >= acc.batch_size) {
        joinAccountQueries.updateState(userId, account.id, 'resting');
        const restSeconds = randomInt(settings.rest_min_seconds, settings.rest_max_seconds);
        joinLogQueries.add(userId, account.id, null, null, 'rest_start', `استراحة عشوائية: ${restSeconds} ثانية`);
        const interrupted = await sleepInterruptible(restSeconds * 1000, run);
        joinAccountQueries.resetBatchProgress(userId, account.id);
        if (interrupted) break;
        joinLogQueries.add(userId, account.id, null, null, 'rest_end', null);
        continue;
      }

      const linkRow = joinLinkQueries.getNextForAccount(userId, account.id, !!settings.auto_distribute);
      if (!linkRow) break; // nothing due for this account right now

      const outcome = await processLinkToCompletion(client, userId, account, linkRow, run, getSettings);

      if (outcome.outcome === 'abandoned' || outcome.outcome === 'account_stop') break;

      // 'done' — pace the next attempt with a fresh random delay, randomized
      // independently every time (and independently per account) so nothing
      // ever moves in lockstep or on a fixed cadence.
      const freshSettings = getSettings();
      const delaySeconds = randomInt(freshSettings.join_delay_min_seconds, freshSettings.join_delay_max_seconds);
      if (await sleepInterruptible(delaySeconds * 1000, run)) break;
    }
  } finally {
    try { await client.disconnect(); } catch (_) { /* already gone */ }
    run.workers.set(account.id, false);
    const finalState = joinAccountQueries.get(userId, account.id);
    if (finalState && !['banned', 'needs_login', 'full'].includes(finalState.state)) {
      joinAccountQueries.updateState(userId, account.id, 'idle');
    }
  }
};

// ─── Run orchestration ─────────────────────────────────────────────────────────

/**
 * Start the join process for a user across the given accounts. Pending
 * links are round-robin distributed across them up front (one independent
 * queue per account) when auto-distribution is on; otherwise accounts pull
 * from a shared unassigned pool on demand — either way no two accounts can
 * ever end up processing the same link.
 *
 * @param {string} userId
 * @param {number[]} accountIds  account IDs to use (must be pre-filtered to enabled/connected)
 */
const startJoinRun = async (userId, accountIds) => {
  const uid = String(userId);
  if (isRunning(uid)) return { started: false, reason: 'already_running' };

  const settings = joinSettingsQueries.get(uid);
  if (!settings.queue_enabled) return { started: false, reason: 'queue_disabled' };

  const pendingCount = joinLinkQueries.countByStatus(uid).pending;
  if (!pendingCount) return { started: false, reason: 'no_pending_links' };

  const accounts = accountIds
    .map((id) => accountQueries.getById(id))
    .filter((a) => a && a.status === 'connected');

  if (!accounts.length) return { started: false, reason: 'no_available_accounts' };

  const accountIdList = accounts.map((a) => a.id);

  for (const acc of accounts) {
    joinAccountQueries.ensure(uid, acc.id);
    joinAccountQueries.updateState(uid, acc.id, 'idle', {
      max_joins: settings.max_joins_per_account,
      batch_size: settings.batch_size,
      max_joins_per_hour: settings.max_joins_per_hour,
      max_joins_per_day: settings.max_joins_per_day,
      max_joins_per_session: settings.max_joins_per_session,
    });
    joinAccountQueries.resetSessionCounters(uid, acc.id);
  }

  // Links left assigned to accounts no longer in this run (e.g. disabled
  // between runs) go back into the unassigned pool before we distribute.
  joinLinkQueries.reclaimOrphaned(uid, accountIdList);

  if (settings.auto_distribute) {
    joinLinkQueries.distributeUnassigned(uid, accountIdList);
  }

  const run = { running: true, stopping: false, accountIds: accountIdList, workers: new Map() };
  activeRuns.set(uid, run);

  const workerPromises = accounts.map((acc) => runAccountWorker(uid, acc, run));

  // Fire and forget — the caller polls status via joinLinkQueries/joinAccountQueries.
  Promise.allSettled(workerPromises).finally(() => {
    run.running = false;
    activeRuns.set(uid, run);
    logger.info(`Join run finished for user ${uid}`);
  });

  return { started: true, accountsUsed: accounts.length, queued: pendingCount };
};

const stopJoinRun = (userId) => {
  requestStop(userId);
  return { stopping: true };
};

/**
 * Called after new links are queued while a run is already active:
 * distributes the newly-added links across the run's accounts and wakes
 * any account whose worker had already exited because its queue was empty
 * (workers don't poll indefinitely — see runAccountWorker's doc comment).
 */
const notifyLinksAdded = (userId) => {
  const uid = String(userId);
  const run = activeRuns.get(uid);
  if (!run || !run.running || run.stopping) return;

  const settings = joinSettingsQueries.get(uid);
  if (settings.auto_distribute) {
    joinLinkQueries.distributeUnassigned(uid, run.accountIds);
  }

  for (const accountId of run.accountIds) {
    if (run.workers.get(accountId)) continue; // already alive, will notice new work itself

    const hasOwnWork = joinLinkQueries.getDueForAccount(uid, accountId, 1).length > 0;
    const hasSharedWork = !settings.auto_distribute && joinLinkQueries.getUnassignedPendingCount(uid) > 0;
    if (!hasOwnWork && !hasSharedWork) continue;

    const account = accountQueries.getById(accountId);
    if (account && account.status === 'connected') {
      run.workers.set(accountId, true);
      runAccountWorker(uid, account, run);
    }
  }
};

module.exports = {
  parseLink,
  extractLinksFromText,
  classifyJoinError,
  startJoinRun,
  stopJoinRun,
  notifyLinksAdded,
  isRunning,
};
