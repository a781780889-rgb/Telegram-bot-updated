// ─── Links Section Messages ───────────────────────────────────────────────────

const linksMenuMessage =
  `🔗 *قسم الروابط*\n` +
  `${'─'.repeat(25)}\n\n` +
  `مرحبًا في قسم البحث وجمع الروابط.\n` +
  `يمكنك البحث عن روابط تيليجرام وواتساب من جميع حساباتك المضافة.\n\n` +
  `اختر أحد الخيارات أدناه:`;

// ─── Wizard Steps ─────────────────────────────────────────────────────────────

const linksStep1Message =
  `🔍 *بدء البحث عن الروابط*\n` +
  `${'─'.repeat(25)}\n\n` +
  `*الخطوة 1 — تحديد الحسابات*\n\n` +
  `اختر الحسابات التي سيتم البحث من خلالها:`;

const linksStep2Message =
  `🔍 *بدء البحث عن الروابط*\n` +
  `${'─'.repeat(25)}\n\n` +
  `*الخطوة 2 — نوع الروابط*\n\n` +
  `اختر نوع الروابط المطلوب البحث عنها:`;

const linksStepTelegramSubtypeMessage =
  `🔍 *بدء البحث عن الروابط*\n` +
  `${'─'.repeat(25)}\n\n` +
  `*الخطوة 3 — تفصيل روابط تيليجرام*\n\n` +
  `اختر أنواع روابط تيليجرام المطلوبة:\n` +
  `_(يمكنك اختيار أكثر من نوع)_`;

const linksStepWhatsappSubtypeMessage =
  `🔍 *بدء البحث عن الروابط*\n` +
  `${'─'.repeat(25)}\n\n` +
  `*الخطوة 3 — تفصيل روابط واتساب*\n\n` +
  `اختر أنواع روابط واتساب المطلوبة:\n` +
  `_(يمكنك اختيار أكثر من نوع)_`;

const linksStep3Message =
  `🔍 *بدء البحث عن الروابط*\n` +
  `${'─'.repeat(25)}\n\n` +
  `*الخطوة 4 — الفترة الزمنية*\n\n` +
  `اختر الفترة الزمنية للبحث:`;

const linksStep3CustomDateMessage =
  `🔍 *تحديد فترة مخصصة*\n\n` +
  `أدخل تاريخ البداية بالصيغة:\n` +
  `\`YYYY-MM-DD\`\n` +
  `مثال: \`2024-01-01\``;

const linksStep3CustomEndMessage =
  `🔍 *تحديد فترة مخصصة*\n\n` +
  `أدخل تاريخ النهاية بالصيغة:\n` +
  `\`YYYY-MM-DD\`\n` +
  `مثال: \`2024-12-31\``;

const linksStep4Message =
  `🔍 *بدء البحث عن الروابط*\n` +
  `${'─'.repeat(25)}\n\n` +
  `*الخطوة 5 — مستوى البحث*\n\n` +
  `اختر مستوى البحث المناسب:\n\n` +
  `⚡ *بحث سريع* — يفحص آخر 100 رسالة لكل محادثة\n` +
  `   سريع جدًا لكن قد يفوت بعض الروابط القديمة\n\n` +
  `🔍 *بحث متوسط* — يفحص آخر 500 رسالة لكل محادثة\n` +
  `   توازن مثالي بين السرعة والدقة\n\n` +
  `🔬 *بحث عميق* — يفحص جميع الرسائل\n` +
  `   الأكثر شمولًا لكنه أبطأ`;

/**
 * Build step review message (final confirmation)
 * @param {object} wizard - wizard state
 * @param {Array}  accounts - list of selected accounts
 */
