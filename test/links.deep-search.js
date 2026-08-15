const assert = require('assert');
process.env.LINKS_DEEP_MESSAGE_LIMIT = '5000';
const { depthToLimit } = require('../src/services/linksService');
assert.equal(depthToLimit('fast'), 100);
assert.equal(depthToLimit('medium'), 500);
assert.equal(depthToLimit('deep'), 5000);
// The service reads its safety limit once at startup and keeps the deep run bounded.
assert(depthToLimit('deep') >= 1000);
assert(depthToLimit('deep') <= 5000);
console.log('links.deep-search: PASS');
