const { Markup } = require('telegraf');

// ─── Main Menu ────────────────────────────────────────────────────────────────

/**
 * Main menu keyboard — all account actions are nested under "accounts_menu"
 */
const mainMenuKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🚀 محرك النشر', 'publish_menu')],
    [Markup.button.callback('📂 الحسابات', 'accounts_menu')],
    [Markup.button.callback('🔗 الروابط', 'links_menu')],
    [Markup.button.callback('🔗 الانضمام للروابط', 'join_menu')],
    [Markup.button.callback('📁 قاعدة البيانات والمجلدات', 'folders_menu')],
    [Markup.button.callback('ℹ️ المساعدة', 'help')],
  ]);

// ─── Account Management Menu ──────────────────────────────────────────────────

/**
 * Account management sub-menu keyboard
 */
const accountsMenuKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('➕ إضافة حساب', 'add_account')],
    [Markup.button.callback('✏️ تعديل حساب', 'edit_account_list')],
    [Markup.button.callback('📋 عرض الحسابات', 'list_accounts')],
    [Markup.button.callback('🗑 حذف حساب', 'delete_account_list')],
    [Markup.button.callback('🔄 تحديث حالة الحسابات', 'refresh_all_status')],
    [Markup.button.callback('📊 إحصائيات الحسابات', 'accounts_stats')],
    [Markup.button.callback('⬅️ رجوع', 'main_menu')],
  ]);

// ─── Flow Keyboards ───────────────────────────────────────────────────────────

/**
 * Cancel keyboard shown during multi-step flows
 */
const cancelKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('❌ إلغاء', 'cancel_flow')],
  ]);

/**
 * Keyboard shown while waiting for the OTP code — adds a "didn't receive
 * the code" resend option next to Cancel.
 */
const otpKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📩 لم يصلني الرمز', 'resend_otp')],
    [Markup.button.callback('❌ إلغاء', 'cancel_flow')],
  ]);

/**
 * Back to accounts menu keyboard
 */
const backToAccountsMenuKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🔙 إدارة الحسابات', 'accounts_menu')],
    [Markup.button.callback('🏠 القائمة الرئيسية', 'main_menu')],
  ]);

/**
 * Back to accounts list keyboard
 */
const backToListKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📋 عرض الحسابات', 'list_accounts')],
    [Markup.button.callback('🏠 القائمة الرئيسية', 'main_menu')],
  ]);

/**
 * Back to main menu keyboard
 */
const backToMenuKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🔙 القائمة الرئيسية', 'main_menu')],
  ]);

/**
 * Retry keyboard (for errors)
 */
const retryKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🔁 إعادة المحاولة', 'add_account')],
    [Markup.button.callback('🔙 القائمة الرئيسية', 'main_menu')],
  ]);

// ─── Account Detail Keyboards ─────────────────────────────────────────────────

/**
 * Account actions keyboard shown on account detail page
 * @param {number} accountId
 * @param {string} status
 */
const accountActionsKeyboard = (accountId, status) => {
  const rows = [];

  // Row 1: primary action based on status
  if (status === 'connected') {
    rows.push([
      Markup.button.callback('🔍 فحص الحالة', `check_status_${accountId}`),
      Markup.button.callback('✏️ تعديل', `edit_account_${accountId}`),
    ]);
  } else {
    rows.push([
      Markup.button.callback('🔄 إعادة تسجيل الدخول', `relogin_${accountId}`),
      Markup.button.callback('🔍 فحص الحالة', `check_status_${accountId}`),
    ]);
  }

  // Row 2: destructive action
  rows.push([
    Markup.button.callback('🗑️ حذف الحساب', `delete_confirm_${accountId}`),
  ]);

  // Row 3: navigation
  rows.push([
    Markup.button.callback('🔙 القائمة', 'list_accounts'),
  ]);

  return Markup.inlineKeyboard(rows);
};

/**
 * Delete confirmation keyboard
 * @param {number} accountId
 */
const confirmDeleteKeyboard = (accountId) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ نعم، احذف', `delete_yes_${accountId}`),
      Markup.button.callback('❌ لا، إلغاء', `account_detail_${accountId}`),
    ],
  ]);

/**
 * Edit account keyboard — choose what to edit
 * @param {number} accountId
 */
const editAccountKeyboard = (accountId) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🔄 إعادة تسجيل الدخول', `relogin_${accountId}`)],
    [Markup.button.callback('🔍 تحديث الحالة', `check_status_${accountId}`)],
    [Markup.button.callback('🔙 رجوع للحساب', `account_detail_${accountId}`)],
  ]);

/**
 * After refresh all — view results keyboard
 */
const afterRefreshKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📋 عرض الحسابات', 'list_accounts')],
    [Markup.button.callback('📊 الإحصائيات', 'accounts_stats')],
    [Markup.button.callback('🏠 القائمة الرئيسية', 'main_menu')],
  ]);

/**
 * Stats page keyboard
 */
const statsKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📋 عرض الحسابات', 'list_accounts')],
    [Markup.button.callback('🔄 تحديث الكل', 'refresh_all_status')],
    [Markup.button.callback('🏠 القائمة الرئيسية', 'main_menu')],
  ]);

module.exports = {
  mainMenuKeyboard,
  accountsMenuKeyboard,
  cancelKeyboard,
  otpKeyboard,
  backToAccountsMenuKeyboard,
  backToListKeyboard,
  backToMenuKeyboard,
  retryKeyboard,
  accountActionsKeyboard,
  confirmDeleteKeyboard,
  editAccountKeyboard,
  afterRefreshKeyboard,
  statsKeyboard,
};
