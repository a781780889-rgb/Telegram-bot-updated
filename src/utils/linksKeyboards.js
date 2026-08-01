const { Markup } = require('telegraf');

// ─── Links Main Menu ──────────────────────────────────────────────────────────

const linksMenuKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🔍 بدء البحث عن الروابط', 'links_start_search')],
    [Markup.button.callback('📂 الملفات المستخرجة', 'links_extracted_files')],
    [Markup.button.callback('📊 الإحصائيات', 'links_statistics')],
    [Markup.button.callback('⚙️ إعدادات البحث', 'links_settings')],
    [Markup.button.callback('🗑 تنظيف الملفات', 'links_clean_files')],
    [Markup.button.callback('📜 سجل عمليات البحث', 'links_history')],
    [Markup.button.callback('⬅️ رجوع', 'main_menu')],
  ]);

// ─── Step 1: Account Selection ────────────────────────────────────────────────

const linksSelectAccountsKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('◉ حساب واحد', 'links_accounts_one')],
    [Markup.button.callback('◉ حسابان', 'links_accounts_two')],
    [Markup.button.callback('◉ عدة حسابات', 'links_accounts_multiple')],
    [Markup.button.callback('◉ جميع الحسابات', 'links_accounts_all')],
    [Markup.button.callback('❌ إلغاء', 'links_menu')],
  ]);

/**
 * Build keyboard to pick specific accounts from a list
 * @param {Array} accounts
 * @param {Array<number>} selectedIds
 */
const linksPickAccountsKeyboard = (accounts, selectedIds = []) => {
  const rows = accounts.map((acc) => {
    const name =
      [acc.first_name, acc.last_name].filter(Boolean).join(' ') || acc.phone;
    const isSelected = selectedIds.includes(acc.id);
    const label = `${isSelected ? '✅' : '◻️'} ${name.slice(0, 25)}`;
    return [Markup.button.callback(label, `links_toggle_account_${acc.id}`)];
  });

  rows.push([
    Markup.button.callback('✅ تأكيد الاختيار', 'links_confirm_accounts'),
    Markup.button.callback('❌ إلغاء', 'links_menu'),
  ]);

  return Markup.inlineKeyboard(rows);
};

// ─── Step 2: Link Type ────────────────────────────────────────────────────────

const linksSelectTypeKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('◉ روابط تيليجرام + واتساب', 'links_type_both')],
    [Markup.button.callback('◉ روابط تيليجرام فقط', 'links_type_telegram')],
    [Markup.button.callback('◉ روابط واتساب فقط', 'links_type_whatsapp')],
    [
      Markup.button.callback('⬅️ رجوع', 'links_back_to_step1'),
      Markup.button.callback('❌ إلغاء', 'links_menu'),
    ],
  ]);

// ─── Step 3a: Telegram Sub-type ───────────────────────────────────────────────

/**
 * @param {string[]} selected  - currently toggled values
 */
const linksTelegramSubtypeKeyboard = (selected = []) => {
  const isAll = selected.includes('all');

  const _btn = (label, value) => {
    const active = isAll ? value === 'all' : selected.includes(value);
    return Markup.button.callback(`${active ? '✅' : '◻️'} ${label}`, `links_tgsub_${value}`);
  };

  return Markup.inlineKeyboard([
    [_btn('مجموعات عامة', 'public_group')],
    [_btn('قنوات', 'channel')],
    [_btn('مجموعات خاصة (دعوة)', 'private_group')],
    [_btn('الكل', 'all')],
    [
      Markup.button.callback('✅ تأكيد', 'links_tgsub_confirm'),
      Markup.button.callback('⬅️ رجوع', 'links_back_to_step2'),
    ],
  ]);
};

// ─── Step 3b: WhatsApp Sub-type ───────────────────────────────────────────────

/**
 * @param {string[]} selected
 */
const linksWhatsappSubtypeKeyboard = (selected = []) => {
  const isAll = selected.includes('all');

  const _btn = (label, value) => {
    const active = isAll ? value === 'all' : selected.includes(value);
    return Markup.button.callback(`${active ? '✅' : '◻️'} ${label}`, `links_wasub_${value}`);
  };

  // Determine back button: if 'both' mode came before, back goes to telegram subtype
  return Markup.inlineKeyboard([
    [_btn('مجموعات واتساب', 'group')],
    [_btn('قنوات واتساب', 'channel')],
    [_btn('الكل', 'all')],
    [
      Markup.button.callback('✅ تأكيد', 'links_wasub_confirm'),
      Markup.button.callback('⬅️ رجوع', 'links_back_to_step3a'),
    ],
  ]);
};

// ─── Step 4: Time Period ──────────────────────────────────────────────────────

const linksSelectPeriodKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('◉ آخر يوم', 'links_period_day')],
    [Markup.button.callback('◉ آخر أسبوع', 'links_period_week')],
    [Markup.button.callback('◉ آخر شهر', 'links_period_month')],
    [Markup.button.callback('◉ آخر 3 أشهر', 'links_period_3months')],
    [Markup.button.callback('◉ آخر سنة', 'links_period_year')],
    [Markup.button.callback('◉ تحديد فترة مخصصة', 'links_period_custom')],
    [
      Markup.button.callback('⬅️ رجوع', 'links_back_to_step3'),
      Markup.button.callback('❌ إلغاء', 'links_menu'),
    ],
  ]);