const linksStep5ReviewMessage = (wizard, accounts) => {
  const accountsLabel   = _accountsLabel(wizard, accounts);
  const typeLabel       = _typeLabel(wizard.linkType);
  const tgSubLabel      = _tgSubLabel(wizard.telegramSubTypes, wizard.linkType);
  const waSubLabel      = _waSubLabel(wizard.whatsappSubTypes, wizard.linkType);
  const periodLabel     = _periodLabel(wizard);
  const depthLabel      = _depthLabel(wizard.searchDepth);

  let subLines = '';
  if (tgSubLabel) subLines += `📱 *تيليجرام:* ${tgSubLabel}\n`;
  if (waSubLabel) subLines += `💬 *واتساب:* ${waSubLabel}\n`;

  return (
    `🔍 *مراجعة إعدادات البحث*\n` +
    `${'─'.repeat(25)}\n\n` +
    `*الخطوة الأخيرة — مراجعة ونبدأ*\n\n` +
    `👥 *الحسابات:* ${accountsLabel}\n` +
    `🔗 *نوع الروابط:* ${typeLabel}\n` +
    subLines +
    `📅 *الفترة الزمنية:* ${periodLabel}\n` +
    `⚙️ *مستوى البحث:* ${depthLabel}\n\n` +
    `هل تريد بدء البحث بهذه الإعدادات؟`
  );
};

// ─── Live Search Screen ───────────────────────────────────────────────────────

/**
 * Build the live search progress message
 * @param {object} progress
 */
const linksLiveProgressMessage = (progress) => {
  const bar      = _buildProgressBar(progress.percent || 0);
  const elapsed  = _formatDuration(progress.elapsedSeconds || 0);
  const eta      = progress.etaSeconds != null ? _formatDuration(progress.etaSeconds) : '—';
  const speed    = progress.speed ? `${progress.speed} رسالة/ث` : '—';
  const lastLink = progress.lastLink
    ? `\n🔗 آخر رابط: \`${progress.lastLink.slice(0, 45)}\``
    : '';
  const lastAction = progress.lastAction ? `\n⚡ ${progress.lastAction}` : '';

  return (
    `🔍 *البحث جارٍ...*\n` +
    `${'─'.repeat(25)}\n\n` +
    `👤 الحساب الحالي: *${progress.currentAccount || '—'}*\n` +
    `✅ الحسابات المنتهية: ${progress.doneAccounts || 0}\n` +
    `⏳ الحسابات المتبقية: ${progress.remainingAccounts || 0}\n\n` +
    `📨 الرسائل المفحوصة: ${_fmt(progress.scannedMessages)}\n` +
    `💬 المحادثات المفحوصة: ${_fmt(progress.scannedChats)}\n\n` +
    `🔗 الروابط المُعثور عليها: ${_fmt(progress.totalLinks)}\n` +
    `📱 روابط تيليجرام: ${_fmt(progress.telegramLinks)}\n` +
    `💬 روابط واتساب: ${_fmt(progress.whatsappLinks)}\n` +
    `🗑 مكررة محذوفة: ${_fmt(progress.duplicatesRemoved)}\n` +
    `🆕 روابط جديدة: ${_fmt(progress.newLinks)}\n` +
    `💾 محفوظة: ${_fmt(progress.savedLinks)}\n\n` +
    `⚡ السرعة: ${speed}\n` +
    `⏱ الوقت المنقضي: ${elapsed}\n` +
    `🏁 الوقت المتوقع: ${eta}\n` +
    `📈 نسبة الإنجاز: ${progress.percent || 0}%\n\n` +
    `${bar}` +
    lastAction +
    lastLink
  );
};

// ─── Final Results ────────────────────────────────────────────────────────────

const linksFinalResultsMessage = (results) => {
  const duration  = _formatDuration(results.durationSeconds || 0);
  const startTime = results.startedAt
    ? new Date(results.startedAt).toLocaleString('ar-SA')
    : '—';
  const endTime   = results.finishedAt
    ? new Date(results.finishedAt).toLocaleString('ar-SA')
    : '—';

  return (
    `✅ *اكتمل البحث بنجاح!*\n` +
    `${'─'.repeat(25)}\n\n` +
    `👥 الحسابات التي تم البحث فيها: ${_fmt(results.accountsSearched)}\n` +
    `💬 المحادثات التي تم فحصها: ${_fmt(results.chatsScanned)}\n` +
    `📨 الرسائل التي تم تحليلها: ${_fmt(results.messagesScanned)}\n\n` +
    `📱 روابط تيليجرام: ${_fmt(results.telegramLinks)}\n` +
    `💬 روابط واتساب: ${_fmt(results.whatsappLinks)}\n` +
    `🔗 إجمالي الروابط: ${_fmt(results.totalLinks)}\n` +
    `🗑 مكررة محذوفة: ${_fmt(results.duplicatesRemoved)}\n` +
    `💾 الروابط النهائية المحفوظة: ${_fmt(results.savedLinks)}\n\n` +
    `⏱ مدة البحث: ${duration}\n` +
    `🕐 وقت البداية: ${startTime}\n` +
    `🕑 وقت الانتهاء: ${endTime}`
  );
};

