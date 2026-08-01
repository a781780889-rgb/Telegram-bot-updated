/**
 * joinKeyboards.js — Enhanced keyboards for the Join-to-Links section
 *
 * All keyboards accept live data so the menu always reflects the real
 * system state (running / stopped, counts, per-account health) without
 * requiring a separate "refresh" round-trip.
 */

const { Markup } = require('telegraf');

// ─── State labels (shared with joinMessages.js) ───────────────────────────────

const STATE_LABELS = {
  idle:        '🟢 جاهز',
  working:     '⚡ يعمل الآن',
  resting:     '🟡 استراحة',
  banned:      '🔴 FloodWait',
  full:        '🟠 وصل الحد',
  needs_login: '⚪️ يحتاج تسجيل',
};

const stateLabel = (joinAcc) => {
  if (!joinAcc.enabled) return '⏸ متوقف';
  return STATE_LABELS[joinAcc.state] || '⚪️ غير معروف';
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns "✅ مفعّل" / "❌ معطّل" for a boolean/number setting value. */
const onOff = (value) => (value ? '✅ مفعّل' : '❌ معطّل');

/** Appends a badge count "(N)" to a label only when count > 0. */
const withBadge = (label, count) => (count > 0 ? `${label} (${count})` : label);

// ─── Main Menu (Dynamic) ──────────────────────────────────────────────────────

/**
 * Build the main-menu keyboard with live state embedded in button labels.
 *
 * @param {boolean} running       Is a join run currently active?
 * @param {number}  pendingCount  Links waiting in queue
 * @param {number}  approvalCount Links awaiting admin approval
 * @param {number}  restrictedCount Accounts that are banned / needs_login
 * @param {number}  availableAccounts Connected + enabled accounts
 */
const joinMenuKeyboard = ({
  running = false,
  pendingCount = 0,
  approvalCount = 0,
  restrictedCount = 0,
  availableAccounts = 0,
} = {}) => {
  const startLabel = running
    ? '🔄 تحديث الحالة'
    : `▶️ بدء الانضمام${pendingCount > 0 ? ` (${pendingCount} رابط)` : ''}`;

  return Markup.inlineKeyboard([
    // ── Control row ──────────────────────────────────────────
    [
      Markup.button.callback(startLabel,        running ? 'join_statistics'    : 'join_start'),
      Markup.button.callback('⏹ إيقاف',         running ? 'join_stop'          : 'join_start'),
    ],
    // ── Accounts ─────────────────────────────────────────────
    [
      Markup.button.callback(
        `👤 إدارة الحسابات${availableAccounts > 0 ? ` (${availableAccounts} متاح)` : ''}`,
        'join_accounts_menu',
      ),
    ],
    // ── Links ────────────────────────────────────────────────
    [
      Markup.button.callback('🔗 إضافة روابط',       'join_add_links'),
      Markup.button.callback('📋 عرض الروابط',       'join_links_overview'),
    ],
    // ── Monitoring ───────────────────────────────────────────
    [
      Markup.button.callback('📊 الإحصائيات',         'join_statistics'),
      Markup.button.callback('📜 سجل العمليات',       'join_logs'),
    ],
    // ── Alerts ───────────────────────────────────────────────
    [
      Markup.button.callback(
        withBadge('🕓 طلبات الموافقة', approvalCount),
        'join_needs_approval',
      ),
      Markup.button.callback(
        withBadge('🚫 الحسابات المقيدة', restrictedCount),
        'join_banned_accounts',
      ),
    ],
    // ── Tools ────────────────────────────────────────────────
    [
      Markup.button.callback('🧹 تنظيف الروابط الفاشلة', 'join_cleanup'),
    ],
    // ── Settings & Back ──────────────────────────────────────
    [
      Markup.button.callback('⚙️ الإعدادات', 'join_settings'),
    ],
    [
      Markup.button.callback('⬅️ رجوع للقائمة الرئيسية', 'main_menu'),
    ],
  ]);
};

// ─── Accounts Management ──────────────────────────────────────────────────────

const joinAccountsListKeyboard = (joinAccounts) => {
  const rows = joinAccounts.map((acc) => {
    const name = [acc.first_name, acc.last_name].filter(Boolean).join(' ') || acc.phone;
    const label = `${name.slice(0, 22)} — ${stateLabel(acc)}`;
    return [Markup.button.callback(label, `join_account_detail_${acc.account_id}`)];
  });

  // Bulk actions (only shown when there are accounts)
  if (joinAccounts.length > 1) {
    rows.push([
      Markup.button.callback('✅ تشغيل الكل',  'join_accounts_enable_all'),
      Markup.button.callback('⏸ إيقاف الكل',   'join_accounts_disable_all'),
    ]);
  }

  rows.push([Markup.button.callback('⬅️ رجوع', 'join_menu')]);
  return Markup.inlineKeyboard(rows);
};

const joinAccountDetailKeyboard = (accountId, enabled, state) => {
  const rows = [];

  // Toggle enabled / disabled
  rows.push([
    enabled
      ? Markup.button.callback('⏸ إيقاف هذا الحساب',  `join_account_disable_${accountId}`)
      : Markup.button.callback('▶️ تشغيل هذا الحساب', `join_account_enable_${accountId}`),
  ]);

  // If banned/flood — show "reset" option so admin can manually clear
  if (state === 'banned') {
    rows.push([
      Markup.button.callback('🔄 إعادة تعيين حالة FloodWait', `join_account_reset_ban_${accountId}`),
    ]);
  }

  rows.push([Markup.button.callback('⬅️ رجوع لقائمة الحسابات', 'join_accounts_menu')]);
  return Markup.inlineKeyboard(rows);
};

// ─── Links Overview ───────────────────────────────────────────────────────────

/**
 * Compact status breakdown with quick-filter tabs.
 * @param {object} stats  result of joinLinkQueries.countByStatus()
 */
const joinLinksOverviewKeyboard = (stats) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback(`⏳ انتظار (${stats.pending || 0})`,      'join_links_filter_pending'),
      Markup.button.callback(`✅ تم (${stats.joined || 0})`,           'join_links_filter_joined'),
    ],
    [
      Markup.button.callback(`⏭ متخطي (${stats.skipped || 0})`,       'join_links_filter_skipped'),
      Markup.button.callback(`❌ فشل (${stats.failed || 0})`,          'join_links_filter_failed'),
    ],
    [
      Markup.button.callback(`🕓 موافقة (${stats.needs_approval || 0})`, 'join_needs_approval'),
      Markup.button.callback(`🚫 غير صالح (${stats.invalid || 0})`,   'join_links_filter_invalid'),
    ],
    [Markup.button.callback('🔗 إضافة روابط جديدة', 'join_add_links')],
    [Markup.button.callback('🧹 تنظيف الفاشلة',    'join_cleanup')],
    [Markup.button.callback('⬅️ رجوع',              'join_menu')],
  ]);

