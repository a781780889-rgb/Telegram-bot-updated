/**
 * joinMessages.js — Enhanced Arabic message templates for the Join section.
 *
 * All message builders receive live data so the UI always reflects the
 * real system state.  Static strings are exported as constants;
 * dynamic ones are exported as functions.
 */

const { stateLabel } = require('./joinKeyboards');
const { fromSqliteUtc } = require('../database/joinDb');

// ─── Shared formatting helpers ─────────────────────────────────────────────────

const DIVIDER  = '─'.repeat(28);
const DIVIDER_SM = '─'.repeat(18);

/** SQLite UTC → human readable "YYYY-MM-DD HH:MM" */
const formatWhen = (sqliteTimestamp) => {
  const d = fromSqliteUtc(sqliteTimestamp);
  if (!d) return '—';
  return d.toISOString().slice(0, 16).replace('T', ' ');
};

/** Remaining seconds → human-friendly "Xد Yث" or "Xس Yد" */
const formatRemaining = (endSqlite) => {
  if (!endSqlite) return null;
  const remaining = Math.max(0, fromSqliteUtc(endSqlite).getTime() - Date.now());
  if (remaining <= 0) return null;
  const totalSec = Math.round(remaining / 1000);
  if (totalSec < 60)   return `${totalSec} ث`;
  if (totalSec < 3600) return `${Math.floor(totalSec / 60)} د ${totalSec % 60} ث`;
  return `${Math.floor(totalSec / 3600)} س ${Math.floor((totalSec % 3600) / 60)} د`;
};

/** 0 / undefined → "بدون حد", otherwise the number */
const limitStr = (n) => (n ? String(n) : 'بدون حد');

// ─── Main Menu (Dynamic) ──────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {boolean} opts.running
 * @param {object}  opts.linkStats      result of joinLinkQueries.countByStatus()
 * @param {object}  opts.accountCounts  { working, stopped, banned, full }
 * @param {number}  opts.groupsCount
 */
const joinMenuMessage = ({ running = false, linkStats = {}, accountCounts = {}, groupsCount = 0 } = {}) => {
  const status = running ? '🟢 *يعمل الآن*' : '⚪️ *متوقف*';

  const pending    = linkStats.pending     || 0;
  const inProg     = linkStats.in_progress || 0;
  const joined     = linkStats.joined      || 0;
  const failed     = linkStats.failed      || 0;
  const approval   = linkStats.needs_approval || 0;
  const floodLinks = linkStats.failed_flood   || 0;

  const working    = accountCounts.working  || 0;
  const stopped    = accountCounts.stopped  || 0;
  const banned     = accountCounts.banned   || 0;
  const full       = accountCounts.full     || 0;

  const lines = [
    `🔗 *قسم إدارة الانضمام للروابط*`,
    DIVIDER,
    ``,
    `الحالة: ${status}`,
    ``,
    `📊 *ملخص الروابط*`,
    `⏳ في الانتظار: ${pending}  |  ⚡ قيد التنفيذ: ${inProg}`,
    `✅ تم الانضمام: ${joined}  |  ❌ فشل: ${failed}`,
    ...(approval   ? [`🕓 بانتظار الموافقة: ${approval}`] : []),
    ...(floodLinks ? [`🌊 متوقفة FloodWait: ${floodLinks}`] : []),
    ``,
    `👤 *الحسابات*`,
    `🟢 عاملة: ${working}  |  ⏸ متوقفة: ${stopped}  |  🔴 مقيّدة: ${banned + full}`,
    ``,
    `🗂 إجمالي المجموعات المسجلة: ${groupsCount}`,
    ``,
    `اختر من القائمة أدناه:`,
  ];
  return lines.join('\n');
};

// ─── Accounts ─────────────────────────────────────────────────────────────────

const joinNoAccountsMessage =
  `⚠️ *لا توجد حسابات متصلة*\n\n` +
  `يجب إضافة حساب تيليجرام متصل أولًا من قسم «📂 الحسابات».`;

