/**
 * Publishing Engine Handlers
 */
const logger = require('../utils/logger');
const messages = require('../utils/publishMessages');
const keyboards = require('../utils/publishKeyboards');
const { accountQueries } = require('../database/db');
const { folderQueries } = require('../database/joinDb');
const { adQueries, taskQueries, logQueries } = require('../database/publishDb');
const publishWizardState = require('../services/publishWizardState');
const { WIZARD_STEPS } = publishWizardState;
const { executeTaskStep } = require('../services/publishService');

const safeEdit = async (ctx, text, keyboard) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
  } catch (error) {
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  }
};
const uid = (ctx) => String(ctx.from.id);
const selected = (state, key) => (state?.data?.[key] || []).map(String);

const handlePublishMenu = async (ctx) => safeEdit(ctx, messages.publishMenu(), keyboards.publishMenuKeyboard());

const handleAdsLibrary = async (ctx) => {
  const ads = adQueries.getAll(uid(ctx));
  return safeEdit(ctx, messages.adsLibraryMenu(ads.length), keyboards.adsLibraryKeyboard(ads));
};

const handleAdAddStart = async (ctx) => {
  publishWizardState.setWizardState(uid(ctx), WIZARD_STEPS.AWAITING_AD_CONTENT);
  await ctx.answerCbQuery().catch(() => {});
  return ctx.reply(messages.addAdPrompt());
};

const handleAdView = async (ctx, adId) => {
  const ad = adQueries.getById(adId, uid(ctx));
  if (!ad) return ctx.answerCbQuery('الإعلان غير موجود').catch(() => {});
  return safeEdit(ctx, `*تفاصيل الإعلان:*

النوع: ${ad.type}
المحتوى: ${ad.text_content || 'لا يوجد'}
التاريخ: ${ad.created_at}`, keyboards.adViewKeyboard(adId));
};

const handleAdDelete = async (ctx, adId) => {
  const ad = adQueries.getById(adId, uid(ctx));
  if (!ad) return ctx.answerCbQuery('الإعلان غير موجود').catch(() => {});
  return safeEdit(ctx, `⚠️ هل تريد حذف الإعلان رقم *${adId}*؟\n\nلن يمكن التراجع عن هذا الإجراء.`, keyboards.confirmDeleteKeyboard(adId));
};

const handleAdConfirmDelete = async (ctx, adId) => {
  const result = adQueries.delete(adId, uid(ctx));
  if (!result.changes) return ctx.answerCbQuery('الإعلان غير موجود').catch(() => {});
  return handleAdsLibrary(ctx);
};

const handleAdEdit = async (ctx, adId) => {
  const ad = adQueries.getById(adId, uid(ctx));
  if (!ad) return ctx.answerCbQuery('الإعلان غير موجود').catch(() => {});
  publishWizardState.setWizardState(uid(ctx), WIZARD_STEPS.AWAITING_AD_CONTENT, { editingAdId: adId });
  await ctx.answerCbQuery().catch(() => {});
  return ctx.reply(`أرسل النص الجديد للإعلان رقم ${adId}.`);
};

const renderAccounts = async (ctx, returnToFlow = false) => {
  const state = publishWizardState.getWizardState(uid(ctx));
  const accounts = accountQueries.getAllByUserId(uid(ctx)).filter((a) => a.status === 'connected');
  const key = returnToFlow ? 'accountIds' : 'savedAccountIds';
  return safeEdit(ctx, `📱 *اختيار الحسابات*\n\nالحسابات المتصلة: ${accounts.length}\nاختر حسابًا واحدًا أو أكثر ثم اضغط حفظ.`, keyboards.accountsKeyboard(accounts, selected(state, key)));
};

const handleAccountsSelect = async (ctx) => {
  const accounts = accountQueries.getAllByUserId(uid(ctx)).filter((a) => a.status === 'connected');
  publishWizardState.setWizardState(uid(ctx), WIZARD_STEPS.IDLE, { savedAccountIds: accounts.map((a) => String(a.id)) });
  return renderAccounts(ctx, false);
};

const handleAccountToggle = async (ctx, accountId) => {
  const state = publishWizardState.getWizardState(uid(ctx)) || { data: {} };
  const key = state.data.mode ? 'accountIds' : 'savedAccountIds';
  const values = selected(state, key);
  const id = String(accountId);
  const next = values.includes(id) ? values.filter((x) => x !== id) : [...values, id];
  publishWizardState.setWizardState(uid(ctx), state.step || WIZARD_STEPS.IDLE, { [key]: next });
  return renderAccounts(ctx, Boolean(state.data.mode));
};

