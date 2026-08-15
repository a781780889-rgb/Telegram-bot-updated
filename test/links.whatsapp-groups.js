const assert = require('assert');
const { extractLinks } = require('../src/services/linksService');
const text = [
  'https://wa.me/+966547486813',
  'wa.me/966592708130',
  'https://wa.me/message/LMTPUPGWMEUKL1',
  'https://api.whatsapp.com/send?phone=966500000000',
  'https://chat.whatsapp.com/G3di4qCw7VK3MDGRKAkGCE',
  'https://chat.whatsapp.com/Em6E5M8GVb56oQJJ01Qskx?x=1',
].join('\n');
const links = extractLinks(text, 'whatsapp');
assert.deepEqual(links.map((link) => link.url), [
  'https://chat.whatsapp.com/G3di4qCw7VK3MDGRKAkGCE',
  'https://chat.whatsapp.com/Em6E5M8GVb56oQJJ01Qskx',
]);
assert(links.every((link) => link.type === 'whatsapp'));
console.log('links.whatsapp-groups: PASS');