// ─── Extracted Files ──────────────────────────────────────────────────────────

const linksNoFilesMessage =
  `📂 *الملفات المستخرجة*\n` +
  `${'─'.repeat(25)}\n\n` +
  `لا توجد ملفات مستخرجة بعد.\n` +
  `ابدأ بحثًا جديدًا لاستخراج الروابط.`;

const linksFilesListMessage = (operations) => {
  let text =
    `📂 *الملفات المستخرجة*\n` +
    `${'─'.repeat(25)}\n\n` +
    `إجمالي العمليات: ${operations.length}\n\n`;

  operations.forEach((op, i) => {
    const date = new Date(op.created_at).toLocaleDateString('ar-SA');
    const time = new Date(op.created_at).toLocaleTimeString('ar-SA');
    text +=
      `*${i + 1}. ${op.name}*\n` +
      `   📅 ${date} — 🕐 ${time}\n` +
      `   🔗 ${_fmt(op.total_links)} رابط` +
      ` (تيليجرام: ${_fmt(op.telegram_links)} | واتساب: ${_fmt(op.whatsapp_links)})\n` +
      `   🗑 مكررة: ${_fmt(op.duplicates_removed)} | 💾 ${_fmtSize(op.file_size_bytes)}\n\n`;
  });

  return text;
};

const linksOperationDetailMessage = (op) => {
  const date = new Date(op.created_at).toLocaleString('ar-SA');
  return (
    `📁 *${op.name}*\n` +
    `${'─'.repeat(25)}\n\n` +
    `📅 تاريخ الإنشاء: ${date}\n` +
    `🔗 إجمالي الروابط: ${_fmt(op.total_links)}\n` +
    `📱 روابط تيليجرام: ${_fmt(op.telegram_links)}\n` +
    `💬 روابط واتساب: ${_fmt(op.whatsapp_links)}\n` +
    `🗑 مكررة محذوفة: ${_fmt(op.duplicates_removed)}\n` +
    `💾 حجم الملفات: ${_fmtSize(op.file_size_bytes)}\n\n` +
    `اختر الإجراء المطلوب:`
  );
};

// ─── Statistics ───────────────────────────────────────────────────────────────

const linksStatisticsMessage = (stats) => {
  const lastSearch = stats.last_search
    ? new Date(stats.last_search).toLocaleString('ar-SA')
    : 'لا يوجد';

  return (
    `📊 *إحصائيات قسم الروابط*\n` +
    `${'─'.repeat(25)}\n\n` +
    `🔍 إجمالي عمليات البحث: ${_fmt(stats.total_operations)}\n` +
    `🔗 إجمالي الروابط: ${_fmt(stats.total_links)}\n` +
    `📱 إجمالي روابط تيليجرام: ${_fmt(stats.total_telegram)}\n` +
    `💬 إجمالي روابط واتساب: ${_fmt(stats.total_whatsapp)}\n` +
    `🗑 إجمالي المكررة المحذوفة: ${_fmt(stats.total_duplicates)}\n` +
    `👥 الحسابات المستخدمة: ${_fmt(stats.accounts_used)}\n` +
    `🕐 آخر عملية بحث: ${lastSearch}\n` +
    `⚡ متوسط سرعة البحث: ${stats.avg_speed ? stats.avg_speed + ' رسالة/ث' : '—'}`
  );
};

// ─── Settings ─────────────────────────────────────────────────────────────────

const linksSettingsMessage =
  `⚙️ *إعدادات البحث*\n` +
  `${'─'.repeat(25)}\n\n` +
  `يمكنك تخصيص سلوك محرك البحث من هنا:`;

// ─── History ──────────────────────────────────────────────────────────────────

const linksNoHistoryMessage =
  `📜 *سجل عمليات البحث*\n` +
  `${'─'.repeat(25)}\n\n` +
  `لا توجد سجلات بعد.`;

