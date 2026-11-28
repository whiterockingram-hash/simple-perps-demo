// Tests for reactions, flairs, comments, moderation, profiles, trade history and alerts.
//   node test-community.js   (database part runs when TEST_DATABASE_URL is set)
const assert = require('assert');
const { tradeFlairs, traderFlairs, checkPost, sessionMessage } = require('./community');
const { createSocial, messages } = require('./social');

// ---- Flairs ----
const now = Date.now();
assert.deepStrictEqual(tradeFlairs({ lev: 5, maxLev: 40, min_roe: -35, last_roe: 12, opened_at: now }), ['diamond_hands']);
assert.deepStrictEqual(tradeFlairs({ lev: 5, maxLev: 40, min_roe: -35, final_roe: -5, opened_at: now, closed_at: now + 3600e3 }), []);
assert(tradeFlairs({ lev: 3, min_roe: 0, final_roe: 2, opened_at: now, closed_at: now + 5 * 60e3 }).includes('paper_hands'));
assert(tradeFlairs({ lev: 20, maxLev: 40, min_roe: 0, last_roe: 0, opened_at: now }).includes('yolo'));
assert(tradeFlairs({ lev: 10, max_lev: 10, min_roe: 0, last_roe: 0, opened_at: now }).includes('yolo'), 'max leverage on a 10x market counts');
assert(!tradeFlairs({ lev: 10, maxLev: 40, min_roe: 0, last_roe: 0, opened_at: now }).includes('yolo'));
assert(tradeFlairs({ lev: 5, min_roe: -2, final_roe: 140, opened_at: now, closed_at: now + 86400e3 }).includes('tendies'));
const three = [1, 2, 3].map(i => ({ lev: 2, min_roe: 0, final_roe: 1, opened_at: now - i * 3600e3, closed_at: now - i * 3600e3 + 60e3 }));
assert(traderFlairs(three).includes('paper_hands'));
assert(!traderFlairs(three.slice(0, 2)).includes('paper_hands'), 'one-off quick close is not a flair');
assert(traderFlairs([], { leaderId: 4, weekWinner: 4 }).includes('king'));
assert(traderFlairs([], { leaderId: 4, weekLoser: 4 }).includes('loss_legend'));

// ---- Post filter ----
assert.strictEqual(checkPost('TSLA to 500 🚀💎🙌', 'comment'), '');
assert.strictEqual(checkPost('', 'comment'), 'Write something first');
assert(checkPost('x'.repeat(281), 'comment'));
assert.strictEqual(checkPost('x'.repeat(1500), 'dd'), '');
assert(checkPost('check out https://scam.example', 'comment'));
assert(checkPost('go to www.free-money now', 'comment'));
assert(checkPost('join t.me/pumpgroup', 'comment'));
assert(checkPost('buy 0x1234567890abcdef1234567890abcdef12345678', 'comment'));
assert(checkPost('send me your seed phrase', 'comment'));
assert(checkPost('dm me for signals', 'comment'));
assert.strictEqual(checkPost('Earnings on the 5th, IV crush incoming. Holding.', 'dd'), '');
console.log('Flairs and post filter: all checks passed');

