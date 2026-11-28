// Tests for the leaderboard and auto-follow. Copy-logic tests always run;
// database tests run when TEST_DATABASE_URL points at an empty Postgres database.
//   node test-social.js
const assert = require('assert');
const { planFollow, makeVault, createSocial, messages } = require('./social');

const meta = { BTC: { asset: 0, szDecimals: 5, maxLeverage: 40 }, 'xyz:TSLA': { asset: 110000, szDecimals: 3, maxLeverage: 10 } };
const mids = { BTC: 60000, 'xyz:TSLA': 400 };
const baseFollow = { status: 'active', per_trade_usd: 50, max_total_usd: 120, stop_pct: 5, ignore: {} };
const plan = (o) => planFollow({ follow: baseFollow, copies: [], leader: new Map(), follower: new Map(), mids, meta, cap: 100, ...o });

// 1. Leader opens a new trade → follower opens $50 at capped leverage with a 5% stop
let r = plan({ leader: new Map([['BTC', { szi: 0.5, lev: 25 }]]) });
assert.strictEqual(r.actions.length, 1);
let a = r.actions[0];
assert.strictEqual(a.kind, 'open'); assert.strictEqual(a.side, 'long'); assert.strictEqual(a.isBuy, true);
assert.strictEqual(a.lev, 10, 'leverage capped at 10x');
assert(Math.abs(a.sz * 60000 - 50) < 1, 'about $50');
assert(Math.abs(a.stopPx - 57000) < 1, 'stop 5% below for a long');

// 2. Short → stop above
r = plan({ leader: new Map([['xyz:TSLA', { szi: -3, lev: 3 }]]) });
assert.strictEqual(r.actions[0].side, 'short'); assert(r.actions[0].stopPx > 400); assert.strictEqual(r.actions[0].lev, 3);

// 3. Ignored (existed before follow) → nothing; once leader closes it, ignore clears
r = plan({ follow: { ...baseFollow, ignore: { BTC: 'long' } }, leader: new Map([['BTC', { szi: 1, lev: 5 }]]) });
assert.strictEqual(r.actions.length, 0); assert.deepStrictEqual(r.ignore, { BTC: 'long' });
r = plan({ follow: { ...baseFollow, ignore: { BTC: 'long' } } });
assert.deepStrictEqual(r.ignore, {});
// ignored long flipped to short → treated as a new trade
r = plan({ follow: { ...baseFollow, ignore: { BTC: 'long' } }, leader: new Map([['BTC', { szi: -1, lev: 5 }]]) });
assert.strictEqual(r.actions[0].kind, 'open'); assert.strictEqual(r.actions[0].side, 'short');

// 4. Leader closes → follower closes what the copy holds
const copy = { id: 7, coin: 'BTC', side: 'long', leader_sz: 0.5, follower_sz: 0.0008 };
r = plan({ copies: [copy], follower: new Map([['BTC', 0.0008]]) });
assert.deepStrictEqual(r.actions[0], { kind: 'close', copyId: 7, coin: 'BTC', isBuy: false, sz: 0.0008 });

// 5. Leader flips → close
r = plan({ copies: [copy], leader: new Map([['BTC', { szi: -0.5, lev: 5 }]]), follower: new Map([['BTC', 0.0008]]) });
assert.strictEqual(r.actions[0].kind, 'close');

// 6. Leader trims by half → follower trims by half
const bigCopy = { ...copy, follower_sz: 0.004 };
r = plan({ copies: [bigCopy], leader: new Map([['BTC', { szi: 0.25, lev: 5 }]]), follower: new Map([['BTC', 0.004]]) });
assert.strictEqual(r.actions[0].kind, 'reduce'); assert.strictEqual(r.actions[0].sz, 0.002); assert.strictEqual(r.actions[0].followerSz, 0.002);

// 7. Trim that would leave under $10 → close instead ($48 trimmed to 20% = $9.60)
r = plan({ copies: [copy], leader: new Map([['BTC', { szi: 0.1, lev: 5 }]]), follower: new Map([['BTC', 0.0008]]) });
assert.strictEqual(r.actions[0].kind, 'close');

// 8. Small trim (<10%) or leader adding → leave it
r = plan({ copies: [copy], leader: new Map([['BTC', { szi: 0.48, lev: 5 }]]), follower: new Map([['BTC', 0.0008]]) });
assert.strictEqual(r.actions.length, 0);
r = plan({ copies: [copy], leader: new Map([['BTC', { szi: 2, lev: 5 }]]), follower: new Map([['BTC', 0.0008]]) });
assert.strictEqual(r.actions.length, 0);

// 9. Follower's trade gone (stop hit) while leader still in → forget, don't re-enter
r = plan({ copies: [copy], leader: new Map([['BTC', { szi: 0.5, lev: 5 }]]) });
assert.strictEqual(r.actions[0].kind, 'forget'); assert.deepStrictEqual(r.ignore, { BTC: 'long' });

