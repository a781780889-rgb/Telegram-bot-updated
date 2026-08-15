const { Markup } = require('telegraf');
const db = require('../database/userCodesDb');
const wizard = require('../services/userCodesWizardState');
const logger = require('../utils/logger');

const adminIds = () => new Set(String(process.env.ADMIN_TELEGRAM_IDS || '').split(',').map((v) => v.trim()).filter(Boolean));
const isAdmin = (ctx) => adminIds().has(String(ctx.from?.id));
const privateOnly = (ctx) => ctx.chat?.type === 'private';
const editOrReply = async (ctx, text, extra) => {
  try { if (ctx.callbackQuery) return await ctx.editMessageText(text, extra); } catch (_) {}
  return ctx.reply(text, extra);
};
const backMain = () => Markup.inlineKeyboard([[Markup.button.callback('🏠 القائمة الرئيسية', 'main_menu')]]);
const adminMenuKeyboard = () => Markup.inlineKeyboard([
  [Markup.button.callback('➕ إنشاء كود', 'codes_create')],
  [Markup.button.callback('📦 إنشاء مجموعة', 'codes_batch')],
  [Markup.button.callback('📋 عرض الأكواد', 'codes_list')],
  [Markup.button.callback('🔎 بحث عن كود', 'codes_search')],
  [Markup.button.callback('📊 الإحصائيات', 'codes_stats')],
  [Markup.button.callback('📤 تصدير الأكواد', 'codes_export')],
  [Markup.button.callback('🏠 الرئيسية', 'main_menu')],
]);
const codeActions = (id, status) => Markup.inlineKeyboard([
  [status === 'disabled' ? Markup.button.callback('✅ إعادة تفعيل', `code_enable_${id}`) : Markup.button.callback('⛔ تعطيل', `code_disable_${id}`)],
  [Markup.button.callback('🗑 حذف إن لم يُستخدم', `code_delete_${id}`)],
  [Markup.button.callback('⬅️ إدارة الأكواد', 'codes_menu')],
]);
const formatCode = (c) => `🎟️ *${c.code}*\n📦 ${c.package_name}\n📅 المدة: ${c.duration_days} يوم\n📈 الاستخدام: ${c.uses_count}/${c.max_uses}\n🔘 الحالة: ${c.status}\n🕒 الإنشاء: ${c.created_at}${c.expires_at ? `\n⏳ ينتهي: ${c.expires_at}` : ''}`;

const handleUseCodeStart = async (ctx) => { if (!privateOnly(ctx)) return; wizard.set(ctx.from.id, 'redeem'); await ctx.answerCbQuery(); await ctx.reply('أرسل الكود الذي حصلت عليه:\n\nيمكنك إلغاء العملية من خلال /menu.'); };
const handleRedeemText = async (ctx) => {
  const value = wizard.get(ctx.from.id); if (!value || value.state !== 'redeem') return false;
  wizard.reset(ctx.from.id);
  const result = db.redeemCode(ctx.message.text, { telegramUserId: ctx.from.id, username: ctx.from.username, firstName: ctx.from.first_name });
  const messages = { invalid: '❌ صيغة الكود غير صحيحة.', not_found: '❌ الكود غير موجود.', disabled: '❌ هذا الكود معطل.', expired: '❌ انتهت صلاحية هذا الكود.', limit: '❌ تم استنفاد عدد مرات استخدام هذا الكود.', assigned: '❌ هذا الكود مرتبط بمستخدم آخر.', duplicate: '❌ لقد استخدمت هذا الكود مسبقاً.' };
  if (!result.ok) { await ctx.reply(messages[result.reason] || '❌ تعذر استخدام الكود حالياً.', backMain()); return true; }
  await ctx.reply(`✅ تم تفعيل الكود بنجاح\n\n🎟️ الكود: ${result.code.code}\n📦 الباقة: ${result.code.package_name}\n⏳ المدة: ${result.code.duration_days} يوم\n📅 ينتهي في: ${result.end.toLocaleDateString('ar-EG')}`, backMain());
  return true;
};