const joinAccountsListMessage =
  `👤 *إدارة حسابات الانضمام*\n` +
  `${DIVIDER}\n\n` +
  `اضغط على أي حساب لعرض تفاصيله والتحكم به.\n\n` +
  `الرموز: 🟢 جاهز  ⚡ يعمل  🟡 استراحة  🔴 FloodWait  🟠 وصل الحد  ⏸ متوقف`;

const joinAccountDetailMessage = (acc) => {
  const name = [acc.first_name, acc.last_name].filter(Boolean).join(' ') || acc.phone;
  const remaining = formatRemaining(acc.cooldown_until);

  const lines = [
    `👤 *${name}*`,
    DIVIDER_SM,
    ``,
    `الحالة: ${stateLabel(acc)}`,
    `الجلسة: ${acc.account_status === 'connected' ? '🔗 متصل' : '⚠️ غير متصل'}`,
    ``,
    `📊 *إحصائيات الانضمام*`,
    `• الكلي: ${acc.joined_count} ${acc.max_joins ? `/ ${acc.max_joins}` : ''}`,
    `• هذه الساعة: ${acc.joined_hour_count || 0}${acc.max_joins_per_hour ? ` / ${acc.max_joins_per_hour}` : ''}`,
    `• اليوم: ${acc.joined_day_count || 0}${acc.max_joins_per_day ? ` / ${acc.max_joins_per_day}` : ''}`,
    `• هذه الجلسة: ${acc.joined_session_count || 0}${acc.max_joins_per_session ? ` / ${acc.max_joins_per_session}` : ''}`,
    `• تقدم الدُّفعة: ${acc.batch_progress || 0} / ${acc.batch_size || '—'}`,
    ...(acc.last_joined_at ? [`• آخر انضمام: ${formatWhen(acc.last_joined_at)}`] : []),
    ``,
    ...(acc.ban_reason ? [
      `⚠️ *سبب التوقف*`,
      acc.ban_reason,
      ...(remaining ? [`⏳ يُستأنف خلال: ${remaining}`] : acc.cooldown_until ? [`⏳ حتى: ${formatWhen(acc.cooldown_until)}`] : []),
      ``,
    ] : []),
  ];
  return lines.join('\n');
};

// ─── Links Overview ───────────────────────────────────────────────────────────

const joinLinksOverviewMessage = (stats) => {
  const total =
    (stats.pending || 0) + (stats.in_progress || 0) + (stats.joined || 0) +
    (stats.skipped || 0) + (stats.failed || 0)  + (stats.invalid || 0)  +
    (stats.needs_approval || 0) + (stats.failed_flood || 0) + (stats.expired || 0) +
    (stats.private || 0) + (stats.failed_privacy || 0);

  return [
    `📋 *عرض الروابط*`,
    DIVIDER,
    ``,
    `إجمالي الروابط في النظام: ${total}`,
    ``,
    `🆕 في الانتظار: ${stats.pending || 0}`,
    `⚡ قيد التنفيذ: ${stats.in_progress || 0}`,
    `✅ تم الانضمام: ${stats.joined || 0}`,
    `⏭ تم التخطي (مكرر): ${stats.skipped || 0}`,
    `🌊 FloodWait: ${stats.failed_flood || 0}`,
    `🕓 بانتظار الموافقة: ${stats.needs_approval || 0}`,
    `🚫 غير صالح: ${stats.invalid || 0}`,
    `⌛ منتهي الصلاحية: ${stats.expired || 0}`,
    `🔒 خاص / غير متاح: ${stats.private || 0}`,
    `🔐 فشل خصوصية: ${stats.failed_privacy || 0}`,
    `❌ فشل نهائي: ${stats.failed || 0}`,
    ``,
    `اختر الفلتر للاطلاع على تفاصيل كل حالة:`,
  ].join('\n');
};

/** Show a compact list of links for one status filter. */
const joinLinksFilterMessage = (statusKey, links) => {
  const LABELS = {
    pending:        '⏳ في الانتظار',
    joined:         '✅ تم الانضمام',
    skipped:        '⏭ تم التخطي (مكرر)',
    failed:         '❌ فشل نهائي',
    invalid:        '🚫 غير صالح',
    needs_approval: '🕓 بانتظار الموافقة',
  };
  const label = LABELS[statusKey] || statusKey;

  if (!links.length) {
    return `${label}\n\n✅ لا توجد روابط بهذه الحالة.`;
  }

  const lines = [`${label} (${links.length} رابط)`, DIVIDER, ''];
  for (const l of links.slice(0, 15)) {
    lines.push(`• ${l.url}`);
    if (l.skip_reason) lines.push(`  ↳ ${l.skip_reason}`);
  }
  if (links.length > 15) lines.push(`\n... و${links.length - 15} رابطًا آخر`);
  return lines.join('\n');
};

