const { maskPhone } = require('./encryption');

// ─── Status Maps ──────────────────────────────────────────────────────────────

const statusEmoji = {
  connected: '🟢',
  connecting: '🔄',
  pending: '⏳',
  otp_sent: '📱',
  needs_password: '🔐',
  error: '🔴',
  banned: '🚫',
  disconnected: '⚪️',
};

const statusText = {
  connected: 'متصل',
  connecting: 'جارٍ الاتصال',
  pending: 'في الانتظار',
  otp_sent: 'بانتظار رمز التحقق',
  needs_password: 'يحتاج كلمة مرور',
  error: 'خطأ',
  banned: 'محظور',
  disconnected: 'غير متصل',
};

// ─── Menu Messages ────────────────────────────────────────────────────────────

const welcomeMessage = (firstName) =>
  `مرحبًا ${firstName || ''} 👋\n\nأنا بوت إدارة حسابات تيليجرام.\nيمكنني مساعدتك في إضافة وإدارة حسابات تيليجرام متعددة.\n\nاختر أحد الخيارات أدناه:`;

const helpMessage =
  `📖 *دليل الاستخدام*\n\n` +
  `*➕ إضافة حساب:*\n` +
  `1. اضغط على ➕ إضافة حساب\n` +
  `2. أدخل رقم هاتفك بالصيغة الدولية\n` +
  `   مثال: \`+967771234567\`\n` +
  `3. أدخل رمز التحقق المُرسَل لتطبيق تيليجرام\n` +
  `4. إذا كان لديك تحقق بخطوتين، أدخل كلمة المرور\n\n` +
  `*📋 عرض الحسابات:*\n` +
  `• اضغط على أي حساب لعرض تفاصيله وإدارته\n\n` +
  `*🔄 تحديث الحالات:*\n` +
  `• يتحقق من اتصال جميع حساباتك مباشرة\n\n` +
  `*📊 الإحصائيات:*\n` +
  `• إحصائيات شاملة عن جميع حساباتك\n\n` +
  `*ملاحظات:*\n` +
  `• يجب أن يكون رقم الهاتف مُسجَّلًا في تيليجرام\n` +
  `• رمز التحقق صالح لمدة 5 دقائق فقط\n` +
  `• لن يتم تخزين كلمة مرورك\n` +
  `• جلساتك محمية بتشفير قوي`;

// ─── Add Account Flow Messages ────────────────────────────────────────────────

const phoneRequestMessage =
  `📱 *إضافة حساب تيليجرام*\n\n` +
  `أدخل رقم هاتفك بالصيغة الدولية:\n\n` +
  `مثال: \`+967771234567\`\n\n` +
  `⚠️ سيصلك رمز التحقق داخل تطبيق تيليجرام إن كان الرقم مسجّل دخول في مكان آخر، وإلا فسيصلك برسالة SMS على نفس الرقم.`;

const otpRequestMessage = (phone, isCodeViaApp = false) =>
  `✉️ *تم إرسال رمز التحقق*\n\n` +
  (isCodeViaApp
    ? `تم إرسال رمز التحقق إلى *تطبيق تيليجرام* على الرقم:\n`
    : `تم إرسال رمز التحقق برسالة *SMS* إلى الرقم:\n`) +
  `\`${maskPhone(phone)}\`\n\n` +
  (isCodeViaApp
    ? `📲 *أين تجد الرمز؟*\n` +
      `افتح تطبيق تيليجرام على هاتفك ← ستجد رسالة جديدة من حساب *Telegram* في قائمة محادثاتك (يظهر عادةً في أعلى القائمة). الرمز مكون من 5 أرقام.\n\n` +
      `⚠️ *لم تصلك أي رسالة؟* هذا يعني أن الرقم لديه جلسة تسجيل دخول نشطة على جهاز آخر لا تملك الوصول إليه حاليًا. لحل ذلك:\n` +
      `1. افتح تيليجرام من أي جهاز تملك وصولاً له بنفس الرقم.\n` +
      `2. اذهب إلى: الإعدادات ← الأجهزة النشطة.\n` +
      `3. أنهِ جميع الجلسات الأخرى (خصوصًا أي جهاز لا تعرفه).\n` +
      `4. اضغط "لم يصلني الرمز" أدناه لإعادة المحاولة.\n\n`
    : `💡 إذا لم تصلك الرسالة خلال دقيقة، تحقق من صندوق الرسائل النصية أو من مكالمة فائتة تحمل الرمز.\n\n`) +
  `الرجاء إدخال الرمز المكون من 5 أرقام:\n\n` +
  `⏱ الرمز صالح لمدة 5 دقائق.`;

