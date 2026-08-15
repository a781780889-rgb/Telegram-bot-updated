const assert = require('assert');
process.env.ADMIN_TELEGRAM_IDS = '123456789';
const { mainMenuKeyboard } = require('../src/utils/keyboards');
const buttons = (id) => mainMenuKeyboard(id).reply_markup.inline_keyboard.flat().flat().map((button) => button.callback_data);
assert(buttons('123456789').includes('codes_menu'));
assert(!buttons('987654321').includes('codes_menu'));
assert(buttons('987654321').includes('use_code'));
console.log('userCodes.visibility: PASS');