// ─── Add Links ────────────────────────────────────────────────────────────────

const joinAddLinksPromptMessage =
  `🔗 *إضافة روابط للانضمام*\n` +
  `${DIVIDER}\n\n` +
  `يمكنك إضافة الروابط بطريقتين:\n\n` +
  `1️⃣ أرسل الروابط مباشرةً كنص (رابط في كل سطر).\n` +
  `2️⃣ أرسل ملف نصي \`.txt\` يحتوي على الروابط.\n\n` +
  `✅ *الصيغ المدعومة:*\n` +
  `• عام: \`t.me/username\` أو \`@username\`\n` +
  `• دعوة خاصة: \`t.me/joinchat/xxxx\` أو \`t.me/+xxxx\`\n\n` +
  `⚠️ الروابط المكررة تُتجاهل تلقائيًا.\n` +
  `⚠️ الحد الأقصى لحجم الملف: 2 ميجابايت.`;

const joinAddLinksResultMessage = (addedCount, invalidCount, duplicateQueuedCount) => {
  const lines = [
    `✅ *نتيجة إضافة الروابط*`,
    DIVIDER_SM,
    ``,
    `🆕 تمت الإضافة إلى قائمة الانتظار: *${addedCount}*`,
  ];
  if (invalidCount)         lines.push(`🚫 روابط غير صالحة (تجاهلها): ${invalidCount}`);
  if (duplicateQueuedCount) lines.push(`⏭ مكررة (موجودة مسبقًا): ${duplicateQueuedCount}`);
  if (!addedCount && !invalidCount && !duplicateQueuedCount) {
    lines.push(`⚠️ لم يتم التعرف على أي روابط في المدخل.`);
  }
  return lines.join('\n');
};

const joinFileWrongTypeMessage =
  `⚠️ *نوع الملف غير مدعوم*\n\n` +
  `يجب أن يكون الملف نصيًا بصيغة \`.txt\` فقط.`;

const joinFileTooLargeMessage =
  `⚠️ *حجم الملف كبير جدًا*\n\n` +
  `الحد الأقصى المسموح به هو 2 ميجابايت.`;

const joinFileEmptyMessage =
  `⚠️ *الملف لا يحتوي على أي روابط صالحة.*\n\n` +
  `تأكد من أن كل سطر يحتوي على رابط صحيح.`;

const joinFileReadErrorMessage =
  `⚠️ *تعذر قراءة الملف.*\n\nتأكد من أنه ملف نصي سليم وحاول مرة أخرى.`;

// ─── Start / Stop ─────────────────────────────────────────────────────────────

const joinStartConfirmMessage = (pendingCount, accountsCount, settings) => {
  const delayMin = settings?.join_delay_min_seconds ?? '—';
  const delayMax = settings?.join_delay_max_seconds ?? '—';
  const batch    = settings?.batch_size ?? '—';
  const restMin  = settings?.rest_min_seconds ?? '—';
  const restMax  = settings?.rest_max_seconds ?? '—';

  return [
    `▶️ *تأكيد بدء عملية الانضمام*`,
    DIVIDER,
    ``,
    `📊 *ملخص العملية*`,
    `• الروابط في الانتظار: ${pendingCount}`,
    `• الحسابات المتاحة: ${accountsCount}`,
    ``,
    `⚙️ *الإعدادات المطبّقة*`,
    `• الفاصل بين العمليات: ${delayMin}–${delayMax} ث (عشوائي)`,
    `• استراحة بعد كل: ${batch} رابط`,
    `• مدة الاستراحة: ${restMin}–${restMax} ث (عشوائية)`,
    ``,
    `🔒 *ضمانات الأمان*`,
    `• لن ينضم أي حساب إلى مجموعة مرتين`,
    `• حساب واحد = عملية واحدة في نفس الوقت`,
    `• FloodWait يوقف الحساب فورًا ويُحترم`,
    ``,
    `هل تريد المتابعة؟`,
  ].join('\n');
};