const passwordRequestMessage =
  `🔐 *التحقق بخطوتين مُفعَّل*\n\n` +
  `هذا الحساب يحتاج إلى كلمة مرور التحقق بخطوتين.\n\n` +
  `أدخل كلمة المرور:\n\n` +
  `🔒 سيتم حذف رسالتك فور الإرسال حمايةً لخصوصيتك.`;

const successMessage = (account) =>
  `✅ *تم تسجيل الدخول بنجاح!*\n\n` +
  `👤 *الاسم:* ${[account.first_name, account.last_name].filter(Boolean).join(' ') || 'غير محدد'}\n` +
  `🔹 *اسم المستخدم:* ${account.username ? `@${account.username}` : 'لا يوجد'}\n` +
  `📱 *الهاتف:* \`${maskPhone(account.phone)}\`\n` +
  `🟢 *الحالة:* متصل\n\n` +
  `تمت إضافة الحساب إلى قائمتك بنجاح.`;

// ─── Account List Messages ────────────────────────────────────────────────────

const noAccountsMessage =
  `📋 *قائمة الحسابات*\n\n` +
  `لا توجد حسابات مضافة بعد.\n` +
  `اضغط على ➕ لإضافة حساب جديد.`;

/**
 * Single account card for the list view
 * @param {object} account
 * @param {number} index
 */
const accountCardMessage = (account, index) => {
  const emoji = statusEmoji[account.status] || '⚪️';
  const statusLabel = statusText[account.status] || account.status;
  const name =
    [account.first_name, account.last_name].filter(Boolean).join(' ') ||
    'غير محدد';
  const username = account.username ? `@${account.username}` : 'لا يوجد';

  return (
    `*${index}. ${name}*\n` +
    `   📱 \`${maskPhone(account.phone)}\`\n` +
    `   👤 ${username}\n` +
    `   ${emoji} ${statusLabel}`
  );
};

/**
 * Full account detail message
 * @param {object} account
 */
