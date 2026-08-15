const TTL_MS = 10 * 60 * 1000;
const states = new Map();

const set = (userId, state, data = {}) => {
  states.set(String(userId), { state, data, updatedAt: Date.now() });
};
const get = (userId) => {
  const key = String(userId);
  const value = states.get(key);
  if (!value) return null;
  if (Date.now() - value.updatedAt > TTL_MS) { states.delete(key); return null; }
  return value;
};
const reset = (userId) => states.delete(String(userId));
const isAwaitingTextInput = (userId) => Boolean(get(userId));
module.exports = { set, get, reset, isAwaitingTextInput };
