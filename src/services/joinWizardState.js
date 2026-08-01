/**
 * Join-to-Links Wizard State Manager
 * Manages the multi-step "إضافة روابط" + settings-editing wizard state per
 * user, separate from other wizard state maps (same pattern as
 * linksWizardState.js).
 */

const wizardStates = new Map();

const WIZARD_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const WIZARD_STEPS = {
  IDLE: 'IDLE',
  AWAITING_LINKS: 'AWAITING_LINKS',
  AWAITING_BATCH_SIZE: 'AWAITING_BATCH_SIZE',
  AWAITING_JOIN_DELAY_RANGE: 'AWAITING_JOIN_DELAY_RANGE',
  AWAITING_REST_RANGE: 'AWAITING_REST_RANGE',
  AWAITING_MAX_JOINS: 'AWAITING_MAX_JOINS',
  AWAITING_MAX_JOINS_HOUR: 'AWAITING_MAX_JOINS_HOUR',
  AWAITING_MAX_JOINS_DAY: 'AWAITING_MAX_JOINS_DAY',
  AWAITING_MAX_JOINS_SESSION: 'AWAITING_MAX_JOINS_SESSION',
  AWAITING_MAX_RETRIES: 'AWAITING_MAX_RETRIES',
  AWAITING_RETRY_DELAY: 'AWAITING_RETRY_DELAY',
};

/** Steps whose value is a single positive integer (plain number prompt). */
const SINGLE_NUMBER_STEPS = [
  WIZARD_STEPS.AWAITING_BATCH_SIZE,
  WIZARD_STEPS.AWAITING_MAX_JOINS,
  WIZARD_STEPS.AWAITING_MAX_JOINS_HOUR,
  WIZARD_STEPS.AWAITING_MAX_JOINS_DAY,
  WIZARD_STEPS.AWAITING_MAX_JOINS_SESSION,
  WIZARD_STEPS.AWAITING_MAX_RETRIES,
  WIZARD_STEPS.AWAITING_RETRY_DELAY,
];

/** Steps whose value is a "min-max" range (e.g. "20-45"). */
const RANGE_STEPS = [
  WIZARD_STEPS.AWAITING_JOIN_DELAY_RANGE,
  WIZARD_STEPS.AWAITING_REST_RANGE,
];

const getWizardState = (userId) => {
  const state = wizardStates.get(String(userId));
  if (!state) return { step: WIZARD_STEPS.IDLE };

  if (Date.now() - state.updatedAt > WIZARD_TIMEOUT_MS) {
    wizardStates.delete(String(userId));
    return { step: WIZARD_STEPS.IDLE, timedOut: true };
  }
  return state;
};

const setWizardState = (userId, patch) => {
  const current = wizardStates.get(String(userId)) || { step: WIZARD_STEPS.IDLE };
  wizardStates.set(String(userId), { ...current, ...patch, updatedAt: Date.now() });
};

const resetWizard = (userId) => {
  wizardStates.delete(String(userId));
};

/**
 * Check if user is in a join wizard step that requires text input
 * (same pattern as linksWizardState.isAwaitingTextInput)
 * @param {string} userId
 * @returns {boolean}
 */
const isAwaitingTextInput = (userId) => {
  const { step } = getWizardState(userId);
  return [
    WIZARD_STEPS.AWAITING_LINKS,
    ...SINGLE_NUMBER_STEPS,
    ...RANGE_STEPS,
  ].includes(step);
};

module.exports = {
  WIZARD_STEPS,
  SINGLE_NUMBER_STEPS,
  RANGE_STEPS,
  getWizardState,
  setWizardState,
  resetWizard,
  isAwaitingTextInput,
};