// ─── Add Links ────────────────────────────────────────────────────────────────

const joinAddLinksKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('❌ إلغاء', 'join_menu')],
  ]);

const joinAddLinksResultKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('▶️ بدء الانضمام الآن',  'join_start')],
    [Markup.button.callback('🔗 إضافة المزيد من الروابط', 'join_add_links')],
    [Markup.button.callback('📋 عرض الروابط',          'join_links_overview')],
    [Markup.button.callback('⬅️ رجوع',                 'join_menu')],
  ]);

// ─── Start / Stop ─────────────────────────────────────────────────────────────

const joinStartConfirmKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('✅ تأكيد البدء',  'join_start_confirm')],
    [Markup.button.callback('❌ إلغاء',        'join_menu')],
  ]);

const joinRunningKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('⏹ إيقاف الانضمام',   'join_stop')],
    [Markup.button.callback('📊 مراقبة الإحصائيات', 'join_statistics')],
    [Markup.button.callback('📜 سجل العمليات',      'join_logs')],
    [Markup.button.callback('⬅️ رجوع',              'join_menu')],
  ]);

// ─── Statistics ───────────────────────────────────────────────────────────────

const joinStatisticsKeyboard = (running) =>
  Markup.inlineKeyboard([
    ...(running
      ? [[
          Markup.button.callback('⏹ إيقاف الانضمام',    'join_stop'),
          Markup.button.callback('🔄 تحديث',             'join_statistics'),
        ]]
      : [[Markup.button.callback('▶️ استئناف الانضمام', 'join_start')]]),
    [
      Markup.button.callback('🕓 طلبات الموافقة',      'join_needs_approval'),
      Markup.button.callback('📜 سجل العمليات',        'join_logs'),
    ],
    [
      Markup.button.callback('🚫 الحسابات المقيدة',    'join_banned_accounts'),
      Markup.button.callback('🧹 تنظيف الفاشلة',      'join_cleanup'),
    ],
    [Markup.button.callback('⬅️ رجوع',                 'join_menu')],
  ]);