// 10. Total limit: $120 allows two $50 trades, the third is skipped
r = plan({ leader: new Map([['BTC', { szi: 1, lev: 2 }], ['xyz:TSLA', { szi: 1, lev: 2 }]]), follow: { ...baseFollow, max_total_usd: 60 } });
assert.strictEqual(r.actions.filter(x => x.kind === 'open').length, 1);
assert.strictEqual(r.actions.filter(x => x.kind === 'skip').length, 1);

// 11. Site cap wins over a bigger per-trade amount
r = plan({ follow: { ...baseFollow, per_trade_usd: 500, max_total_usd: 1000 }, leader: new Map([['BTC', { szi: 1, lev: 2 }]]) });
assert(r.actions[0].sz * 60000 <= 100.01);

// 12. Paused follow: never opens, still closes
r = plan({ follow: { ...baseFollow, status: 'paused' }, leader: new Map([['BTC', { szi: 1, lev: 2 }]]) });
assert.strictEqual(r.actions.length, 0);
r = plan({ follow: { ...baseFollow, status: 'paused' }, copies: [copy], follower: new Map([['BTC', 0.0008]]) });
assert.strictEqual(r.actions[0].kind, 'close');

// 13. Follower already holds their own trade on that market → skip
r = plan({ leader: new Map([['BTC', { szi: 1, lev: 2 }]]), follower: new Map([['BTC', -0.01]]) });
assert.strictEqual(r.actions[0].kind, 'skip');

// 14. Vault round-trip and tamper check
const v = makeVault('11'.repeat(32));
const sealed = v.seal('0x' + 'ab'.repeat(32));
assert.strictEqual(v.open(sealed), '0x' + 'ab'.repeat(32));
assert.throws(() => v.open(sealed.replace(/.$/, c => (c === 'A' ? 'B' : 'A'))));
assert.strictEqual(makeVault('short'), null);
console.log('Copy logic: all checks passed');

