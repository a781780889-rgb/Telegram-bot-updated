/**
 * Publishing Engine Keyboards
 */

const { Markup } = require('telegraf');

module.exports = {
  publishMenuKeyboard: () =>
    Markup.inlineKeyboard([
      [
        Markup.button.callback('▶️ بدء النشر', 'publish_direct_start'),
        Markup.button.callback('📅 جدولة النشر', 'publish_schedule_start'),
      ],
      [
        Markup.button.callback('📚 مكتبة الإعلانات', 'publish_ads_library'),
        Markup.button.callback('📂 نشر روابط المجلدات', 'publish_folders_start'),
      ],
      [
        Markup.button.callback('📱 اختيار الحسابات', 'publish_accounts_select'),
        Markup.button.callback('📊 لوحة المتابعة', 'publish_dashboard'),
      ],
      [
        Markup.button.callback('⚙️ إعدادات النشر', 'publish_settings'),
        Markup.button.callback('📜 سجل العمليات', 'publish_logs'),
      ],
      [Markup.button.callback('⬅️ رجوع', 'main_menu')],
    ]),

  adsLibraryKeyboard: (ads = []) => {
    const buttons = ads.map(ad => [
      Markup.button.callback(`${ad.type === 'text' ? '📝' : '🖼'} ${ad.text_content?.slice(0, 20) || 'إعلان بدون نص'}`, `publish_ad_view_${ad.id}`)
    ]);
    buttons.push([Markup.button.callback('➕ إضافة إعلان جديد', 'publish_ad_add')]);
    buttons.push([Markup.button.callback('⬅️ رجوع', 'publish_menu')]);
    return Markup.inlineKeyboard(buttons);
  },

  adViewKeyboard: (adId) =>
    Markup.inlineKeyboard([
      [
        Markup.button.callback('✏️ تعديل', `publish_ad_edit_${adId}`),
        Markup.button.callback('🗑 حذف', `publish_ad_delete_${adId}`),
      ],
      [Markup.button.callback('⬅️ رجوع للمكتبة', 'publish_ads_library')],
    ]),

  dashboardKeyboard: () =>
    Markup.inlineKeyboard([
      [Markup.button.callback('🔄 تحديث', 'publish_dashboard_refresh')],
      [Markup.button.callback('⬅️ رجوع', 'publish_menu')],
    ]),

  confirmDeleteKeyboard: (adId) =>
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ نعم، احذف', `publish_ad_confirm_delete_${adId}`)],
      [Markup.button.callback('❌ تراجع', `publish_ad_view_${adId}`)],
    ])
};