const joinNoPendingLinksMessage =
  `⚠️ *لا توجد روابط في قائمة الانتظار*\n\n` +
  `أضف روابط أولًا من «🔗 إضافة روابط».`;

const joinNoAvailableAccountsMessage =
  `⚠️ *لا توجد حسابات متاحة للانضمام*\n\n` +
  `تأكد من وجود حساب:\n` +
  `• متصل (connected)\n` +
  `• مفعّل في قسم «👤 إدارة الحسابات»\n` +
  `• لم يصل للحد الأقصى ولم يُحظر`;

const joinAlreadyRunningMessage =
  `⚠️ *عملية الانضمام تعمل بالفعل*\n\n` +
  `يمكنك مراقبة التقدم من الإحصائيات،\nأو إيقافها أولًا قبل بدء عملية جديدة.`;

const joinQueueDisabledMessage =
  `⚠️ *نظام الانضمام معطّل حاليًا*\n\n` +
  `فعّله من:\n«⚙️ الإعدادات ← 🛡 الحماية والتوزيع ← تفعيل نظام الانضمام»`;

const joinStartedMessage = (accountsUsed, queued) =>
  `✅ *تم بدء عملية الانضمام*\n` +
  `${DIVIDER}\n\n` +
  `⚡ الحسابات العاملة: ${accountsUsed}\n` +
  `⏳ الروابط في قائمة الانتظار: ${queued}\n\n` +
  `يمكنك مراقبة التقدم من «📊 الإحصائيات»\nأو إيقاف العملية في أي وقت.`;

const joinStoppedMessage =
  `⏹ *تم إرسال أمر الإيقاف*\n\n` +
  `سيتوقف النظام عن بدء مهام جديدة خلال لحظات.\n\n` +
  `✅ جميع المهام محفوظة في قاعدة البيانات.\n` +
  `✅ أي رابط قيد التنفيذ يعود لقائمة الانتظار.\n` +
  `✅ يمكنك استئناف العملية في أي وقت.`;

// ─── Statistics / Dashboard ───────────────────────────────────────────────────

const joinStatisticsMessage = (linkStats, groupsCount, running, accountCounts, perf, joinAccounts = []) => {
  const status = running ? '🟢 يعمل الآن' : '⚪️ متوقف';

  // Build per-account mini-table
  const accLines = [];
  for (const acc of joinAccounts.slice(0, 8)) {
    const name = [acc.first_name, acc.last_name].filter(Boolean).join(' ') || acc.phone;
    const remaining = formatRemaining(acc.cooldown_until);
    const extra = remaining ? ` ⏳${remaining}` : '';
    accLines.push(`• ${name.slice(0, 18)} — ${stateLabel(acc)}${extra}`);
    accLines.push(`  ↳ ${acc.joined_count} انضمام | ساعة: ${acc.joined_hour_count || 0} | يوم: ${acc.joined_day_count || 0}`);
  }

  const lines = [
    `📊 *لوحة مراقبة الانضمام*`,
    DIVIDER,
    ``,
    `الحالة العامة: ${status}`,
    ``,
    `${DIVIDER_SM}`,
    `📌 *الروابط*`,
    `⏳ في الانتظار:     ${linkStats.pending      || 0}`,
    `⚡ قيد التنفيذ:     ${linkStats.in_progress  || 0}`,
    `✅ تم الانضمام:     ${linkStats.joined        || 0}`,
    `⏭ تم التخطي:       ${linkStats.skipped       || 0}`,
    `🌊 FloodWait:       ${linkStats.failed_flood  || 0}`,
    `🕓 انتظار موافقة:   ${linkStats.needs_approval || 0}`,
    `🚫 غير صالح:        ${linkStats.invalid       || 0}`,
    `⌛ منتهي الصلاحية: ${linkStats.expired       || 0}`,
    `🔒 خاص/غير متاح:   ${linkStats.private       || 0}`,
    `🔐 فشل خصوصية:     ${linkStats.failed_privacy || 0}`,
    `❌ فشل نهائي:       ${linkStats.failed        || 0}`,
    ``,
    `${DIVIDER_SM}`,
    `👤 *الحسابات*`,
    `🟢 عاملة: ${accountCounts.working}  |  ⏸ متوقفة: ${accountCounts.stopped}`,
    `🔴 مقيّدة: ${accountCounts.banned}  |  🟠 وصلت الحد: ${accountCounts.full}`,
    ...(accLines.length ? [``, ...accLines] : []),
    ``,
    `${DIVIDER_SM}`,
    `📈 *الأداء*`,
    `• عمليات الانضمام اليوم: ${perf.todayJoins}`,
    `• معدل النجاح: ${perf.successRate}%`,
    `• معدل الفشل: ${perf.failureRate}%`,
    `• متوسط وقت الانضمام: ${perf.avgDurationSeconds} ث`,
    ``,
    `🗂 إجمالي المجموعات المسجلة (بلا تكرار): ${groupsCount}`,
  ];
  return lines.join('\n');
};