// ---- Database flow with a fake Hyperliquid -------------------------------------------------------
(async () => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return console.log('Database tests skipped (set TEST_DATABASE_URL)');
  const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts');

  const leaderAcct = privateKeyToAccount(generatePrivateKey());
  const followerAcct = privateKeyToAccount(generatePrivateKey());
  const agentKey = generatePrivateKey();
  const agentAddr = privateKeyToAccount(agentKey).address;
  const L = leaderAcct.address.toLowerCase(), F = followerAcct.address.toLowerCase();

  // Fake exchange: positions per user, records orders
  const pos = { [L]: [{ coin: 'BTC', szi: 0.2, entryPx: 59000, lev: 5, unrealizedPnl: 200, roe: 0.25, marginUsed: 2400 }], [F]: [] };
  const orders = [];
  const fakeClient = {
    updateLeverage: async () => ({}),
    cancel: async () => ({}),
    order: async (req) => {
      orders.push(req);
      const o = req.orders[0];
      const coin = o.a === 0 ? 'BTC' : 'xyz:TSLA';
      const cur = pos[F].find(p => p.coin === coin);
      const delta = (o.b ? 1 : -1) * Number(o.s);
      if (cur) { cur.szi = +(cur.szi + delta).toFixed(8); if (!cur.szi) pos[F] = pos[F].filter(p => p !== cur); }
      else pos[F].push({ coin, szi: delta, entryPx: mids[coin], lev: 1, unrealizedPnl: 0, roe: 0, marginUsed: 0 });
      return { response: { data: { statuses: [{ filled: { totalSz: o.s, avgPx: String(mids[coin]) } }] } } };
    },
  };
  const hl = {
    ready: async () => {}, meta: () => meta, mids: async () => mids,
    state: async u => ({ positions: (pos[u] || []).map(p => ({ ...p })) }),
    triggers: async () => [], agents: async u => (u === F ? [{ name: 'copy', address: agentAddr }] : []),
    builderOk: async () => true, client: async () => fakeClient,
  };
  let where = { allowed: true, country: 'CA', region: 'BC', reason: '' };
  const social = createSocial({ network: 'testnet', hlApi: 'x', cap: 100, markets: Object.keys(meta), builder: '0xb', builderFee: 30,
    checkLocation: async () => where, isBlockedPlace: (c, r) => c === 'US' || (c === 'CA' && r === 'ON'),
    databaseUrl: dbUrl, secret: '22'.repeat(32), hl, log: () => {} });
  await social.init();

  // capture route replies
  const call = async (method, path, body) => {
    let out;
    const res = {}; const send = (_r, code, b) => { out = { code, ...b }; };
    const req = { method };
    await social.route(req, res, new URL('http://x/api/social/' + path), { send, readJson: async () => body });
    return out;
  };
  const sign = (acct, msg) => acct.signMessage({ message: msg });

  // Join leaderboard (bad signature rejected, good one accepted)
  let ts = Date.now();
  let res = await call('POST', 'join', { wallet: L, nickname: 'Dan', ts, sig: await sign(followerAcct, messages.join(L, 'Dan', ts)), residence: 'CA-BC' });
  assert.strictEqual(res.code, 403, 'wrong signer rejected');
  res = await call('POST', 'join', { wallet: L, nickname: 'Dan', ts, sig: await sign(leaderAcct, messages.join(L, 'Dan', ts)), residence: 'CA-BC' });
  assert.strictEqual(res.code, 200, JSON.stringify(res));
  res = await call('POST', 'join', { wallet: L, nickname: 'Dan', ts, sig: await sign(leaderAcct, messages.join(L, 'Dan', ts)), residence: 'CA-ON' });
  assert.strictEqual(res.code, 403, 'Ontario residence blocked');

  // Leaderboard shows the open trade, wallet hidden
  const board = await call('GET', 'leaderboard');
  assert.strictEqual(board.trades.length, 1); assert.strictEqual(board.trades[0].nickname, 'Dan');
  assert(!JSON.stringify(board).includes(L), 'wallet address not exposed');
  const leaderId = board.trades[0].leaderId;

  // Follow: blocked location refused, then accepted
  where = { allowed: false, country: 'US', region: 'NY', reason: 'Trading is not available in your location' };
  res = await call('POST', 'follow', { follower: F, leaderId, perTradeUsd: 50, maxTotalUsd: 120, stopPct: 5, agentKey, residence: 'CA-BC' });
  assert.strictEqual(res.code, 403);
  where = { allowed: true, country: 'CA', region: 'BC', reason: '' };
  res = await call('POST', 'follow', { follower: F, leaderId, perTradeUsd: 500, maxTotalUsd: 1000, agentKey, residence: 'CA-BC' });
  assert.strictEqual(res.code, 400, 'above cap rejected');
  res = await call('POST', 'follow', { follower: L, leaderId, perTradeUsd: 50, maxTotalUsd: 120, agentKey, residence: 'CA-BC' });
  assert.strictEqual(res.code, 400, "can't follow yourself");
  res = await call('POST', 'follow', { follower: '0x' + '9'.repeat(40), leaderId, perTradeUsd: 50, maxTotalUsd: 120, agentKey, residence: 'CA-BC' });
  assert.strictEqual(res.code, 403, 'key not approved by this wallet');
  res = await call('POST', 'follow', { follower: F, leaderId, perTradeUsd: 50, maxTotalUsd: 120, stopPct: 5, agentKey, residence: 'CA-BC' });
  assert.strictEqual(res.code, 200, JSON.stringify(res));
  const [stored] = await social.query('SELECT key_enc FROM copy_keys');
  assert(!stored.key_enc.includes(agentKey.slice(2, 20)), 'key stored encrypted');

  // Existing BTC position is not copied
  await social.tick();
  assert.strictEqual(orders.length, 0, 'pre-existing trade ignored');

  // Leader opens TSLA short → copied
  pos[L].push({ coin: 'xyz:TSLA', szi: -5, entryPx: 400, lev: 3, unrealizedPnl: 0, roe: 0, marginUsed: 600 });
  await social.tick();
  assert.strictEqual(orders.length, 1);
  assert.strictEqual(orders[0].orders[0].b, false, 'short');
  assert.strictEqual(orders[0].orders.length, 2, 'with stop-loss');
  assert.deepStrictEqual(orders[0].builder, { b: '0xb', f: 30 }, 'app fee included');
  assert.strictEqual(pos[F][0].coin, 'xyz:TSLA');

  // Nothing new → nothing happens
  await social.tick();
  assert.strictEqual(orders.length, 1);

  // Leader closes TSLA → follower closed
  pos[L] = pos[L].filter(p => p.coin !== 'xyz:TSLA');
  await social.tick();
  assert.strictEqual(orders.length, 2);
  assert.strictEqual(orders[1].orders[0].r, true, 'reduce-only close');
  assert.strictEqual(pos[F].length, 0, 'follower flat');

  // me() shows the follow
  const mine = await call('GET', 'me');
  // (no wallet param → empty)
  assert.deepStrictEqual(mine.follows, []);

  // Stop requires the follower's signature
  const [{ id: followId }] = await social.query('SELECT id FROM follows');
  ts = Date.now();
  res = await call('POST', 'stop', { wallet: F, followId, ts, sig: await sign(leaderAcct, messages.stop(F, followId, false, ts)) });
  assert.strictEqual(res.code, 403);
  res = await call('POST', 'stop', { wallet: F, followId, ts, sig: await sign(followerAcct, messages.stop(F, followId, false, ts)) });
  assert.strictEqual(res.code, 200);
  pos[L].push({ coin: 'xyz:TSLA', szi: 5, entryPx: 400, lev: 3, unrealizedPnl: 0, roe: 0, marginUsed: 600 });
  await social.tick();
  assert.strictEqual(orders.length, 2, 'stopped follow does nothing');

  await social.end();
  console.log('Database flow: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
