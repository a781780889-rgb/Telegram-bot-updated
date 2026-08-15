const { Markup } = require('telegraf');
const db = require('../database/userCodesDb');
const { botUserQueries } = require('../database/db');
const wizard = require('../services/userCodesWizardState');
const logger = require('../utils/logger');
const { mainMenuKeyboard } = require('../utils/keyboards');
const { activationKeyboard } = require('../middlewares/activationGuard');

const adminIds = () => new Set(String(process.env.ADMIN_TELEGRAM_IDS || '').split(',').map((value) => value.trim()).filter(Boolean));
const isAdmin = (ctx) => adminIds().has(String(ctx.from?.id));
const privateOnly = (ctx) => ctx.chat?.type === 'private';
const editOrReply = async (ctx, text, extra) => { try { if (ctx.callbackQuery) return await ctx.editMessageText(text, extra); } catch (_) {} return ctx.reply(text, extra); };
const typeLabel = (type) => ({ month: '📅 شهر', year: '📅 سنة', open: '♾️ مفتوح' }[type] || type);
const typeKeyboard = (prefix) => Markup.inlineKeyboard([
  [Markup.button.callback('📅 شهر', `${prefix}_month`)],
  [Markup.button.callback('📅 سنة', `${prefix}_year`)],
  [Markup.button.callback('♾️ مفتوح', `${prefix}_open`)],
  [Markup.button.callback('⬅️ إدارة الأكواد', 'codes_menu')],
]);
const adminMenuKeyboard = () => Markup.inlineKeyboard([
  [Markup.button.callback('🎟️ إنشاء كود', 'codes_create')],
  [Markup.button.callback('➕ إنشاء مجموعة أكواد', 'codes_batch')],
  [Markup.button.callback('📋 عرض الأكواد', 'codes_list')],
  [Markup.button.callback('🔎 بحث عن كود', 'codes_search')],
  [Markup.button.callback('📊 الإحصائيات', 'codes_stats')],
  [Markup.button.callback('📤 تصدير الأكواد', 'codes_export')],
  [Markup.button.callback('📁 ملفات نتائج البحث', 'admin_result_files')],
  [Markup.button.callback('👥 المستخدمون المفعلون', 'activated_users')],
  [Markup.button.callback('🚫 المستخدمون غير المفعلين', 'inactive_users')],
  [Markup.button.callback('🏠 الرئيسية', 'main_menu')],
]);
const codeActions = (id, status) => Markup.inlineKeyboard([
  [status === 'disabled' ? Markup.button.callback('✅ إعادة تفعيل', `code_enable_${id}`) : Markup.button.callback('⛔ تعطيل', `code_disable_${id}`)],
  [Markup.button.callback('🗑 حذف إن لم يُستخدم', `code_delete_${id}`)],
  [Markup.button.callback('⬅️ إدارة الأكواد', 'codes_menu')],
]);
const formatCode = (code) => `🎟️ *${code.code}*\n🗓 النوع: ${typeLabel(code.activation_type)}\n🔘 الحالة: ${code.status === 'active' ? 'متاح' : code.status === 'used' ? 'مستخدم' : 'معطل'}\n🆔 المستخدم: ${code.redeemed_by || '—'}\n🕒 الإنشاء: ${code.created_at}${code.redeemed_at ? `\n✅ الاستخدام: ${code.redeemed_at}` : ''}`;

const handleUseCodeStart = async (ctx) => { if (!privateOnly(ctx)) return; wizard.set(ctx.from.id, 'redeem'); await ctx.answerCbQuery(); await ctx.reply('أرسل كود التفعيل الخاص بك:'); };
const handleRedeemText = async (ctx) => {
  const current = wizard.get(ctx.from.id); if (!current || current.state !== 'redeem') return false;
  wizard.reset(ctx.from.id);
  const result = db.redeemCode(ctx.message.text, { telegramUserId: ctx.from.id, username: ctx.from.username, firstName: ctx.from.first_name });
  const messages = { invalid: '❌ كود التفعيل غير صحيح.\n\nيرجى التأكد من الكود وإعادة المحاولة.', not_found: '❌ كود التفعيل غير صحيح.\n\nيرجى التأكد من الكود وإعادة المحاولة.', disabled: '🚫 هذا الكود غير فعال حالياً.', used: '⚠️ هذا الكود تم استخدامه مسبقاً.', assigned: '❌ هذا الكود مرتبط بمستخدم آخر.' };
  if (!result.ok) { await ctx.reply(messages[result.reason] || '❌ تعذر استخدام الكود حالياً.', activationKeyboard()); return true; }
  const end = result.end ? result.end.toLocaleDateString('ar-EG') : '♾️ بدون انتهاء';
  await ctx.reply(`✅ تم تفعيل حسابك بنجاح\n\nنوع الاشتراك: ${typeLabel(result.activationType)}\nتاريخ البداية: ${result.start.toLocaleDateString('ar-EG')}\nتاريخ الانتهاء: ${end}\n\nيمكنك الآن استخدام البوت.`, mainMenuKeyboard(ctx.from.id));
  return true;
};