// ─── Needs-approval review ─────────────────────────────────────────────────────

const joinNoNeedsApprovalMessage = `✅ *لا توجد طلبات بانتظار الموافقة حاليًا.*`;

const joinNeedsApprovalMessage = (links) => {
  const lines = [
    `🕓 *طلبات بانتظار موافقة المشرف*`,
    DIVIDER,
    ``,
    `هذه المجموعات تحتاج موافقة المشرف للانضمام.`,
    `راجع كل رابط يدويًا ثم حدد النتيجة:`,
    ``,
  ];
  for (const l of links.slice(0, 8)) {
    lines.push(`📌 *#${l.id}*`);
    lines.push(`🔗 ${l.url}`);
    if (l.assigned_account_id) lines.push(`👤 الحساب: ${l.assigned_account_id}`);
    lines.push('');
  }
  return lines.join('\n').trim();
};

const joinApprovalDecidedMessage = (accepted) =>
  accepted
    ? `✅ تم تعليم الطلب كمقبول (تم الانضمام).`
    : `❌ تم تعليم الطلب كمرفوض.`;

// ─── Cleanup ──────────────────────────────────────────────────────────────────

const joinCleanupConfirmMessage = (count) =>
  `🧹 *تنظيف الروابط الفاشلة*\n` +
  `${DIVIDER}\n\n` +
  `سيتم أرشفة *${count} رابط* بالحالات التالية:\n` +
  `• 🚫 غير صالح  • ⌛ منتهي الصلاحية  • 🔒 خاص\n` +
  `• ❌ مرفوض  • 🔐 فشل خصوصية  • ❌ فشل نهائي\n\n` +
  `لن تُحذف السجلات الخاصة بها من سجل العمليات.\n\n` +
  `هل تريد المتابعة؟`;

const joinCleanupNothingToDoMessage = `✅ *لا توجد روابط فاشلة يمكن تنظيفها حاليًا.*`;

const joinCleanupDoneMessage = (count) =>
  `🧹 تم أرشفة *${count} رابط* بنجاح.\n\n` +
  `يمكنك إضافة روابط جديدة في أي وقت.`;

// ─── Banned / Restricted Accounts ─────────────────────────────────────────────

const joinNoBannedAccountsMessage = `✅ *لا توجد حسابات مقيّدة أو بحاجة لتسجيل دخول حاليًا.*`;

const joinBannedAccountsMessage = (accounts) => {
  const lines = [`🚫 *الحسابات المقيّدة*`, DIVIDER, ''];
  for (const acc of accounts) {
    const name = [acc.first_name, acc.last_name].filter(Boolean).join(' ') || acc.phone;
    const remaining = formatRemaining(acc.cooldown_until);
    lines.push(`👤 *${name}*`);
    lines.push(`   الحالة: ${stateLabel(acc)}`);
    if (acc.ban_reason) lines.push(`   السبب: ${acc.ban_reason}`);
    if (remaining)         lines.push(`   ⏳ متبقي: ${remaining}`);
    else if (acc.cooldown_until) lines.push(`   ⏳ حتى: ${formatWhen(acc.cooldown_until)}`);
    lines.push('');
  }
  lines.push(`💡 ستُستأنف الحسابات تلقائيًا بعد انتهاء مدة FloodWait.`);
  return lines.join('\n').trim();
};

