// Quick checks for the location and trade-size rules: run with `npm test`
const assert = require('assert');
const { opensRisk, largestNewOrderUsd, isBlockedPlace } = require('./server');

// Places
assert(isBlockedPlace('US', 'CA'));
assert(isBlockedPlace('CA', 'ON'));
assert(!isBlockedPlace('CA', 'BC'));
assert(isBlockedPlace('UA', '43'));      // Crimea
assert(!isBlockedPlace('UA', '30'));     // Kyiv
assert(isBlockedPlace('IR', ''));
assert(!isBlockedPlace('GB', ''));

// Opening vs closing
const open = { type: 'order', orders: [{ a: 0, b: true, p: '100', s: '1', r: false, t: { limit: { tif: 'Ioc' } } }] };
const close = { type: 'order', orders: [{ a: 0, b: false, p: '100', s: '1', r: true, t: { limit: { tif: 'Ioc' } } }] };
const tpslOnly = { type: 'order', orders: [{ a: 0, b: false, p: '90', s: '1', r: true, t: { trigger: { isMarket: true, triggerPx: '95', tpsl: 'sl' } } }] };
assert(opensRisk(open));
assert(!opensRisk(close));
assert(!opensRisk(tpslOnly));
assert(!opensRisk({ type: 'cancel', cancels: [] }));
assert(!opensRisk({ type: 'updateLeverage', asset: 0, isCross: true, leverage: 3 }));
assert(opensRisk({ type: 'modify', oid: 1, order: { r: false } }));          // re-pricing an opening order
assert(opensRisk({ type: 'batchModify', modifies: [{ order: { r: true } }, { order: { r: false } }] }));
assert(opensRisk({ type: 'twapOrder', twap: { r: false } }));
assert(!opensRisk({ type: 'twapOrder', twap: { r: true } }));

// Trade size
assert.strictEqual(largestNewOrderUsd(open), 100);
assert.strictEqual(largestNewOrderUsd(close), 0);
console.log('All checks passed');