// ─── Needs-approval review ─────────────────────────────────────────────────────

const joinNeedsApprovalKeyboard = (links) => {
  const rows = links.slice(0, 8).map((l) => [
    Markup.button.callback(`✅ قبول #${l.id}`,  `join_approve_link_${l.id}`),
    Markup.button.callback(`❌ رفض #${l.id}`,   `join_reject_link_${l.id}`),
  ]);
  rows.push([Markup.button.callback('⬅️ رجوع', 'join_menu')]);
  return Markup.inlineKeyboard(rows);
};

// ─── Cleanup ──────────────────────────────────────────────────────────────────

const joinCleanupConfirmKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('✅ تأكيد الحذف', 'join_cleanup_confirm')],
    [Markup.button.callback('❌ إلغاء',       'join_statistics')],
  ]);

// ─── Settings Hub ─────────────────────────────────────────────────────────────

const joinSettingsKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('⏱ التوقيت بين العمليات',   'join_settings_timing')],
    [Markup.button.callback('🛑 الاستراحات والدُّفعات',  'join_settings_breaks')],
    [Markup.button.callback('📈 حدود الانضمام',          'join_settings_limits')],
    [Markup.button.callback('🔁 إعادة المحاولة',          'join_settings_retry')],
    [Markup.button.callback('🛡 الحماية والتوزيع',        'join_settings_protection')],
    [Markup.button.callback('📋 ملخص الإعدادات الحالية', 'join_settings_summary')],
    [Markup.button.callback('⬅️ رجوع',                   'join_menu')],
  ]);

// ─── Settings sections ────────────────────────────────────────────────────────

const joinSettingsTimingKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('✏️ تعديل الفاصل الزمني (عشوائي)', 'join_edit_join_delay_range')],
    [Markup.button.callback('⬅️ رجوع للإعدادات', 'join_settings')],
  ]);

const joinSettingsBreaksKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('✏️ عدد الروابط قبل الاستراحة', 'join_edit_batch_size')],
    [Markup.button.callback('✏️ مدة الاستراحة (عشوائية)',    'join_edit_rest_range')],
    [Markup.button.callback('⬅️ رجوع للإعدادات', 'join_settings')],
  ]);

const joinSettingsLimitsKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('✏️ الحد الأقصى الكلي لكل حساب',     'join_edit_max_joins')],
    [Markup.button.callback('✏️ الحد الأقصى بالساعة',              'join_edit_max_joins_hour')],
    [Markup.button.callback('✏️ الحد الأقصى باليوم',               'join_edit_max_joins_day')],
    [Markup.button.callback('✏️ الحد الأقصى للجلسة الواحدة',       'join_edit_max_joins_session')],
    [Markup.button.callback('⬅️ رجوع للإعدادات', 'join_settings')],
  ]);

const joinSettingsRetryKeyboard = (settings) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(
      `إعادة المحاولة: ${onOff(settings.retry_enabled)}`,
      'join_toggle_retry_enabled',
    )],
    [Markup.button.callback('✏️ الحد الأقصى لعدد المحاولات',     'join_edit_max_retries')],
    [Markup.button.callback('✏️ الفاصل الزمني قبل إعادة المحاولة', 'join_edit_retry_delay')],
    [Markup.button.callback('⬅️ رجوع للإعدادات', 'join_settings')],
  ]);