// ─── Logs ─────────────────────────────────────────────────────────────────────

const RESULT_LABELS = {
  joined:              '✅ تم الانضمام',
  skipped:             '⏭ تخطي (مكرر)',
  invalid:             '🚫 رابط غير صالح',
  expired:             '⌛ منتهي الصلاحية',
  private:             '🔒 خاص / غير متاح',
  needs_approval:      '🕓 بانتظار الموافقة',
  rejected:            '❌ مرفوض',
  failed_privacy:      '🔐 فشل خصوصية',
  failed:              '❌ فشل',
  account_full:        '🟠 الحساب وصل للحد',
  account_needs_login: '⚪️ يحتاج تسجيل دخول',
  rest_start:          '🛑 بداية استراحة',
  rest_end:            '▶️ نهاية استراحة',
  floodwait_start:     '🌊 بداية FloodWait',
  floodwait_end:       '✅ انتهاء FloodWait',
  retry_scheduled:     '🔁 مجدولة لإعادة المحاولة',
  limit_hour_reached:  '🕐 وصل الحد الساعي',
  limit_day_reached:   '📅 وصل الحد اليومي',
  limit_session_reached: '📌 وصل حد الجلسة',
};

const joinNoLogsMessage = `📜 *لا يوجد سجل عمليات بعد.*`;

const joinLogsMessage = (logs, page = 0) => {
  const LOGS_PER_PAGE = 20;
  const pageLogs = logs.slice(page * LOGS_PER_PAGE, (page + 1) * LOGS_PER_PAGE);

  const lines = [
    `📜 *سجل عمليات الانضمام*`,
    DIVIDER,
    `الأحدث أولًا${page > 0 ? ` | صفحة ${page + 1}` : ''}`,
    '',
  ];

  for (const log of pageLogs) {
    const label    = RESULT_LABELS[log.result] || log.result;
    const phone    = log.phone ? ` (${log.phone.slice(-4)})` : '';
    const duration = log.duration_ms != null ? ` ${(log.duration_ms / 1000).toFixed(1)}ث` : '';
    const when     = log.created_at ? formatWhen(log.created_at) : '';

    lines.push(`${label}${phone}${duration ? ' —' + duration : ''}`);
    if (when)           lines.push(`  🕐 ${when}`);
    if (log.group_title) lines.push(`  📌 ${log.group_title}`);
    if (log.link)        lines.push(`  🔗 ${log.link}`);
    if (log.detail)      lines.push(`  ℹ️ ${log.detail}`);
    if (log.flood_wait_seconds) lines.push(`  ⏳ FloodWait: ${log.flood_wait_seconds} ث`);
    lines.push('');
  }

  return lines.join('\n').trim();
};

const joinLogsClearConfirmMessage =
  `⚠️ *مسح سجل العمليات*\n\n` +
  `سيتم حذف جميع سجلات العمليات نهائيًا.\n` +
  `هذا لا يؤثر على الروابط أو إحصائيات الانضمام.\n\n` +
  `هل أنت متأكد؟`;

const joinLogsClearedMessage = `✅ تم مسح سجل العمليات.`;

// ─── Settings Hub ─────────────────────────────────────────────────────────────

const joinSettingsHubMessage =
  `⚙️ *إعدادات الانضمام*\n` +
  `${DIVIDER}\n\n` +
  `اختر القسم الذي تريد تعديله.\n\n` +
  `💡 جميع الإعدادات تُطبَّق فورًا على الجلسات الجديدة.`;

const joinSettingsTimingMessage = (s) => [
  `⏱ *التوقيت بين العمليات*`,
  DIVIDER_SM,
  ``,
  `الفاصل الزمني الحالي:`,
  `• الحد الأدنى: ${s.join_delay_min_seconds} ث`,
  `• الحد الأقصى: ${s.join_delay_max_seconds} ث`,
  `• النمط: عشوائي مختلف لكل حساب في كل مرة`,
  ``,
  `💡 كلما زاد الفاصل كلما قلّ خطر التقييد.`,
  `💡 نوصي بـ 30–90 ث كحد أدنى.`,
  ``,
  `اختر ما تريد تعديله:`,
].join('\n');