const handleAccountsConfirm = async (ctx) => {
  const state = publishWizardState.getWizardState(uid(ctx));
  if (!selected(state, 'savedAccountIds').length) return ctx.answerCbQuery('اختر حسابًا واحدًا على الأقل').catch(() => {});
  return handlePublishMenu(ctx);
};

const beginPublish = async (ctx, mode) => {
  const accounts = accountQueries.getAllByUserId(uid(ctx)).filter((a) => a.status === 'connected');
  const saved = publishWizardState.getWizardState(uid(ctx))?.data?.savedAccountIds || accounts.map((a) => String(a.id));
  publishWizardState.setWizardState(uid(ctx), WIZARD_STEPS.IDLE, { mode, accountIds: saved.map(String), adIds: [], targetIds: [] });
  const ads = adQueries.getAll(uid(ctx));
  if (!accounts.length) return safeEdit(ctx, '⚠️ لا يوجد حساب متصل. أضف حسابًا ثم حاول مرة أخرى.', keyboards.publishMenuKeyboard());
  if (!ads.length) return safeEdit(ctx, '⚠️ مكتبة الإعلانات فارغة. أضف إعلانًا أولًا.', keyboards.adsLibraryKeyboard([]));
  return safeEdit(ctx, `${mode === 'direct' ? '▶️' : '📅'} *اختيار الإعلان*\n\nحدد إعلانًا واحدًا أو أكثر.`, keyboards.selectionKeyboard(ads, [], 'publish_ad_select', (ad) => (ad.text_content || `إعلان #${ad.id}`).slice(0, 30)));
};

const handleAdSelect = async (ctx, adId) => {
  const state = publishWizardState.getWizardState(uid(ctx));
  const values = selected(state, 'adIds');
  const id = String(adId);
  const next = values.includes(id) ? values.filter((x) => x !== id) : [...values, id];
  publishWizardState.setWizardState(uid(ctx), state.step, { adIds: next });
  const ads = adQueries.getAll(uid(ctx));
  return safeEdit(ctx, '📝 *اختيار الإعلانات*\n\nحدد إعلانًا واحدًا أو أكثر.', keyboards.selectionKeyboard(ads, next, 'publish_ad_select', (ad) => (ad.text_content || `إعلان #${ad.id}`).slice(0, 30)));
};

const handleFlowNext = async (ctx) => {
  const state = publishWizardState.getWizardState(uid(ctx));
  if (!selected(state, 'adIds').length) return ctx.answerCbQuery('اختر إعلانًا واحدًا على الأقل').catch(() => {});
  const folders = folderQueries.getAllByUserId(uid(ctx)).filter((f) => f.invite_link);
  if (!folders.length) return safeEdit(ctx, '⚠️ لا توجد مجلدات مكتملة تحتوي على رابط مشاركة.', keyboards.publishMenuKeyboard());
  return safeEdit(ctx, '📂 *اختيار روابط المجلدات*\n\nحدد المجلدات المستهدفة.', keyboards.targetKeyboard(folders, []));
};

const handleTargetToggle = async (ctx, folderId) => {
  const state = publishWizardState.getWizardState(uid(ctx));
  const values = selected(state, 'targetIds');
  const id = String(folderId);
  const next = values.includes(id) ? values.filter((x) => x !== id) : [...values, id];
  publishWizardState.setWizardState(uid(ctx), state.step, { targetIds: next });
  const folders = folderQueries.getAllByUserId(uid(ctx)).filter((f) => f.invite_link);
  return safeEdit(ctx, '📂 *اختيار روابط المجلدات*\n\nحدد المجلدات المستهدفة.', keyboards.targetKeyboard(folders, next));
};

const handleFlowConfirm = async (ctx) => {
  const state = publishWizardState.getWizardState(uid(ctx));
  const accountIds = selected(state, 'accountIds');
  const adIds = selected(state, 'adIds');
  const folderIds = selected(state, 'targetIds');
  if (!accountIds.length || !adIds.length || !folderIds.length) return ctx.answerCbQuery('أكمل اختيار الحسابات والإعلانات والمجلدات').catch(() => {});
  const targets = folderIds.map((id) => folderQueries.getById(Number(id))).filter((f) => f?.invite_link).map((f) => f.invite_link);
  const mode = state.data.mode || 'direct';
  const task = taskQueries.create(uid(ctx), { name: mode === 'direct' ? 'نشر مباشر' : 'مهمة مجدولة', mode, account_ids: JSON.stringify(accountIds.map(Number)), target_type: 'folders', target_ids: JSON.stringify(targets), ad_ids: JSON.stringify(adIds.map(Number)), interval_seconds: mode === 'direct' ? 1 : 3600, status: mode === 'direct' ? 'running' : 'running', next_run_at: new Date().toISOString() });
  const created = taskQueries.getById(task.lastInsertRowid, uid(ctx));
  publishWizardState.resetWizard(uid(ctx));
  if (mode === 'direct') {
    await executeTaskStep(created);
    taskQueries.update(created.id, uid(ctx), { status: 'completed', last_run_at: new Date().toISOString() });
    return safeEdit(ctx, '✅ تم تنفيذ النشر المباشر وتسجيل النتيجة في السجل.', keyboards.publishMenuKeyboard());
  }
  return safeEdit(ctx, `✅ تمت جدولة المهمة رقم *${created.id}* وسيعمل التنفيذ تلقائيًا كل ساعة.`, keyboards.publishMenuKeyboard());
};

