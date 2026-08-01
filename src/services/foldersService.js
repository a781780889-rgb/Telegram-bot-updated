/**
 * Telegram Folders Service (قسم إنشاء مجلدات تيليجرام)
 *
 * Organizes groups from the CENTRAL groups database (join_groups) into
 * Telegram Folders (Dialog Filters), creating a real folder on Telegram
 * via MTProto (GramJS) and generating a shareable folder link (Chatlist
 * invite) once the folder is complete.
 *
 * Rules enforced (per the mandatory spec):
 *   - Groups are pulled ONLY from the central DB (join_groups).
 *   - A group can never be placed in more than one folder
 *     (UNIQUE(user_id, group_id) on tg_folder_groups).
 *   - Each folder holds `groups_per_folder` groups (default 100).
 *   - When a folder is full, a new one is created automatically.
 *   - Every action / error is logged via joinLogQueries so it is visible
 *     in the existing "📜 سجل العمليات" screen.
 */

const { Api } = require('telegram');
const logger = require('../utils/logger');
const { accountQueries } = require('../database/db');
const {
  folderQueries,
  folderGroupQueries,
  folderSettingsQueries,
  joinGroupQueries,
  joinLogQueries,
} = require('../database/joinDb');
const { loadSession, restoreSessionFile } = require('./telegramClient');

// ─── Client acquisition (mirrors joinService.getClientForAccount) ────────────

const getClientForAccount = async (account) => {
  const sessionFile = restoreSessionFile(account) || account.session_file;
  if (!sessionFile) throw new Error('NO_SESSION_FILE');
  return loadSession(sessionFile);
};

/**
 * Pick the account to use for folder creation: explicit override, else the
 * user's configured default, else the first connected account found.
 * @param {string} userId
 * @param {number} [preferredAccountId]
 */
const pickAccount = (userId, preferredAccountId) => {
  const settings = folderSettingsQueries.get(userId);
  const candidateId = preferredAccountId || settings.default_account_id;

  if (candidateId) {
    const acc = accountQueries.getById(candidateId);
    if (acc && acc.status === 'connected') return acc;
  }

  const all = accountQueries.getAllByUserId(userId);
  return all.find((a) => a.status === 'connected') || null;
};

// ─── Folder build (DB-level grouping, capacity = 100 by default) ────────────

/**
 * Assign as many unfoldered central groups as possible into folders,
 * creating new folder rows as needed, WITHOUT yet touching Telegram itself.
 * This is pure DB bookkeeping — safe to call repeatedly / idempotently.
 *
 * @param {string} userId
 * @returns {{ foldersTouched: object[], groupsAssigned: number }}
 */
const organizeGroupsIntoFolders = (userId) => {
  const settings = folderSettingsQueries.get(userId);
  const capacity = settings.groups_per_folder || 100;

  let assigned = 0;
  const touchedFolders = new Map();

  let unfoldered = joinGroupQueries.getUnfoldered(userId, 5000);
  if (!unfoldered.length) {
    return { foldersTouched: [], groupsAssigned: 0 };
  }

  let currentFolder = folderQueries.getOpenFolder(userId);

  for (const group of unfoldered) {
    if (folderGroupQueries.isGroupInAnyFolder(userId, group.id)) continue;

    if (!currentFolder || currentFolder.groups_count >= capacity) {
      currentFolder = folderQueries.create(userId, capacity);
    }

    folderGroupQueries.add(userId, currentFolder.id, group.id);
    joinGroupQueries.assignFolder([group.id], currentFolder.id);
    folderQueries.incrementGroupsCount(currentFolder.id, 1);
    currentFolder.groups_count += 1;
    assigned += 1;

    touchedFolders.set(currentFolder.id, currentFolder);

    if (currentFolder.groups_count >= capacity) {
      folderQueries.updateStatus(currentFolder.id, 'مكتمل');
      currentFolder.status = 'مكتمل';
    }
  }

  return {
    foldersTouched: [...touchedFolders.values()].map((f) => folderQueries.getById(f.id)),
    groupsAssigned: assigned,
  };
};

// ─── Real Telegram folder creation (MTProto) ─────────────────────────────────

/**
 * Resolve a central group's InputPeer via its stored link/telegram_id so it
 * can be passed to UpdateDialogFilter. Falls back to resolving by username
 * when the group has a public link.
 *
 * @param {TelegramClient} client
 * @param {object} group  row from join_groups
 */
const resolveInputPeer = async (client, group) => {
  try {
    if (group.link) {
      const usernameMatch = group.link.match(/t\.me\/([a-zA-Z0-9_]{4,32})\/?$/);
      if (usernameMatch) {
        const entity = await client.getEntity(usernameMatch[1]);
        return await client.getInputEntity(entity);
      }
    }
    // Fall back to resolving by numeric ID from the client's own dialog cache.
    const entity = await client.getEntity(BigInt(group.telegram_id));
    return await client.getInputEntity(entity);
  } catch (error) {
    logger.warn(`foldersService: could not resolve peer for group ${group.telegram_id}: ${error.message}`);
    return null;
  }
};

