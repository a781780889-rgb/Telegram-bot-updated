// ─── Main Menu ────────────────────────────────────────────────────────────────

const foldersMenuMessage =
  `📁 *إدارة قاعدة البيانات المركزية ومجلدات تيليجرام*\n` +
  `${'─'.repeat(25)}\n\n` +
  `جميع روابط ومجموعات تيليجرام محفوظة في قاعدة بيانات مركزية واحدة،\n` +
  `تُستخدم من جميع الأقسام مع منع تام لأي تكرار.\n\n` +
  `من هنا يمكنك تنظيم المجموعات داخل مجلدات تيليجرام حقيقية\n` +
  `وإنشاء رابط خاص بكل مجلد لمشاركته.\n\n` +
  `اختر أحد الخيارات أدناه:`;

// ─── Central Stats ────────────────────────────────────────────────────────────

const foldersStatsMessage = (stats) =>
  `📊 *إحصائيات قاعدة البيانات المركزية*\n` +
  `${'─'.repeat(25)}\n\n` +
  `🔗 إجمالي الروابط: ${stats.totalLinks}\n` +
  `👥 إجمالي المجموعات الفريدة: ${stats.totalGroups}\n` +
  `📁 مجموعات داخل مجلدات: ${stats.groupsInFolders}\n` +
  `📤 مجموعات بانتظار التنظيم: ${stats.groupsUnfoldered}\n` +
  `⛔ روابط مكررة تم منعها: ${stats.duplicatesBlocked}\n` +
  `🚫 روابط غير صالحة: ${stats.invalidLinks}\n\n` +
  `📁 إجمالي المجلدات: ${stats.totalFolders}\n` +
  `✅ مجلدات مكتملة: ${stats.completedFolders}\n` +
  `🔗 مجلدات جاهزة للمشاركة: ${stats.readyFolders}`;

// ─── Folder List ──────────────────────────────────────────────────────────────

const STATUS_LABELS = {
  'قيد الإنشاء': '🟡 قيد الإنشاء',
  'مكتمل': '🟢 مكتمل',
  'جاهز للمشاركة': '🔗 جاهز للمشاركة',
  'متوقف': '🔴 متوقف',
};

const statusLabel = (status) => STATUS_LABELS[status] || status;

const foldersNoFoldersMessage =
  `📁 *لا توجد مجلدات بعد*\n\n` +
  `أضف روابط عبر "🔗 الانضمام للروابط" أولًا، ثم اضغط "🧩 تنظيم المجموعات الآن"\n` +
  `لبدء إنشاء المجلدات تلقائيًا من قاعدة البيانات المركزية.`;

const foldersListMessage =
  `📁 *قائمة المجلدات*\n` +
  `${'─'.repeat(25)}\n\n` +
  `اضغط على أي مجلد لعرض تفاصيله:`;

const folderDetailMessage = (folder, groupRows) => {
  const lines = [
    `📁 *${folder.name}*`,
    `${'─'.repeat(25)}`,
    '',
    `الحالة: ${statusLabel(folder.status)}`,
    `عدد المجموعات: ${folder.groups_count} / ${folder.capacity}`,
  ];
  if (folder.invite_link) lines.push(`رابط المجلد: ${folder.invite_link}`);
  if (folder.error_message) lines.push(`⚠️ آخر خطأ: ${folder.error_message}`);
  if (groupRows?.length) {
    lines.push('', '📋 آخر المجموعات المضافة:');
    for (const g of groupRows.slice(0, 10)) {
      lines.push(`• ${g.title || g.telegram_id}`);
    }
    if (groupRows.length > 10) lines.push(`… و${groupRows.length - 10} مجموعة أخرى`);
  }
  return lines.join('\n');
};

// ─── Organize / Pipeline ──────────────────────────────────────────────────────

const foldersOrganizeNoGroupsMessage =
  `⚠️ *لا توجد مجموعات جديدة للتنظيم*\n\n` +
  `جميع المجموعات في قاعدة البيانات المركزية منظمة داخل مجلدات بالفعل،\n` +
  `أو لا توجد مجموعات مسجّلة بعد.`;

const foldersOrganizeResultMessage = (result) => {
  const lines = [
    `🧩 *نتيجة عملية التنظيم*`,
    `${'─'.repeat(25)}`,
    '',
    `مجموعات تم تنظيمها الآن: ${result.groupsAssigned}`,
  ];

  if (result.foldersProcessed?.length) {
    lines.push('', '📁 المجلدات التي تمت معالجتها:');
    for (const f of result.foldersProcessed) {
      const icon = f.success ? '✅' : '❌';
      lines.push(`${icon} ${f.name}${f.success ? '' : ` — ${f.reason || 'فشل غير معروف'}`}`);
    }
  } else {
    lines.push('', 'لا توجد مجلدات مكتملة بعد (لم يصل أي مجلد لعدد المجموعات المطلوب).');
  }

  return lines.join('\n');
};

// ─── Settings ─────────────────────────────────────────────────────────────────

const foldersSettingsMessage = (settings) =>
  `⚙️ *إعدادات المجلدات*\n` +
  `${'─'.repeat(25)}\n\n` +
  `عدد المجموعات لكل مجلد: ${settings.groups_per_folder}\n\n` +
  `اختر الإعداد الذي تريد تعديله:`;

const foldersEditPromptMessages = {
  groups_per_folder: 'أرسل عدد المجموعات المطلوب لكل مجلد (رقم صحيح، الافتراضي `100`):',
};

module.exports = {
  foldersMenuMessage,
  foldersStatsMessage,
  foldersNoFoldersMessage,
  foldersListMessage,
  folderDetailMessage,
  foldersOrganizeNoGroupsMessage,
  foldersOrganizeResultMessage,
  foldersSettingsMessage,
  foldersEditPromptMessages,
  statusLabel,
};