const handleDashboard = async (ctx) => {
  const stats = logQueries.getStatsSummary(uid(ctx));
  const tasks = taskQueries.getAll(uid(ctx));
  return safeEdit(ctx, `📊 *لوحة المتابعة*\n\n✅ ناجحة: ${stats.success}\n❌ فاشلة: ${stats.failed}\n⏳ مهام نشطة: ${tasks.filter((t) => t.status === 'running').length}\n📋 إجمالي المهام: ${tasks.length}`, keyboards.dashboardKeyboard());
};

const handlePublishLogs = async (ctx) => {
  const logs = logQueries.getRecent(uid(ctx), 10);
  let text = '📜 *سجل العمليات الأخير:*\n\n';
  text += logs.length ? logs.map((log) => `${log.result === 'success' ? '✅' : '❌'} [${log.created_at}] ${log.target_id}\n${log.detail || ''}`).join('\n') : 'لا توجد عمليات مسجلة حالياً.';
  return safeEdit(ctx, text, { reply_markup: { inline_keyboard: [[{ text: '⬅️ رجوع', callback_data: 'publish_menu' }]] } });
};

const handlePublishFolders = async (ctx) => {
  const folders = folderQueries.getAllByUserId(uid(ctx)).filter((folder) => folder.invite_link);
  if (!folders.length) return safeEdit(ctx, '📂 لا توجد روابط مجلدات محفوظة حتى الآن.', keyboards.publishMenuKeyboard());
  const rows = folders.map((folder) => [{ text: `🔗 ${folder.name || `مجلد ${folder.folder_number}`}`, callback_data: `publish_folder_link_${folder.id}` }]);
  rows.push([{ text: '⬅️ رجوع', callback_data: 'publish_menu' }]);
  return safeEdit(ctx, '📂 *روابط المجلدات المحفوظة*\n\nاختر مجلدًا لإرسال رابطه.', { reply_markup: { inline_keyboard: rows } });
};

const handleFolderLink = async (ctx, folderId) => {
  const folder = folderQueries.getById(folderId);
  if (!folder?.invite_link || String(folder.user_id) !== uid(ctx)) return ctx.answerCbQuery('الرابط غير متاح').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  return ctx.reply(`🔗 ${folder.name || 'رابط المجلد'}\n${folder.invite_link}`, { disable_web_page_preview: true });
};

const handlePublishSettings = async (ctx) => safeEdit(ctx, '⚙️ *إعدادات النشر*\n\nالفاصل الافتراضي للمهام المجدولة: ساعة واحدة.\nالنشر يعمل فقط بالحسابات المتصلة وروابط المجلدات التي تحتوي على رابط مشاركة.', keyboards.publishMenuKeyboard());

const handlePublishTextInput = async (ctx) => {
  const state = publishWizardState.getWizardState(uid(ctx));
  if (!state) return;
  const inputText = ctx.message.text || ctx.message.caption || '';
  if (state.step === WIZARD_STEPS.AWAITING_AD_CONTENT) {
    if (state.data.editingAdId) adQueries.update(state.data.editingAdId, uid(ctx), { text_content: inputText });
    else adQueries.create(uid(ctx), ctx.message.photo ? 'image' : ctx.message.document ? 'file' : 'text', inputText, ctx.message.photo?.at(-1)?.file_id || ctx.message.document?.file_id || null);
    publishWizardState.resetWizard(uid(ctx));
    await ctx.reply(state.data.editingAdId ? '✅ تم تعديل الإعلان.' : messages.adSaved());
    return handleAdsLibrary(ctx);
  }
};

module.exports = { handlePublishMenu, handleAdsLibrary, handleAdAddStart, handleAdView, handleAdDelete, handleAdConfirmDelete, handleAdEdit, handleAccountsSelect, handleAccountToggle, handleAccountsConfirm, beginPublish, handleAdSelect, handleFlowNext, handleTargetToggle, handleFlowConfirm, handlePublishFolders, handleFolderLink, handleDashboard, handlePublishLogs, handlePublishSettings, handlePublishTextInput };
