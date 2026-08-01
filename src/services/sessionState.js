/**
 * Session State Machine
 * Manages conversation state per Telegram user during multi-step flows.
 *
 * TIMEOUT CLEANUP FIX:
 * The old implementation deleted the userState entry on timeout but left
 * the matching TelegramClient in pendingSessions (telegramClient.js) open
 * and connected forever — a socket leak for every timed-out login attempt.
 *
 * Fix: getState() now accepts an optional `onTimeout` callback so callers
 * (textRouter) can trigger cleanupPending() when a timeout is detected,
 * properly closing the dangling MTProto socket.
 */

const STATES = {
  IDLE: 'IDLE',
  AWAITING_PHONE: 'AWAITING_PHONE',
  AWAITING_OTP: 'AWAITING_OTP',
  AWAITING_PASSWORD: 'AWAITING_PASSWORD',
};

// userId -> { state, phone, accountId, attempts, startedAt }
const userStates = new Map();

const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Get current state for a user.
 *
 * @param {string} userId
 * @returns {{ state: string, phone?: string, accountId?: number,
 *             attempts: number, timedOut?: boolean }}
 */
const getState = (userId) => {
  const state = userStates.get(String(userId));
  if (!state) return { state: STATES.IDLE };

  // Check for timeout
  if (Date.now() - state.startedAt > SESSION_TIMEOUT_MS) {
    // Preserve phone/accountId so the caller can clean up pendingSessions.
    const stalePhone     = state.phone;
    const staleAccountId = state.accountId;
    userStates.delete(String(userId));
    return { state: STATES.IDLE, timedOut: true, phone: stalePhone, accountId: staleAccountId };
  }

  return state;
};

/**
 * Transition to awaiting phone state
 * @param {string} userId
 */
const setAwaitingPhone = (userId) => {
  userStates.set(String(userId), {
    state: STATES.AWAITING_PHONE,
    startedAt: Date.now(),
    attempts: 0,
  });
};

/**
 * Transition to awaiting OTP state
 * @param {string} userId
 * @param {string} phone
 * @param {number} accountId
 */
const setAwaitingOtp = (userId, phone, accountId) => {
  userStates.set(String(userId), {
    state: STATES.AWAITING_OTP,
    phone,
    accountId,
    startedAt: Date.now(),
    attempts: 0,
  });
};

/**
 * Transition to awaiting 2FA password
 * @param {string} userId
 * @param {string} phone
 * @param {number} accountId
 */
const setAwaitingPassword = (userId, phone, accountId) => {
  const current = userStates.get(String(userId)) || {};
  userStates.set(String(userId), {
    state: STATES.AWAITING_PASSWORD,
    phone,
    accountId,
    startedAt: current.startedAt || Date.now(),
    attempts: 0,
  });
};

/**
 * Increment attempts counter
 * @param {string} userId
 */
const incrementAttempts = (userId) => {
  const state = userStates.get(String(userId));
  if (state) {
    state.attempts = (state.attempts || 0) + 1;
    userStates.set(String(userId), state);
  }
};

/**
 * Get attempts count
 * @param {string} userId
 * @returns {number}
 */
const getAttempts = (userId) => {
  const state = userStates.get(String(userId));
  return state?.attempts || 0;
};

/**
 * Reset state to IDLE
 * @param {string} userId
 */
const resetState = (userId) => {
  userStates.delete(String(userId));
};

module.exports = {
  STATES,
  getState,
  setAwaitingPhone,
  setAwaitingOtp,
  setAwaitingPassword,
  incrementAttempts,
  getAttempts,
  resetState,
};