const handleCodesMenu = async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.', { show_alert: true }); await ctx.answerCbQuery(); await editOrReply(ctx, '🎟️ *إدارة الأكواد*\n\nاختر العملية المطلوبة:', { parse_mode: 'Markdown', ...adminMenuKeyboard() }); };
const handleCreateStart = async (ctx) => { if (!isAdmin(ctx)) return; wizard.reset(ctx.from.id); await ctx.answerCbQuery(); await editOrReply(ctx, '🎟️ *إنشاء كود*\n\nاختر نوع الكود:', { parse_mode: 'Markdown', ...typeKeyboard('code_type') }); };
const handleCreateType = async (ctx, type) => { if (!isAdmin(ctx)) return; const code = db.createCode({ activationType: type }, ctx.from.id); wizard.reset(ctx.from.id); await ctx.answerCbQuery('تم إنشاء الكود.'); await editOrReply(ctx, `✅ تم إنشاء كود جديد\n\n${formatCode(code)}\n\nانسخ الكود وأرسله للمستخدم.`, { parse_mode: 'Markdown', ...codeActions(code.id, code.status) }); };
const handleBatchStart = async (ctx) => { if (!isAdmin(ctx)) return; wizard.reset(ctx.from.id); await ctx.answerCbQuery(); await editOrReply(ctx, '➕ *إنشاء مجموعة أكواد*\n\nاختر نوع الأكواد:', { parse_mode: 'Markdown', ...typeKeyboard('batch_type') }); };
const handleBatchType = async (ctx, type) => { if (!isAdmin(ctx)) return; wizard.set(ctx.from.id, 'batch_count', { activationType: type }); await ctx.answerCbQuery(); await ctx.reply(`اختر عدد أكواد ${typeLabel(type)} بإرسال رقم من 1 إلى 10000:`); };
const handleCodeText = async (ctx) => {
  const current = wizard.get(ctx.from.id); if (!current || !['batch_count', 'search'].includes(current.state)) return false;
  try {
    if (current.state === 'batch_count') {
      const count = Number(ctx.message.text.trim());
      if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('أرسل رقماً بين 1 و10000.');
      const codes = db.createBatch({ count, activationType: current.data.activationType }, ctx.from.id);
      wizard.reset(ctx.from.id);
      await ctx.reply(`✅ تم إنشاء ${codes.length} كود من نوع ${typeLabel(current.data.activationType)}.\n\nأول كود: ${codes[0].code}\nيمكنك تصدير المجموعة من قائمة إدارة الأكواد.`, adminMenuKeyboard());
      return true;
    }
    const query = ctx.message.text.trim();
    const rows = db.listCodes(/^\d+$/.test(query) ? { userId: query } : { search: query });
    wizard.reset(ctx.from.id);
    await ctx.reply(rows.length ? rows.slice(0, 15).map(formatCode).join('\n\n') : 'لا توجد نتائج.', adminMenuKeyboard());
    return true;
  } catch (error) { logger.warn(`userCodes input rejected: ${error.message}`); await ctx.reply(`❌ ${error.message}`); return true; }
};
const handleCodesList = async (ctx) => { if (!isAdmin(ctx)) return; await ctx.answerCbQuery(); const rows = db.listCodes({ limit: 15 }); await editOrReply(ctx, rows.length ? `📋 الأكواد\n\n${rows.map(formatCode).join('\n\n')}` : 'لا توجد أكواد منشأة بعد.', { parse_mode: 'Markdown', ...adminMenuKeyboard() }); };
const handleCodesSearch = async (ctx) => { if (!isAdmin(ctx)) return; wizard.set(ctx.from.id, 'search'); await ctx.answerCbQuery(); await ctx.reply('أرسل الكود أو Telegram User ID للبحث.'); };
const handleCodesStats = async (ctx) => { if (!isAdmin(ctx)) return; await ctx.answerCbQuery(); const stats = db.stats(); const counts = Object.fromEntries(stats.counts.map((item) => [item.status, item.count])); const types = Object.fromEntries(stats.types.map((item) => [item.activation_type, item.count])); await editOrReply(ctx, `📊 *إحصائيات الأكواد*\n\nالإجمالي: ${Object.values(counts).reduce((sum, value) => sum + Number(value), 0)}\n✅ المتاحة: ${counts.active || 0}\n♻️ المستخدمة: ${counts.used || 0}\n⛔ المعطلة: ${counts.disabled || 0}\n\n📅 أكواد الشهر: ${types.month || 0}\n📅 أكواد السنة: ${types.year || 0}\n♾️ الأكواد المفتوحة: ${types.open || 0}\n\n🔁 إجمالي الاستخدامات: ${stats.totalRedemptions}`, { parse_mode: 'Markdown', ...adminMenuKeyboard() }); };
const handleCodesExport = async (ctx) => { if (!isAdmin(ctx)) return; await ctx.answerCbQuery(); const rows = db.listCodes({ limit: 10000 }); const body = ['id,code,type,status,telegram_user_id,created_at,redeemed_at', ...rows.map((row) => [row.id, row.code, row.activation_type, row.status, row.redeemed_by || '', row.created_at, row.redeemed_at || ''].join(','))].join('\n'); await ctx.replyWithDocument({ source: Buffer.from(body, 'utf8'), filename: `activation-codes-${Date.now()}.csv` }, adminMenuKeyboard()); };
const formatActivationUser = (user) => `🆔 ${user.telegram_user_id}${user.username ? ` @${user.username}` : ''}\n👤 ${user.first_name || 'بدون اسم'}\n📌 ${user.is_activated ? 'مفعل' : 'غير مفعل'}${user.activation_expires_at ? `\n⏳ ينتهي: ${user.activation_expires_at}` : ''}`;
const handleUsersList = async (ctx, activated) => { if (!isAdmin(ctx)) return; await ctx.answerCbQuery(); const rows = botUserQueries.listActivationUsers(activated); const text = `${activated ? '👥 المستخدمون المفعلون' : '🚫 المستخدمون غير المفعلين'}\n\n${rows.length ? rows.map(formatActivationUser).join('\n\n') : 'لا توجد بيانات.'}`; const buttons = rows.slice(0, 50).map((user) => [Markup.button.callback(activated ? `🚫 تعطيل ${user.telegram_user_id}` : `✅ تفعيل ${user.telegram_user_id}`, `${activated ? 'deactivate_user' : 'activate_user'}_${user.telegram_user_id}`)]); await editOrReply(ctx, text, { ...Markup.inlineKeyboard([...buttons, [Markup.button.callback('⬅️ إدارة الأكواد', 'codes_menu')]]) }); };
const handleUserActivationToggle = async (ctx, activated) => { if (!isAdmin(ctx)) return; const result = botUserQueries.setActivated(ctx.match[1], activated); await ctx.answerCbQuery(result.changes ? 'تم تحديث الحالة.' : 'المستخدم غير موجود.'); await handleUsersList(ctx, activated); };
const statusAction = (status) => async (ctx) => { if (!isAdmin(ctx)) return; const id = Number(ctx.match[1]); db.setStatus(id, status, ctx.from.id); await ctx.answerCbQuery('تم الحفظ.'); const code = db.getCode(id); await editOrReply(ctx, code ? formatCode(code) : 'الكود غير موجود.', { parse_mode: 'Markdown', ...codeActions(id, code?.status) }); };
const handleCodeDelete = async (ctx) => { if (!isAdmin(ctx)) return; const result = db.deleteCode(Number(ctx.match[1]), ctx.from.id); await ctx.answerCbQuery(result.changes ? 'تم الحذف.' : 'لا يمكن حذف كود مستخدم.'); await handleCodesList(ctx); };

module.exports = { isAdmin, handleUseCodeStart, handleRedeemText, handleCodesMenu, handleCreateStart, handleCreateType, handleBatchStart, handleBatchType, handleCodeText, handleCodesList, handleCodesSearch, handleCodesStats, handleCodesExport, handleUsersList, handleUserActivationToggle, handleCodeDisable: statusAction('disabled'), handleCodeEnable: statusAction('active'), handleCodeDelete };