/**
 * Create the actual Telegram folder (Dialog Filter) for a completed DB
 * folder row, add all its groups as included peers, then export a
 * shareable Chatlist invite link.
 *
 * @param {string} userId
 * @param {number} folderId
 * @param {number} [preferredAccountId]
 * @returns {Promise<{ success: boolean, inviteLink?: string, reason?: string }>}
 */
const createTelegramFolder = async (userId, folderId, preferredAccountId) => {
  const folder = folderQueries.getById(folderId);
  if (!folder || folder.user_id !== String(userId)) {
    return { success: false, reason: 'الملجد غير موجود' };
  }

  const account = pickAccount(userId, preferredAccountId);
  if (!account) {
    folderQueries.updateStatus(folderId, 'متوقف', { error_message: 'لا يوجد حساب متصل متاح' });
    joinLogQueries.add(userId, null, null, folder.name, 'failed', 'لا يوجد حساب متصل لإنشاء المجلد');
    return { success: false, reason: 'لا يوجد حساب تيليجرام متصل متاح لإنشاء المجلد' };
  }

  let client;
  try {
    client = await getClientForAccount(account);
  } catch (error) {
    folderQueries.updateStatus(folderId, 'متوقف', { error_message: 'تعذر تحميل جلسة الحساب' });
    joinLogQueries.add(userId, account.id, null, folder.name, 'failed', 'تعذر تحميل جلسة الحساب لإنشاء المجلد');
    return { success: false, reason: 'تعذر تحميل جلسة الحساب المحدد' };
  }

  try {
    const groupRows = folderGroupQueries.getByFolderId(folderId);
    const includePeers = [];

    for (const g of groupRows) {
      const peer = await resolveInputPeer(client, g);
      if (peer) includePeers.push(peer);
    }

    if (!includePeers.length) {
      folderQueries.updateStatus(folderId, 'متوقف', { error_message: 'تعذر تحديد أي مجموعة صالحة للمجلد' });
      joinLogQueries.add(userId, account.id, null, folder.name, 'failed', 'تعذر تحديد أي مجموعات صالحة');
      return { success: false, reason: 'تعذر تحديد أي مجموعة صالحة داخل المجلد' };
    }

    // Telegram dialog filter IDs must be 2..255 and unique per account.
    const filterId = 2 + ((folder.folder_number - 1) % 253);

    await client.invoke(
      new Api.messages.UpdateDialogFilter({
        id: filterId,
        filter: new Api.DialogFilter({
          id: filterId,
          title: folder.name,
          pinnedPeers: [],
          includePeers,
          excludePeers: [],
          contacts: false,
          nonContacts: false,
          groups: false,
          broadcasts: false,
          bots: false,
        }),
      }),
    );

    // Export a shareable Chatlist invite link for the new folder.
    let inviteLink = null;
    try {
      const exported = await client.invoke(
        new Api.chatlists.ExportChatlistInvite({
          chatlist: new Api.InputChatlistDialogFilter({ filterId }),
          title: folder.name,
          peers: includePeers,
        }),
      );
      inviteLink = exported?.invite?.url || null;
    } catch (exportError) {
      logger.warn(`foldersService: chatlist export failed for folder ${folderId}: ${exportError.message}`);
    }

    folderQueries.updateStatus(folderId, 'جاهز للمشاركة', {
      tg_filter_id: filterId,
      invite_link: inviteLink,
      account_id: account.id,
    });

    joinLogQueries.add(
      userId,
      account.id,
      inviteLink,
      folder.name,
      'joined',
      `تم إنشاء المجلد بنجاح بـ ${includePeers.length} مجموعة`,
    );

    return { success: true, inviteLink };
  } catch (error) {
    const msg = error?.errorMessage || error?.message || String(error);
    folderQueries.updateStatus(folderId, 'متوقف', { error_message: msg.slice(0, 200) });
    joinLogQueries.add(userId, account.id, null, folder.name, 'failed', `فشل إنشاء المجلد: ${msg.slice(0, 150)}`);
    logger.error(`foldersService: createTelegramFolder failed for folder ${folderId}:`, error);
    return { success: false, reason: 'حدث خطأ أثناء إنشاء المجلد على تيليجرام' };
  } finally {
    try { await client.disconnect(); } catch (_) {}
  }
};

/**
 * Full pipeline: organize any pending central groups into DB folders, then
 * push every newly-completed folder to Telegram (create filter + invite).
 * Safe to call repeatedly (idempotent for already-processed folders).
 *
 * @param {string} userId
 * @param {number} [preferredAccountId]
 */
const runFolderPipeline = async (userId, preferredAccountId) => {
  const { foldersTouched, groupsAssigned } = organizeGroupsIntoFolders(userId);

  const completed = foldersTouched.filter((f) => f.status === 'مكتمل');
  const results = [];

  for (const folder of completed) {
    const result = await createTelegramFolder(userId, folder.id, preferredAccountId);
    results.push({ folderId: folder.id, name: folder.name, ...result });
  }

  return { groupsAssigned, foldersProcessed: results };
};

module.exports = {
  organizeGroupsIntoFolders,
  createTelegramFolder,
  runFolderPipeline,
  pickAccount,
};
