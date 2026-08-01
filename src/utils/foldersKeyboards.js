const { Markup } = require('telegraf');
const { statusLabel } = require('./foldersMessages');

// ─── Main Menu ────────────────────────────────────────────────────────────────

const foldersMenuKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📊 إحصائيات قاعدة البيانات', 'folders_stats')],
    [Markup.button.callback('🧩 تنظيم المجموعات الآن', 'folders_organize')],
    [Markup.button.callback('📁 عرض المجلدات', 'folders_list')],
    [Markup.button.callback('⚙️ إعدادات المجلدات', 'folders_settings')],
    [Markup.button.callback('⬅️ رجوع', 'main_menu')],
  ]);

const foldersBackKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('⬅️ رجوع', 'folders_menu')],
  ]);

const foldersStatsKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🧩 تنظيم المجموعات الآن', 'folders_organize')],
    [Markup.button.callback('⬅️ رجوع', 'folders_menu')],
  ]);

// ─── Folder List ──────────────────────────────────────────────────────────────

/**
 * @param {Array} folders  rows from folderQueries.getAllByUserId
 */
const foldersListKeyboard = (folders) => {
  const rows = folders.map((f) => {
    const label = `${f.name} — ${statusLabel(f.status)} (${f.groups_count}/${f.capacity})`;
    return [Markup.button.callback(label, `folder_detail_${f.id}`)];
  });
  rows.push([Markup.button.callback('⬅️ رجوع', 'folders_menu')]);
  return Markup.inlineKeyboard(rows);
};

const folderDetailKeyboard = (folder) => {
  const rows = [];
  if (folder.status === 'مكتمل' || folder.status === 'متوقف') {
    rows.push([Markup.button.callback('🔗 إنشاء/إعادة محاولة الرابط الآن', `folder_push_${folder.id}`)]);
  }
  rows.push([Markup.button.callback('🗑️ حذف المجلد', `folder_delete_confirm_${folder.id}`)]);
  rows.push([Markup.button.callback('⬅️ رجوع للمجلدات', 'folders_list')]);
  return Markup.inlineKeyboard(rows);
};

const folderDeleteConfirmKeyboard = (folderId) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ نعم، احذف', `folder_delete_yes_${folderId}`),
      Markup.button.callback('❌ إلغاء', `folder_detail_${folderId}`),
    ],
  ]);

// ─── Settings ─────────────────────────────────────────────────────────────────

const foldersSettingsKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('✏️ عدد المجموعات لكل مجلد', 'folders_edit_groups_per_folder')],
    [Markup.button.callback('⬅️ رجوع', 'folders_menu')],
  ]);

const foldersSettingsBackKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('⬅️ رجوع للإعدادات', 'folders_settings')],
  ]);

module.exports = {
  foldersMenuKeyboard,
  foldersBackKeyboard,
  foldersStatsKeyboard,
  foldersListKeyboard,
  folderDetailKeyboard,
  folderDeleteConfirmKeyboard,
  foldersSettingsKeyboard,
  foldersSettingsBackKeyboard,
};