const accountDetailMessage = (account) => {
  const emoji = statusEmoji[account.status] || '⚪️';
  const statusLabel = statusText[account.status] || account.status;
  const name =
    [account.first_name, account.last_name].filter(Boolean).join(' ') ||
    'غير محدد';
  const username = account.username ? `@${account.username}` : 'لا يوجد';
  const addedDate = new Date(account.created_at).toLocaleDateString('ar-SA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const updatedDate = new Date(account.updated_at).toLocaleDateString('ar-SA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  let text =
    `👤 *تفاصيل الحساب*\n` +
    `${'─'.repeat(25)}\n` +
    `*الاسم:* ${name}\n` +
    `*اسم المستخدم:* ${username}\n` +
    `*رقم الهاتف:* \`${maskPhone(account.phone)}\`\n` +
    `*الحالة:* ${emoji} ${statusLabel}\n` +
    `*تاريخ الإضافة:* ${addedDate}\n` +
    `*آخر تحديث:* ${updatedDate}`;

  if (account.telegram_id) {
    text += `\n*معرّف تيليجرام:* \`${account.telegram_id}\``;
  }

  if (account.error_message && account.status === 'error') {
    text += `\n\n⚠️ *سبب الخطأ:*\n${account.error_message.slice(0, 150)}`;
  }

  return text;
};

// ─── Accounts Menu Message ────────────────────────────────────────────────────

const accountsMenuMessage =
  `📂 *إدارة حسابات تيليجرام*\n\n` +
  `اختر الإجراء الذي تريد تنفيذه:`;

// ─── Status Refresh Messages ──────────────────────────────────────────────────

const refreshStartMessage = (count) =>
  `🔄 *جارٍ تحديث حالة ${count} حساب...*\n\n` +
  `⏳ قد يستغرق ذلك بعض الوقت، يرجى الانتظار.`;

/**
 * Build the full status refresh result message
 * @param {Array<{account: object, isAlive: boolean, error?: string}>} results
 */
const refreshResultMessage = (results) => {
  const connected = results.filter((r) => r.isAlive);
  const failed = results.filter((r) => !r.isAlive);

  let text =
    `✅ *اكتمل تحديث الحالات*\n` +
    `${'─'.repeat(25)}\n` +
    `🟢 متصل: ${connected.length}\n` +
    `🔴 غير متصل: ${failed.length}\n` +
    `📊 الإجمالي: ${results.length}\n`;

  if (connected.length > 0) {
    text += `\n*الحسابات المتصلة:*\n`;
    connected.forEach((r) => {
      const name =
        [r.account.first_name, r.account.last_name].filter(Boolean).join(' ') ||
        maskPhone(r.account.phone);
      text += `🟢 ${name}\n`;
    });
  }

  if (failed.length > 0) {
    text += `\n*الحسابات غير المتصلة:*\n`;
    failed.forEach((r) => {
      const name =
        [r.account.first_name, r.account.last_name].filter(Boolean).join(' ') ||
        maskPhone(r.account.phone);
      text += `🔴 ${name}\n`;
    });
  }

  return text;
};

// ─── Statistics Message ───────────────────────────────────────────────────────

/**
 * Build accounts statistics message
 * @param {object} stats
 */
const statsMessage = (stats) => {
  const { total, connected, disconnected, needsRelogin, addedToday } = stats;
  const inactive = total - connected;

  return (
    `📊 *إحصائيات الحسابات*\n` +
    `${'─'.repeat(25)}\n\n` +
    `📁 *إجمالي الحسابات:* ${total}\n` +
    `🟢 *الحسابات النشطة:* ${connected}\n` +
    `🔴 *الحسابات غير النشطة:* ${inactive}\n` +
    `🔄 *تحتاج إعادة تسجيل دخول:* ${needsRelogin}\n` +
    `📅 *مضافة اليوم:* ${addedToday}\n\n` +
    (total > 0
      ? `📈 *نسبة الاتصال:* ${Math.round((connected / total) * 100)}%`
      : `💡 لا توجد حسابات مضافة بعد.`)
  );
};

// ─── Edit Account Message ─────────────────────────────────────────────────────

/**
 * Edit account page message
 * @param {object} account
 */
const editAccountMessage = (account) => {
  const name =
    [account.first_name, account.last_name].filter(Boolean).join(' ') ||
    'غير محدد';
  return (
    `✏️ *تعديل الحساب*\n\n` +
    `*الحساب:* ${name}\n` +
    `*الهاتف:* \`${maskPhone(account.phone)}\`\n\n` +
    `اختر الإجراء المطلوب:`
  );
};

// ─── Error Messages ───────────────────────────────────────────────────────────

const errorOtpExpired =
  `⏱ *انتهت صلاحية رمز التحقق*\n\n` +
  `انتهت صلاحية الرمز. سيتم إرسال رمز جديد تلقائيًا.`;

const errorTooManyAttempts =
  `🚫 *محاولات كثيرة جدًا*\n\n` +
  `لقد تجاوزت الحد الأقصى لمحاولات إدخال الرمز.\n` +
  `الرجاء البدء من جديد.`;

module.exports = {
  // Status maps
  statusEmoji,
  statusText,
  // Menu
  welcomeMessage,
  helpMessage,
  accountsMenuMessage,
  // Add account flow
  phoneRequestMessage,
  otpRequestMessage,
  passwordRequestMessage,
  successMessage,
  // Account list/detail
  accountCardMessage,
  accountDetailMessage,
  noAccountsMessage,
  // Refresh
  refreshStartMessage,
  refreshResultMessage,
  // Stats
  statsMessage,
  // Edit
  editAccountMessage,
  // Errors
  errorOtpExpired,
  errorTooManyAttempts,
};
