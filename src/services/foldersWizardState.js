/**
 * Telegram Folders Wizard State Manager
 * Manages the "⚙️ إعدادات المجلدات" text-input steps, separate from
 * other wizard state maps (same pattern as joinWizardState.js).
 */

const wizardStates = new Map();

const WIZARD_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const WIZARD_STEPS = {
  IDLE: 'IDLE',
  AWAITING_GROUPS_PER_FOLDER: 'AWAITING_GROUPS_PER_FOLDER',
};

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

const isAwaitingTextInput = (userId) => {
  const { step } = getWizardState(userId);
  return [WIZARD_STEPS.AWAITING_GROUPS_PER_FOLDER].includes(step);
};

module.exports = {
  WIZARD_STEPS,
  getWizardState,
  setWizardState,
  resetWizard,
  isAwaitingTextInput,
};

