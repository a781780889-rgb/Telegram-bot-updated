/**
 * Publishing Engine Wizard State Manager
 */

const WIZARD_STEPS = {
  IDLE: 'IDLE',
  AWAITING_AD_CONTENT: 'AWAITING_AD_CONTENT',
  AWAITING_TASK_NAME: 'AWAITING_TASK_NAME',
  AWAITING_INTERVAL: 'AWAITING_INTERVAL',
};

const TEXT_INPUT_STEPS = new Set([
  WIZARD_STEPS.AWAITING_AD_CONTENT,
  WIZARD_STEPS.AWAITING_TASK_NAME,
  WIZARD_STEPS.AWAITING_INTERVAL,
]);

const states = new Map();
const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const getWizardState = (userId) => {
  const state = states.get(String(userId));
  if (state && Date.now() - state.lastUpdate > TIMEOUT_MS) {
    states.delete(String(userId));
    return null;
  }
  return state;
};

const setWizardState = (userId, step, data = {}) => {
  const current = getWizardState(userId) || { data: {} };
  states.set(String(userId), {
    step,
    data: { ...current.data, ...data },
    lastUpdate: Date.now(),
  });
};

const resetWizard = (userId) => {
  states.delete(String(userId));
};

const isAwaitingTextInput = (userId) => {
  const state = getWizardState(userId);
  return state && TEXT_INPUT_STEPS.has(state.step);
};

module.exports = {
  WIZARD_STEPS,
  getWizardState,
  setWizardState,
  resetWizard,
  isAwaitingTextInput,
};