const joinSettingsBreaksMessage = (s) => [
  `🛑 *الاستراحات والدُّفعات*`,
  DIVIDER_SM,
  ``,
  `• عدد الروابط قبل الاستراحة (batch): ${s.batch_size}`,
  `• مدة الاستراحة الأدنى: ${s.rest_min_seconds} ث`,
  `• مدة الاستراحة الأقصى: ${s.rest_max_seconds} ث`,
  ``,
  `💡 الاستراحات تُقلّل الضغط على الحسابات وتمنع الحظر.`,
  ``,
  `اختر ما تريد تعديله:`,
].join('\n');

const joinSettingsLimitsMessage = (s) => [
  `📈 *حدود الانضمام*`,
  DIVIDER_SM,
  ``,
  `• الحد الأقصى الكلي / حساب: ${limitStr(s.max_joins_per_account)}`,
  `• الحد الأقصى / ساعة: ${limitStr(s.max_joins_per_hour)}`,
  `• الحد الأقصى / يوم: ${limitStr(s.max_joins_per_day)}`,
  `• الحد الأقصى / جلسة: ${limitStr(s.max_joins_per_session)}`,
  ``,
  `💡 أرسل 0 لإلغاء الحد الزمني.`,
  `⚠️ Telegram يسمح عادةً بـ 20–50 مجموعة / يوم.`,
  ``,
  `اختر ما تريد تعديله:`,
].join('\n');

const joinSettingsRetryMessage = (s) => [
  `🔁 *إعادة المحاولة*`,
  DIVIDER_SM,
  ``,
  `• الحالة: ${s.retry_enabled ? '✅ مفعّلة' : '❌ معطّلة'}`,
  `• الحد الأقصى للمحاولات: ${s.max_retries}`,
  `• الفاصل قبل المحاولة الأولى: ${s.retry_delay_seconds} ث`,
  `• النمط: Backoff تدريجي (يتضاعف مع كل محاولة)`,
  ``,
  `✅ تُعاد المحاولة فقط للأخطاء المؤقتة (مهلة زمنية…).`,
  `❌ لا تُعاد المحاولة: FloodWait، حظر، رابط غير صالح.`,
].join('\n');

const joinSettingsProtectionMessage = (s) => [
  `🛡 *الحماية والتوزيع*`,
  DIVIDER_SM,
  ``,
  `• الحماية من FloodWait: ${s.smart_protection_enabled ? '✅ مفعّلة' : '❌ معطّلة'}`,
  `  ↳ إيقاف الحساب فورًا + احترام مدة الانتظار`,
  ``,
  `• التوزيع التلقائي للروابط: ${s.auto_distribute ? '✅ مفعّل' : '❌ معطّل'}`,
  `  ↳ توزيع الروابط بالتساوي بين الحسابات عند البدء`,
  ``,
  `• تفعيل نظام الانضمام: ${s.queue_enabled ? '✅ مفعّل' : '❌ معطّل'}`,
  `  ↳ عند التعطيل لا يمكن بدء عملية انضمام`,
  ``,
  `🔒 *ثابت دائمًا (لا يمكن تعطيله):*`,
  `• حساب واحد = عملية انضمام واحدة فقط في نفس الوقت`,
  `• لا يُسمح بتكرار الانضمام لنفس المجموعة`,
].join('\n');