const handleCodesMenu = async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.', { show_alert: true }); await ctx.answerCbQuery(); await editOrReply(ctx, '🎟️ *نظام الأكواد*\n\nاختر العملية المطلوبة:', { parse_mode: 'Markdown', ...adminMenuKeyboard() }); };
const handleCreateStart = async (ctx) => { if (!isAdmin(ctx)) return; wizard.set(ctx.from.id, 'create', { step: 1 }); await ctx.answerCbQuery(); await ctx.reply('أرسل بيانات الكود بهذا الشكل:\n`الباقة | المدة بالأيام | عدد الاستخدامات | اسم اختياري`\n\nمثال: `premium | 30 | 1 | حملة الصيف`', { parse_mode: 'Markdown' }); };
const handleBatchStart = async (ctx) => { if (!isAdmin(ctx)) return; wizard.set(ctx.from.id, 'batch', { step: 1 }); await ctx.answerCbQuery(); await ctx.reply('أرسل بيانات المجموعة بهذا الشكل:\n`العدد | الباقة | المدة بالأيام | الاستخدامات لكل كود`\n\nمثال: `1000 | premium | 30 | 1`'); };
const parseCreate = (text) => { const [pkg, duration, maxUses, name] = text.split('|').map((v) => v.trim()); if (!pkg || !Number.isInteger(Number(duration)) || Number(duration) < 1 || !Number.isInteger(Number(maxUses)) || Number(maxUses) < 1) return null; return { package: pkg, durationDays: Number(duration), maxUses: Number(maxUses), singleUse: Number(maxUses) === 1, name: name || null }; };
const handleCodeText = async (ctx) => {
  const current = wizard.get(ctx.from.id); if (!current || !['create', 'batch', 'search'].includes(current.state)) return false;
  try {
    if (current.state === 'create') { const parsed = parseCreate(ctx.message.text); if (!parsed) throw new Error('الصيغة غير صحيحة.'); const code = db.createCode(parsed, ctx.from.id); wizard.reset(ctx.from.id); await ctx.reply(`✅ تم إنشاء الكود بنجاح\n\n${formatCode(code)}`, { parse_mode: 'Markdown', ...codeActions(code.id, code.status) }); return true; }
    if (current.state === 'batch') { const [count, pkg, duration, maxUses] = ctx.message.text.split('|').map((v) => v.trim()); const codes = db.createBatch({ count: Number(count), package: pkg, durationDays: Number(duration), maxUses: Number(maxUses), singleUse: Number(maxUses) === 1 }, ctx.from.id); wizard.reset(ctx.from.id); await ctx.reply(`✅ تم إنشاء ${codes.length} كود بشكل آمن وفريد.\n\nأول كود: ${codes[0].code}\nيمكنك تصدير المجموعة من قائمة الأكواد.`, adminMenuKeyboard()); return true; }
    const query = ctx.message.text.trim();
    const rows = db.listCodes(/^\d+$/.test(query) ? { userId: query } : { search: query });
    wizard.reset(ctx.from.id); await ctx.reply(rows.length ? rows.slice(0, 10).map(formatCode).join('\n\n') : 'لا توجد نتائج.', adminMenuKeyboard()); return true;
  } catch (error) { logger.warn(`userCodes input rejected: ${error.message}`); await ctx.reply(`❌ ${error.message}\nأعد الإرسال بالصيغة المطلوبة أو استخدم /menu.`); return true; }
};
const handleCodesList = async (ctx) => { if (!isAdmin(ctx)) return; await ctx.answerCbQuery(); const rows = db.listCodes({ limit: 15 }); await editOrReply(ctx, rows.length ? `📋 الأكواد (${rows.length} نتيجة)\n\n${rows.map(formatCode).join('\n\n')}` : 'لا توجد أكواد منشأة بعد.', { parse_mode: 'Markdown', ...adminMenuKeyboard() }); };
const handleCodesSearch = async (ctx) => { if (!isAdmin(ctx)) return; wizard.set(ctx.from.id, 'search'); await ctx.answerCbQuery(); await ctx.reply('أرسل جزءاً من الكود أو اسم الكود أو Telegram User ID للبحث.'); };
const handleCodesStats = async (ctx) => { if (!isAdmin(ctx)) return; await ctx.answerCbQuery(); const s = db.stats(); const counts = Object.fromEntries(s.counts.map((x) => [x.status, x.count])); await editOrReply(ctx, `📊 *إحصائيات الأكواد*\n\nالإجمالي: ${Object.values(counts).reduce((a,b) => a + Number(b), 0)}\n✅ فعالة: ${counts.active || 0}\n♻️ مستخدمة: ${counts.used || 0}\n⏳ منتهية: ${counts.expired || 0}\n⛔ معطلة: ${counts.disabled || 0}\n🔁 إجمالي الاستردادات: ${s.totalRedemptions}\n\nالأكثر استخداماً:\n${s.topPackages.map((p) => `• ${p.name}: ${p.count}`).join('\n') || 'لا توجد بيانات'}`, { parse_mode: 'Markdown', ...adminMenuKeyboard() }); };
const handleCodesExport = async (ctx) => { if (!isAdmin(ctx)) return; await ctx.answerCbQuery(); const rows = db.listCodes({ limit: 10000 }); const body = ['id,code,package,status,uses,max_uses,created_at,expires_at', ...rows.map((r) => [r.id, r.code, r.package_slug, r.status, r.uses_count, r.max_uses, r.created_at, r.expires_at || ''].join(','))].join('\n'); await ctx.replyWithDocument({ source: Buffer.from(body, 'utf8'), filename: `user-codes-${Date.now()}.csv` }, adminMenuKeyboard()); };
const statusAction = (status) => async (ctx) => { if (!isAdmin(ctx)) return; const id = Number(ctx.match[1]); db.setStatus(id, status, ctx.from.id); await ctx.answerCbQuery('تم الحفظ.'); const code = db.getCode(id); await editOrReply(ctx, code ? formatCode(code) : 'الكود غير موجود.', { parse_mode: 'Markdown', ...codeActions(id, code?.status) }); };
const handleCodeDelete = async (ctx) => { if (!isAdmin(ctx)) return; const result = db.deleteCode(Number(ctx.match[1]), ctx.from.id); await ctx.answerCbQuery(result.changes ? 'تم الحذف.' : 'لا يمكن حذف كود مستخدم.'); await handleCodesList(ctx); };

module.exports = { isAdmin, handleUseCodeStart, handleRedeemText, handleCodesMenu, handleCreateStart, handleBatchStart, handleCodeText, handleCodesList, handleCodesSearch, handleCodesStats, handleCodesExport, handleCodeDisable: statusAction('disabled'), handleCodeEnable: statusAction('active'), handleCodeDelete };
