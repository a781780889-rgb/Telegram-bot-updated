/**
 * Links Wizard State Manager
 * Manages the multi-step wizard state for each user separately from the main session state
 *
 * Wizard flow:
 *  1. SELECT_ACCOUNTS / PICK_ACCOUNTS
 *  2. SELECT_LINK_TYPE         (telegram | whatsapp | both)
 *  3. SELECT_TELEGRAM_SUBTYPE  (إذا كان telegram أو both) — مجموعات عامة / قنوات / خاصة / الكل
 *  4. SELECT_WHATSAPP_SUBTYPE  (إذا كان whatsapp أو both) — مجموعات / قنوات / الكل
 *  5. SELECT_PERIOD            (day | week | month | year | custom)
 *  6. SELECT_DEPTH             (fast | medium | deep)
 *  7. REVIEW
 *  8. SEARCHING
 */

// userId -> wizard state object
const wizardStates = new Map();

const WIZARD_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// ─── Wizard Steps ────────────────────────────────────────────────────────────

const WIZARD_STEPS = {
  IDLE: 'IDLE',
  SELECT_ACCOUNTS: 'SELECT_ACCOUNTS',
  PICK_ACCOUNTS: 'PICK_ACCOUNTS',
  SELECT_LINK_TYPE: 'SELECT_LINK_TYPE',
  SELECT_TELEGRAM_SUBTYPE: 'SELECT_TELEGRAM_SUBTYPE',
  SELECT_WHATSAPP_SUBTYPE: 'SELECT_WHATSAPP_SUBTYPE',
  SELECT_PERIOD: 'SELECT_PERIOD',
  AWAITING_CUSTOM_START: 'AWAITING_CUSTOM_START',
  AWAITING_CUSTOM_END: 'AWAITING_CUSTOM_END',
  SELECT_DEPTH: 'SELECT_DEPTH',
  REVIEW: 'REVIEW',
  SEARCHING: 'SEARCHING',
  AWAITING_RENAME: 'AWAITING_RENAME',
};

// ─── API ─────────────────────────────────────────────────────────────────────

/**
 * Get wizard state for a user; returns IDLE state if expired or not started
 * @param {string} userId
 */
const getWizardState = (userId) => {
  const state = wizardStates.get(String(userId));
  if (!state) return { step: WIZARD_STEPS.IDLE };

  if (Date.now() - state.updatedAt > WIZARD_TIMEOUT_MS) {
    wizardStates.delete(String(userId));
    return { step: WIZARD_STEPS.IDLE, timedOut: true };
  }

  return state;
};

/**
 * Set / update wizard state
 * @param {string} userId
 * @param {object} patch - fields to merge into current state
 */
const setWizardState = (userId, patch) => {
  const current = wizardStates.get(String(userId)) || { step: WIZARD_STEPS.IDLE };
  wizardStates.set(String(userId), { ...current, ...patch, updatedAt: Date.now() });
};

/**
 * Start a fresh wizard
 * @param {string} userId
 */
const startWizard = (userId) => {
  wizardStates.set(String(userId), {
    step: WIZARD_STEPS.SELECT_ACCOUNTS,
    // Step 1
    accountMode: null,
    selectedAccountIds: [],
    // Step 2
    linkType: null,           // 'telegram' | 'whatsapp' | 'both'
    // Step 3a — Telegram sub-type (array of selected values or 'all')
    telegramSubTypes: [],     // ['public_group','channel','private_group'] or ['all']
    // Step 3b — WhatsApp sub-type
    whatsappSubTypes: [],     // ['group','channel'] or ['all']
    // Step 4
    period: null,             // 'day' | 'week' | 'month' | '3months' | 'year' | 'custom'
    customStart: null,
    customEnd: null,
    // Step 5
    searchDepth: null,        // 'fast' | 'medium' | 'deep'
    // Runtime
    operationId: null,
    renameTargetId: null,
    updatedAt: Date.now(),
  });
};

/**
 * Reset wizard to IDLE
 * @param {string} userId
 */
const resetWizard = (userId) => {
  wizardStates.delete(String(userId));
};

/**
 * Determine the next step after SELECT_LINK_TYPE based on chosen type
 * @param {'telegram'|'whatsapp'|'both'} linkType
 * @returns {string} next WIZARD_STEP
 */
const nextStepAfterType = (linkType) => {
  if (linkType === 'telegram') return WIZARD_STEPS.SELECT_TELEGRAM_SUBTYPE;
  if (linkType === 'whatsapp') return WIZARD_STEPS.SELECT_WHATSAPP_SUBTYPE;
  return WIZARD_STEPS.SELECT_TELEGRAM_SUBTYPE; // 'both' → telegram first, then whatsapp
};

/**
 * Determine the next step after SELECT_TELEGRAM_SUBTYPE
 * @param {'telegram'|'both'} linkType
 * @returns {string}
 */
const nextStepAfterTelegramSubtype = (linkType) => {
  if (linkType === 'both') return WIZARD_STEPS.SELECT_WHATSAPP_SUBTYPE;
  return WIZARD_STEPS.SELECT_PERIOD;
};

/**
 * Check if user is in a links wizard step that requires text input
 * @param {string} userId
 * @returns {boolean}
 */
const isAwaitingTextInput = (userId) => {
  const { step } = getWizardState(userId);
  return [
    WIZARD_STEPS.AWAITING_CUSTOM_START,
    WIZARD_STEPS.AWAITING_CUSTOM_END,
    WIZARD_STEPS.AWAITING_RENAME,
  ].includes(step);
};

module.exports = {
  WIZARD_STEPS,
  getWizardState,
  setWizardState,
  startWizard,
  resetWizard,
  nextStepAfterType,
  nextStepAfterTelegramSubtype,
  isAwaitingTextInput,
};