/** Full settings overview — shown on "ملخص الإعدادات الحالية" */
const joinSettingsSummaryMessage = (s) => [
  `📋 *ملخص الإعدادات الحالية*`,
  DIVIDER,
  ``,
  `⏱ *التوقيت*`,
  `• الفاصل بين العمليات: ${s.join_delay_min_seconds}–${s.join_delay_max_seconds} ث`,
  ``,
  `🛑 *الاستراحات*`,
  `• Batch size: ${s.batch_size} رابط`,
  `• مدة الاستراحة: ${s.rest_min_seconds}–${s.rest_max_seconds} ث`,
  ``,
  `📈 *الحدود*`,
  `• كلي / حساب: ${limitStr(s.max_joins_per_account)}`,
  `• / ساعة: ${limitStr(s.max_joins_per_hour)}`,
  `• / يوم: ${limitStr(s.max_joins_per_day)}`,
  `• / جلسة: ${limitStr(s.max_joins_per_session)}`,
  ``,
  `🔁 *إعادة المحاولة*`,
  `• الحالة: ${s.retry_enabled ? '✅' : '❌'}  |  المحاولات: ${s.max_retries}  |  الفاصل: ${s.retry_delay_seconds} ث`,
  ``,
  `🛡 *الحماية*`,
  `• FloodWait: ${s.smart_protection_enabled ? '✅' : '❌'}`,
  `• توزيع تلقائي: ${s.auto_distribute ? '✅' : '❌'}`,
  `• النظام مفعّل: ${s.queue_enabled ? '✅' : '❌'}`,
].join('\n');

// ─── Settings edit prompts ─────────────────────────────────────────────────────

const joinEditPromptMessages = {
  batch_size:         '✏️ أرسل عدد الروابط قبل أخذ استراحة:\n_(رقم صحيح > 0، مثال: `10`)_',
  join_delay_range:   '✏️ أرسل الحد الأدنى والأقصى للفاصل الزمني بالثواني:\n_(مفصولين بشرطة، مثال: `30-90`)_',
  rest_range:         '✏️ أرسل الحد الأدنى والأقصى لمدة الاستراحة بالثواني:\n_(مفصولين بشرطة، مثال: `300-900`)_',
  max_joins:          '✏️ أرسل الحد الأقصى الكلي للمجموعات لكل حساب:\n_(مثال: `50`)_',
  max_joins_hour:     '✏️ أرسل الحد الأقصى للانضمام بالساعة لكل حساب:\n_(`0` لإلغاء الحد)_',
  max_joins_day:      '✏️ أرسل الحد الأقصى للانضمام باليوم لكل حساب:\n_(`0` لإلغاء الحد)_',
  max_joins_session:  '✏️ أرسل الحد الأقصى للانضمام في الجلسة الواحدة:\n_(`0` لإلغاء الحد)_',
  max_retries:        '✏️ أرسل الحد الأقصى لعدد محاولات إعادة المحاولة:\n_(مثال: `2`، `0` لتعطيل Retry)_',
  retry_delay:        '✏️ أرسل عدد الثواني قبل إعادة المحاولة الأولى:\n_(مثال: `90`)_',
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // helpers (re-exported so callers don't need a second import)
  formatWhen,
  // main menu
  joinMenuMessage,
  // accounts
  joinNoAccountsMessage,
  joinAccountsListMessage,
  joinAccountDetailMessage,
  // links overview
  joinLinksOverviewMessage,
  joinLinksFilterMessage,
  // add links
  joinAddLinksPromptMessage,
  joinAddLinksResultMessage,
  joinFileWrongTypeMessage,
  joinFileTooLargeMessage,
  joinFileEmptyMessage,
  joinFileReadErrorMessage,
  // start / stop
  joinStartConfirmMessage,
  joinNoPendingLinksMessage,
  joinNoAvailableAccountsMessage,
  joinAlreadyRunningMessage,
  joinQueueDisabledMessage,
  joinStartedMessage,
  joinStoppedMessage,
  // statistics
  joinStatisticsMessage,
  // needs-approval
  joinNoNeedsApprovalMessage,
  joinNeedsApprovalMessage,
  joinApprovalDecidedMessage,
  // cleanup
  joinCleanupConfirmMessage,
  joinCleanupNothingToDoMessage,
  joinCleanupDoneMessage,
  // banned accounts
  joinNoBannedAccountsMessage,
  joinBannedAccountsMessage,
  // logs
  joinNoLogsMessage,
  joinLogsMessage,
  joinLogsClearConfirmMessage,
  joinLogsClearedMessage,
  // settings
  joinSettingsHubMessage,
  joinSettingsTimingMessage,
  joinSettingsBreaksMessage,
  joinSettingsLimitsMessage,
  joinSettingsRetryMessage,
  joinSettingsProtectionMessage,
  joinSettingsSummaryMessage,
  joinEditPromptMessages,
};
