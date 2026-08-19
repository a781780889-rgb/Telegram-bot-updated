/**
 * Publishing Engine Keyboards
 */
const { Markup } = require('telegraf');

const toggle = (selected, label) => `${selected ? '✅' : '⬜'} ${label}`;

module.exports = {
  publishMenuKeyboard: () => Markup.inlineKeyboard([
    [Markup.button.callback('▶️ بدء النشر', 'publish_direct_start'), Markup.button.callback('📅 جدولة النشر', 'publish_schedule_start')],
    [Markup.button.callback('📚 مكتبة الإعلانات', 'publish_ads_library'), Markup.button.callback('📂 نشر روابط المجلدات', 'publish_folders_start')],
    [Markup.button.callback('📱 اختيار الحسابات', 'publish_accounts_select'), Markup.button.callback('📊 لوحة المتابعة', 'publish_dashboard')],
    [Markup.button.callback('⚙️ إعدادات النشر', 'publish_settings'), Markup.button.callback('📜 سجل العمليات', 'publish_logs')],
    [Markup.button.callback('⬅️ رجوع', 'main_menu')],
  ]),

  adsLibraryKeyboard: (ads = []) => {
    const buttons = ads.map((ad) => [Markup.button.callback(`${ad.type === 'text' ? '📝' : '🖼'} ${(ad.text_content || 'إعلان بدون نص').slice(0, 28)}`, `publish_ad_view_${ad.id}`)]);
    buttons.push([Markup.button.callback('➕ إضافة إعلان جديد', 'publish_ad_add')]);
    buttons.push([Markup.button.callback('⬅️ رجوع', 'publish_menu')]);
    return Markup.inlineKeyboard(buttons);
  },

  adViewKeyboard: (adId) => Markup.inlineKeyboard([
    [Markup.button.callback('✏️ تعديل', `publish_ad_edit_${adId}`), Markup.button.callback('🗑 حذف', `publish_ad_delete_${adId}`)],
    [Markup.button.callback('⬅️ رجوع للمكتبة', 'publish_ads_library')],
  ]),

  confirmDeleteKeyboard: (adId) => Markup.inlineKeyboard([
    [Markup.button.callback('✅ نعم، احذف', `publish_ad_confirm_delete_${adId}`)],
    [Markup.button.callback('❌ تراجع', `publish_ad_view_${adId}`)],
  ]),

  dashboardKeyboard: () => Markup.inlineKeyboard([
    [Markup.button.callback('🔄 تحديث', 'publish_dashboard_refresh')],
    [Markup.button.callback('⬅️ رجوع', 'publish_menu')],
  ]),

  selectionKeyboard: (items, selected, prefix, labelOf) => {
    const buttons = items.map((item) => [Markup.button.callback(toggle(selected.includes(String(item.id)), labelOf(item)), `${prefix}_${item.id}`)]);
    buttons.push([Markup.button.callback('✅ متابعة', 'publish_flow_next')]);
    buttons.push([Markup.button.callback('⬅️ إلغاء', 'publish_menu')]);
    return Markup.inlineKeyboard(buttons);
  },

  targetKeyboard: (folders, selected) => {
    const buttons = folders.map((folder) => [Markup.button.callback(toggle(selected.includes(String(folder.id)), `${folder.name || `مجلد ${folder.folder_number}`} ${folder.invite_link ? '🔗' : '⚠️ لا يوجد رابط'}`), `publish_target_${folder.id}`)]);
    buttons.push([Markup.button.callback('✅ إنشاء مهمة النشر', 'publish_flow_confirm')]);
    buttons.push([Markup.button.callback('⬅️ إلغاء', 'publish_menu')]);
    return Markup.inlineKeyboard(buttons);
  },

  accountsKeyboard: (accounts, selected) => {
    const buttons = accounts.map((account) => [Markup.button.callback(toggle(selected.includes(String(account.id)), `${account.phone}${account.username ? ` @${account.username}` : ''}`), `publish_account_${account.id}`)]);
    buttons.push([Markup.button.callback('✅ حفظ الاختيار', 'publish_accounts_confirm')]);
    buttons.push([Markup.button.callback('⬅️ رجوع', 'publish_menu')]);
    return Markup.inlineKeyboard(buttons);
  },

  tasksKeyboard: (tasks) => Markup.inlineKeyboard([
    ...tasks.slice(0, 10).map((task) => [Markup.button.callback(`${task.status === 'running' ? '⏸' : '▶️'} ${task.name || `مهمة #${task.id}`}`, `publish_task_toggle_${task.id}`)]),
    [Markup.button.callback('⬅️ رجوع', 'publish_menu')],
  ]),
};