const joinSettingsProtectionKeyboard = (settings) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(
      `🛡 الحماية من FloodWait: ${onOff(settings.smart_protection_enabled)}`,
      'join_toggle_smart_protection_enabled',
    )],
    [Markup.button.callback(
      `🔀 التوزيع التلقائي للروابط: ${onOff(settings.auto_distribute)}`,
      'join_toggle_auto_distribute',
    )],
    [Markup.button.callback(
      `⚡ تفعيل نظام الانضمام: ${onOff(settings.queue_enabled)}`,
      'join_toggle_queue_enabled',
    )],
    [Markup.button.callback('⬅️ رجوع للإعدادات', 'join_settings')],
  ]);

const joinSettingsSummaryKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('⏱ تعديل التوقيت',     'join_settings_timing')],
    [Markup.button.callback('🛑 تعديل الاستراحات',  'join_settings_breaks')],
    [Markup.button.callback('📈 تعديل الحدود',      'join_settings_limits')],
    [Markup.button.callback('🔁 تعديل إعادة المحاولة', 'join_settings_retry')],
    [Markup.button.callback('🛡 تعديل الحماية',     'join_settings_protection')],
    [Markup.button.callback('⬅️ رجوع للإعدادات',   'join_settings')],
  ]);

// ─── Settings back ────────────────────────────────────────────────────────────

const joinSettingsBackKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('⬅️ رجوع للإعدادات', 'join_settings')],
  ]);

// ─── Logs ─────────────────────────────────────────────────────────────────────

/**
 * @param {boolean} hasMore  whether there are more logs to paginate
 * @param {number}  page     current page index (0-based)
 */
const joinLogsKeyboard = (hasMore = false, page = 0) =>
  Markup.inlineKeyboard([
    ...(hasMore
      ? [[Markup.button.callback(`▶️ المزيد (صفحة ${page + 2})`, `join_logs_page_${page + 1}`)]]
      : []),
    [
      Markup.button.callback('🗑 مسح السجل',   'join_logs_clear_confirm'),
      Markup.button.callback('🔄 تحديث',       'join_logs'),
    ],
    [Markup.button.callback('⬅️ رجوع', 'join_menu')],
  ]);

const joinLogsClearConfirmKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('✅ تأكيد المسح',  'join_logs_clear')],
    [Markup.button.callback('❌ إلغاء',        'join_logs')],
  ]);

// ─── Links filter (read-only status screens) ──────────────────────────────────

const joinLinksFilterKeyboard = (activeFilter) => {
  const filters = [
    ['pending', '⏳ انتظار'], ['joined', '✅ تم'],
    ['skipped', '⏭ متخطي'], ['failed', '❌ فشل'],
    ['invalid', '🚫 غير صالح'], ['needs_approval', '🕓 موافقة'],
  ];

  const rows = [];
  for (let i = 0; i < filters.length; i += 2) {
    const row = filters.slice(i, i + 2).map(([key, label]) =>
      Markup.button.callback(
        key === activeFilter ? `◉ ${label}` : label,
        `join_links_filter_${key}`,
      ),
    );
    rows.push(row);
  }
  rows.push([Markup.button.callback('⬅️ رجوع', 'join_links_overview')]);
  return Markup.inlineKeyboard(rows);
};

// ─── Generic back ─────────────────────────────────────────────────────────────

const joinBackKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('⬅️ رجوع', 'join_menu')],
  ]);

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // helpers
  stateLabel,
  onOff,
  withBadge,
  // menus
  joinMenuKeyboard,
  joinAccountsListKeyboard,
  joinAccountDetailKeyboard,
  joinLinksOverviewKeyboard,
  joinAddLinksKeyboard,
  joinAddLinksResultKeyboard,
  joinStartConfirmKeyboard,
  joinRunningKeyboard,
  joinStatisticsKeyboard,
  joinNeedsApprovalKeyboard,
  joinCleanupConfirmKeyboard,
  // settings
  joinSettingsKeyboard,
  joinSettingsTimingKeyboard,
  joinSettingsBreaksKeyboard,
  joinSettingsLimitsKeyboard,
  joinSettingsRetryKeyboard,
  joinSettingsProtectionKeyboard,
  joinSettingsSummaryKeyboard,
  joinSettingsBackKeyboard,
  // logs
  joinLogsKeyboard,
  joinLogsClearConfirmKeyboard,
  // links overview
  joinLinksOverviewKeyboard,
  joinLinksFilterKeyboard,
  // generic
  joinBackKeyboard,
};