(async () => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return console.log('Database tests skipped (set TEST_DATABASE_URL)');
  const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts');
  const A = privateKeyToAccount(generatePrivateKey()), B = privateKeyToAccount(generatePrivateKey()), C = privateKeyToAccount(generatePrivateKey());
  const a = A.address.toLowerCase(), b = B.address.toLowerCase(), c = C.address.toLowerCase();
  const D = privateKeyToAccount(generatePrivateKey()), d = D.address.toLowerCase();

  const meta = { BTC: { asset: 0, szDecimals: 5, maxLeverage: 40 }, 'xyz:TSLA': { asset: 110000, szDecimals: 3, maxLeverage: 10 } };
  const mids = { BTC: 60000, 'xyz:TSLA': 400 };
  const pos = { [a]: [{ coin: 'xyz:TSLA', szi: 2, entryPx: 380, lev: 10, unrealizedPnl: 40, roe: -0.25, marginUsed: 76 }], [b]: [] };
  const hl = { ready: async () => {}, meta: () => meta, mids: async () => mids,
    state: async u => ({ positions: (pos[u] || []).map(p => ({ ...p })) }), triggers: async () => [],
    agents: async () => [], builderOk: async () => false, client: async () => ({}) };
  const pushed = [];
  const push = { sendNotification: async (sub, payload) => { pushed.push({ to: sub.endpoint, ...JSON.parse(payload) }); } };
  const social = createSocial({ network: 'testnet', hlApi: 'x', cap: 100, markets: Object.keys(meta), builder: '0xbuilder', builderFee: 30,
    checkLocation: async () => ({ allowed: true, country: 'CA', region: 'BC' }), isBlockedPlace: () => false,
    databaseUrl: dbUrl, secret: '33'.repeat(32), hl, push, admins: [d], log: () => {} });
  await social.init();

  const call = async (method, path, body, token) => {
    let out;
    const send = (_r, code, x) => { out = { code, ...x }; };
    const u = new URL('http://x/api/social/' + path);
    await social.route({ method, headers: token ? { 'x-session': token } : {} }, {}, u, { send, readJson: async () => body });
    return out;
  };
  const signIn = async (acct) => {
    const w = acct.address.toLowerCase(), ts = Date.now();
    const r = await call('POST', 'session', { wallet: w, ts, sig: await acct.signMessage({ message: sessionMessage(w, ts) }) });
    assert.strictEqual(r.code, 200, JSON.stringify(r)); return r.token;
  };

  // Sign-in: wrong signer refused, right signer gets a token
  let ts = Date.now();
  let r = await call('POST', 'session', { wallet: a, ts, sig: await B.signMessage({ message: sessionMessage(a, ts) }) });
  assert.strictEqual(r.code, 403);
  const ta = await signIn(A), tb = await signIn(B), tc = await signIn(C), td = await signIn(D);

  // A joins the board using the session (no extra signature)
  r = await call('POST', 'join', { wallet: a, nickname: 'RoaringApe', residence: 'CA-BC' }, ta);
  assert.strictEqual(r.code, 200, JSON.stringify(r));
  r = await call('POST', 'join', { wallet: b, nickname: 'RoaringApe', residence: 'CA-BC' }, tb);
  assert.strictEqual(r.code, 409, 'nickname taken');
  r = await call('POST', 'join', { wallet: b, nickname: 'Sneaky' }, ta);
  assert.strictEqual(r.code, 403, "A's session can't act for B");

  // Board: trade gets an id and tracked
  let board = await call('GET', 'leaderboard', null, tb);
  assert.strictEqual(board.trades.length, 1);
  const t1 = board.trades[0];
  assert(t1.tradeId, 'trade id assigned');
  assert(t1.flairs.includes('yolo'), '10x on a 10x market is YOLO');

  // Reactions toggle, counts, "mine"
  r = await call('POST', 'react', { tradeId: t1.tradeId, kind: 'diamond' }, tb);
  assert.deepStrictEqual([r.code, r.on, r.count], [200, true, 1]);
  await call('POST', 'react', { tradeId: t1.tradeId, kind: 'diamond' }, tc);
  await call('POST', 'react', { tradeId: t1.tradeId, kind: 'rocket' }, tc);
  board = await call('GET', 'leaderboard', null, tb);
  assert.deepStrictEqual(board.trades[0].reactions, { diamond: 2, rocket: 1 });
  assert.deepStrictEqual(board.trades[0].mine, ['diamond']);
  r = await call('POST', 'react', { tradeId: t1.tradeId, kind: 'diamond' }, tb);
  assert.deepStrictEqual([r.on, r.count], [false, 1], 'second tap removes it');
  r = await call('POST', 'react', { tradeId: t1.tradeId, kind: 'diamond' });
  assert.strictEqual(r.code, 401, 'must be signed in');
  r = await call('POST', 'react', { tradeId: t1.tradeId, kind: 'poop' }, tb);
  assert.strictEqual(r.code, 400);

  // Comments: need a nickname; filter works; DD only by owner
  r = await call('POST', 'post', { tradeId: t1.tradeId, body: 'LFG 🚀' }, tb);
  assert.strictEqual(r.code, 409, 'nickname needed');
  r = await call('POST', 'nickname', { nickname: 'BagHolder' }, tb);
  assert.strictEqual(r.code, 200);
  board = await call('GET', 'leaderboard', null, tb);
  assert.strictEqual(board.traders.length, 1, 'commenting does not put you on the board');
  r = await call('POST', 'post', { tradeId: t1.tradeId, body: 'free money at https://x.io' }, tb);
  assert.strictEqual(r.code, 400);
  r = await call('POST', 'post', { tradeId: t1.tradeId, body: 'LFG 🚀' }, tb);
  assert.strictEqual(r.code, 200);
  r = await call('POST', 'post', { tradeId: t1.tradeId, body: 'again' }, tb);
  assert.strictEqual(r.code, 429, 'rate limit');
  r = await call('POST', 'post', { tradeId: t1.tradeId, kind: 'dd', body: 'My thesis' }, tb);
  assert.strictEqual(r.code, 403, 'only the trader posts DD');
  r = await call('POST', 'post', { tradeId: t1.tradeId, kind: 'dd', body: 'Deliveries beat, robotaxi day soon. Holding.' }, ta);
  assert.strictEqual(r.code, 200);
  r = await call('GET', 'posts?tradeId=' + t1.tradeId, null, tc);
  assert.strictEqual(r.posts.length, 2);
  assert.strictEqual(r.posts[0].kind, 'dd', 'DD pinned first');
  assert.strictEqual(r.posts[1].nickname, 'BagHolder');
  assert(!JSON.stringify(r).includes(b), 'commenter wallet hidden');
  assert(pushed.length === 0, 'no alerts without subscriptions');

  // Reports: 3 reports hide a post; admin hides instantly; delete own
  const commentId = r.posts[1].id;
  await call('POST', 'nickname', { nickname: 'Viewer' }, tc);
  r = await call('POST', 'report', { postId: commentId }, tb);
  assert.strictEqual(r.code, 400, "can't report yourself");
  await call('POST', 'report', { postId: commentId }, tc);
  await call('POST', 'report', { postId: commentId }, tc); // duplicate ignored
  r = await call('GET', 'posts?tradeId=' + t1.tradeId, null, tc);
  assert.strictEqual(r.posts.length, 2, 'one report is not enough');
  await call('POST', 'report', { postId: commentId }, td); // admin
  r = await call('GET', 'posts?tradeId=' + t1.tradeId, null, tc);
  assert.strictEqual(r.posts.length, 1, 'admin report hides it');
  const ddId = r.posts[0].id;
  r = await call('POST', 'post-delete', { postId: ddId }, tc);
  assert.strictEqual(r.code, 403);
  r = await call('POST', 'post-delete', { postId: ddId }, ta);
  assert.strictEqual(r.code, 200);

  // Alerts: C watches A and subscribes; A opens BTC → C alerted; A closes TSLA → alerted with result
  r = await call('POST', 'push-sub', { subscription: { endpoint: 'https://push.example/c', keys: { p256dh: 'k', auth: 'a' } } }, tc);
  assert.strictEqual(r.code, 200);
  r = await call('POST', 'watch', { leaderId: t1.leaderId, on: true }, tc);
  assert.strictEqual(r.watching, true);
  pos[a].push({ coin: 'BTC', szi: 0.01, entryPx: 60000, lev: 3, unrealizedPnl: 0, roe: 0, marginUsed: 200 });
  // the board caches for 15s; re-joining resets the cache so the next read is fresh
  await call('POST', 'join', { wallet: a, nickname: 'RoaringApe', residence: 'CA-BC' }, ta);
  board = await call('GET', 'leaderboard', null, tc);
  await new Promise(r2 => setTimeout(r2, 50));
  assert(pushed.some(p => p.title.includes('opened BTC LONG')), 'open alert: ' + JSON.stringify(pushed));
  pos[a] = pos[a].filter(p => p.coin !== 'xyz:TSLA');
  await call('POST', 'join', { wallet: a, nickname: 'RoaringApe', residence: 'CA-BC' }, ta);
  board = await call('GET', 'leaderboard', null, tc);
  await new Promise(r2 => setTimeout(r2, 50));
  assert(pushed.some(p => p.title.includes('closed TSLA LONG')), 'close alert');

  // Profile: stats from closed trades
  r = await call('GET', 'profile?id=' + t1.leaderId, null, tc);
  assert.strictEqual(r.nickname, 'RoaringApe');
  assert.strictEqual(r.watching, true);
  assert.strictEqual(r.stats.trades, 1);
  assert.strictEqual(r.trades.length, 2);
  assert(r.flairs.includes('yolo'));
  assert(r.flairs.includes('loss_legend'), 'only closed loser this week');
  r = await call('GET', 'profile?id=999', null, tc);
  assert.strictEqual(r.code, 404);

  // Hall of fame
  assert(board.fame.biggestLoss && board.fame.biggestLoss.nickname === 'RoaringApe');
  assert(board.fame.mostReacted && board.fame.mostReacted.count >= 2);

  // Leaving closes tracked trades and hides profile
  ts = Date.now();
  r = await call('POST', 'leave', { wallet: a }, ta);
  assert.strictEqual(r.code, 200);
  const [{ n }] = await social.query(`SELECT count(*)::int AS n FROM trades WHERE closed_at IS NULL`);
  assert.strictEqual(n, 0);
  r = await call('GET', 'profile?id=' + t1.leaderId, null, tc);
  assert.strictEqual(r.code, 404);

  // Logout ends the session
  await call('POST', 'logout', {}, tb);
  r = await call('POST', 'react', { tradeId: t1.tradeId, kind: 'rocket' }, tb);
  assert.strictEqual(r.code, 401);

  await social.end();
  console.log('Community database flow: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