const linksHistoryMessage = (history) => {
  let text = `📜 *سجل عمليات البحث*\n${'─'.repeat(25)}\n\n`;

  history.forEach((op, i) => {
    const startTime = new Date(op.started_at).toLocaleString('ar-SA');
    const endTime   = op.finished_at
      ? new Date(op.finished_at).toLocaleString('ar-SA')
      : '—';
    const statusEmoji =
      op.status === 'completed' ? '✅' : op.status === 'stopped' ? '⏹' : '❌';

    text +=
      `*${i + 1}.* ${statusEmoji} ${op.name}\n` +
      `   🕐 بداية: ${startTime}\n` +
      `   🕑 نهاية: ${endTime}\n` +
      `   👥 حسابات: ${op.accounts_used || '—'} | 🔗 روابط: ${_fmt(op.total_links)}\n`;

    if (op.error_message) {
      text += `   ⚠️ خطأ: ${op.error_message.slice(0, 60)}\n`;
    }
    text += '\n';
  });

  return text;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const _fmt = (n) => (n != null ? Number(n).toLocaleString('ar') : '0');

const _fmtSize = (bytes) => {
  if (!bytes) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

const _formatDuration = (seconds) => {
  if (!seconds) return '0 ث';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (h) parts.push(`${h} س`);
  if (m) parts.push(`${m} د`);
  parts.push(`${s} ث`);
  return parts.join(' ');
};

const _buildProgressBar = (percent) => {
  const total  = 20;
  const filled = Math.round((percent / 100) * total);
  const empty  = total - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${percent}%`;
};

const _accountsLabel = (wizard, accounts) => {
  if (wizard.accountMode === 'all') return 'جميع الحسابات';
  if (!accounts || !accounts.length) return '—';
  if (accounts.length === 1) return accounts[0].first_name || accounts[0].phone;
  return `${accounts.length} حسابات`;
};

const _typeLabel = (type) => {
  const map = {
    both: 'تيليجرام + واتساب',
    telegram: 'تيليجرام فقط',
    whatsapp: 'واتساب فقط',
  };
  return map[type] || '—';
};

const _tgSubLabel = (subs, linkType) => {
  if (!linkType || linkType === 'whatsapp') return null;
  if (!subs || !subs.length) return '—';
  if (subs.includes('all')) return 'الكل';
  const map = {
    public_group: 'مجموعات عامة',
    channel: 'قنوات',
    private_group: 'مجموعات خاصة',
  };
  return subs.map((v) => map[v] || v).join(' + ');
};

const _waSubLabel = (subs, linkType) => {
  if (!linkType || linkType === 'telegram') return null;
  if (!subs || !subs.length) return '—';
  if (subs.includes('all')) return 'الكل';
  const map = { group: 'مجموعات', channel: 'قنوات' };
  return subs.map((v) => map[v] || v).join(' + ');
};

const _periodLabel = (wizard) => {
  const map = {
    day:      'آخر يوم',
    week:     'آخر أسبوع',
    month:    'آخر شهر',
    '3months':'آخر 3 أشهر',
    year:     'آخر سنة',
    custom:   `${wizard.customStart || '—'} إلى ${wizard.customEnd || '—'}`,
  };
  return map[wizard.period] || '—';
};

const _depthLabel = (depth) => {
  const map = {
    fast:   '⚡ سريع',
    medium: '🔍 متوسط',
    deep:   '🔬 عميق',
  };
  return map[depth] || '—';
};

module.exports = {
  linksMenuMessage,
  linksStep1Message,
  linksStep2Message,
  linksStepTelegramSubtypeMessage,
  linksStepWhatsappSubtypeMessage,
  linksStep3Message,
  linksStep3CustomDateMessage,
  linksStep3CustomEndMessage,
  linksStep4Message,
  linksStep5ReviewMessage,
  linksLiveProgressMessage,
  linksFinalResultsMessage,
  linksNoFilesMessage,
  linksFilesListMessage,
  linksOperationDetailMessage,
  linksStatisticsMessage,
  linksSettingsMessage,
  linksNoHistoryMessage,
  linksHistoryMessage,
};