// ─── Step 5: Search Depth ─────────────────────────────────────────────────────

const linksSelectDepthKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('⚡ بحث سريع', 'links_depth_fast')],
    [Markup.button.callback('🔍 بحث متوسط', 'links_depth_medium')],
    [Markup.button.callback('🔬 بحث عميق', 'links_depth_deep')],
    [
      Markup.button.callback('⬅️ رجوع', 'links_back_to_step4'),
      Markup.button.callback('❌ إلغاء', 'links_menu'),
    ],
  ]);

// ─── Step 6: Review ───────────────────────────────────────────────────────────

const linksReviewKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🚀 بدء البحث', 'links_execute_search')],
    [
      Markup.button.callback('⬅️ رجوع', 'links_back_to_step5'),
      Markup.button.callback('❌ إلغاء', 'links_menu'),
    ],
  ]);

// ─── Active Search Controls ───────────────────────────────────────────────────

const linksSearchControlsKeyboard = (isPaused = false) =>
  Markup.inlineKeyboard([
    [
      isPaused
        ? Markup.button.callback('▶️ استكمال', 'links_resume_search')
        : Markup.button.callback('⏸ إيقاف مؤقت', 'links_pause_search'),
      Markup.button.callback('⏹ إيقاف البحث', 'links_stop_search'),
    ],
  ]);

// ─── Post-Search Results ──────────────────────────────────────────────────────

const linksResultsKeyboard = (operationId) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📂 عرض الملفات', `links_view_op_${operationId}`)],
    [Markup.button.callback('📊 الإحصائيات', 'links_statistics')],
    [Markup.button.callback('🔍 بحث جديد', 'links_start_search')],
    [Markup.button.callback('🏠 القائمة الرئيسية', 'links_menu')],
  ]);

// ─── Extracted Files ──────────────────────────────────────────────────────────

const linksOperationActionsKeyboard = (operationId) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('👁 عرض', `links_op_view_${operationId}`),
      Markup.button.callback('📥 تحميل', `links_op_download_${operationId}`),
    ],
    [
      Markup.button.callback('✏️ إعادة تسمية', `links_op_rename_${operationId}`),
      Markup.button.callback('🗑 حذف', `links_op_delete_${operationId}`),
    ],
    [Markup.button.callback('📤 تصدير', `links_op_export_${operationId}`)],
    [Markup.button.callback('⬅️ رجوع', 'links_extracted_files')],
  ]);

const linksConfirmDeleteOpKeyboard = (operationId) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ نعم، احذف', `links_op_confirm_delete_${operationId}`),
      Markup.button.callback('❌ لا، إلغاء', `links_view_op_${operationId}`),
    ],
  ]);

// ─── Settings ─────────────────────────────────────────────────────────────────

const linksSettingsKeyboard = (settings) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback(
        `${settings.remove_duplicates ? '✅' : '❌'} إزالة التكرار`,
        'links_toggle_setting_remove_duplicates'
      ),
    ],
    [
      Markup.button.callback(
        `${settings.save_history ? '✅' : '❌'} حفظ سجل العمليات`,
        'links_toggle_setting_save_history'
      ),
    ],
    [
      Markup.button.callback(
        `${settings.auto_stop_on_error ? '✅' : '❌'} إيقاف تلقائي عند خطأ`,
        'links_toggle_setting_auto_stop_on_error'
      ),
    ],
    [
      Markup.button.callback(
        `${settings.retry_on_fail ? '✅' : '❌'} إعادة المحاولة عند الفشل`,
        'links_toggle_setting_retry_on_fail'
      ),
    ],
    [Markup.button.callback('⬅️ رجوع', 'links_menu')],
  ]);

// ─── History ──────────────────────────────────────────────────────────────────

const linksHistoryKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('⬅️ رجوع', 'links_menu')],
  ]);

// ─── Clean Files ──────────────────────────────────────────────────────────────

const linksConfirmCleanKeyboard = () =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ نعم، احذف الكل', 'links_confirm_clean'),
      Markup.button.callback('❌ إلغاء', 'links_menu'),
    ],
  ]);

// ─── Generic Back ─────────────────────────────────────────────────────────────

const linksBackKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('⬅️ رجوع', 'links_menu')],
  ]);

module.exports = {
  linksMenuKeyboard,
  linksSelectAccountsKeyboard,
  linksPickAccountsKeyboard,
  linksSelectTypeKeyboard,
  linksTelegramSubtypeKeyboard,
  linksWhatsappSubtypeKeyboard,
  linksSelectPeriodKeyboard,
  linksSelectDepthKeyboard,
  linksReviewKeyboard,
  linksSearchControlsKeyboard,
  linksResultsKeyboard,
  linksOperationActionsKeyboard,
  linksConfirmDeleteOpKeyboard,
  linksSettingsKeyboard,
  linksHistoryKeyboard,
  linksConfirmCleanKeyboard,
  linksBackKeyboard,
};
