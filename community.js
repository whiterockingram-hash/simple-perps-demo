// Simple Perps community: sign-in sessions, trade history, reactions, flairs, profiles,
// hall of fame, comments / DD posts with moderation, and phone alerts.
// Used by social.js, which owns the database connection and Hyperliquid access.

const crypto = require('crypto');

const SESSION_DAYS = 30;
const REACTIONS = ['diamond', 'rocket', 'ape', 'tendies', 'paper', 'bear'];
const COMMENT_MAX = 280, DD_MAX = 2000;
const POST_GAP_MS = 15000, POSTS_PER_DAY = 40, HIDE_AT_REPORTS = 3;

// ---- Flairs (pure, unit-tested) --------------------------------------------------------------
// t: { lev, maxLev, roe (current or final %), min_roe, opened_at, closed_at }
function tradeFlairs(t) {
  const out = [];
  const roe = t.final_roe ?? t.last_roe ?? 0;
  if ((t.min_roe ?? 0) <= -20 && roe >= 0) out.push('diamond_hands');
  if (t.closed_at && new Date(t.closed_at) - new Date(t.opened_at) < 10 * 60e3) out.push('paper_hands');
  if (t.lev >= Math.min(20, t.maxLev ?? t.max_lev ?? 20)) out.push('yolo');
  if (roe >= 100) out.push('tendies');
  return out;
}

// Trader flairs from their recent trades. weekLoser / weekWinner: leader ids chosen across everyone.
function traderFlairs(trades, { leaderId, weekLoser, weekWinner } = {}) {
  const since = Date.now() - 30 * 86400e3, week = Date.now() - 7 * 86400e3;
  const recent = trades.filter(t => new Date(t.closed_at || t.opened_at) >= since);
  const f = new Set();
  for (const t of recent) for (const x of tradeFlairs(t)) if (x !== 'paper_hands') f.add(x);
  if (recent.filter(t => t.closed_at && new Date(t.closed_at) >= week && tradeFlairs(t).includes('paper_hands')).length >= 3) f.add('paper_hands');
  if (leaderId && leaderId === weekWinner) f.add('king');
  if (leaderId && leaderId === weekLoser) f.add('loss_legend');
  return [...f];
}

// ---- Post filter (pure, unit-tested) -----------------------------------------------------------
const BLOCKED_PATTERNS = [
  [/https?:\/\/|www\.|\b[a-z0-9-]+\.(com|io|xyz|net|org|gg|me|app|link|ly)\b|t\.me\/|discord\.gg/i, 'Links aren\'t allowed'],
  [/0x[0-9a-f]{20,}/i, 'Wallet and contract addresses aren\'t allowed'],
  [/seed phrase|recovery phrase|private key|secret phrase|send me (your )?(eth|usdc|crypto)|dm me|airdrop claim/i, 'That looks like a scam message'],
  [/\b(n[i1]gg(er|a)s?|f[a@]gg?ots?|retards?|k[i1]kes?|ch[i1]nks?|sp[i1]cs?|tr[a@]nn(y|ies))\b/i, 'Keep it civil: no slurs'],
];
function checkPost(body, kind) {
  const text = String(body || '').trim();
  if (!text) return 'Write something first';
  if (text.length > (kind === 'dd' ? DD_MAX : COMMENT_MAX)) return `Too long: ${kind === 'dd' ? DD_MAX : COMMENT_MAX} characters max`;
  for (const [re, msg] of BLOCKED_PATTERNS) if (re.test(text)) return msg;
  return '';
}

const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const sessionMessage = (wallet, ts) => `Simple Perps\nSign in\nWallet: ${wallet}\nTime: ${ts}`;

function createCommunity({ q, hl, log, push = null, admins = [] }) {
  const adminSet = new Set(admins.map(a => a.toLowerCase()));

  async function init() {
    await q(`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, wallet TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY, leader_id INT NOT NULL REFERENCES leaders(id), coin TEXT NOT NULL, side TEXT NOT NULL,
        lev DOUBLE PRECISION, max_lev DOUBLE PRECISION, entry_px DOUBLE PRECISION, exit_px DOUBLE PRECISION,
        size_usd DOUBLE PRECISION, last_roe DOUBLE PRECISION NOT NULL DEFAULT 0, last_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
        max_roe DOUBLE PRECISION NOT NULL DEFAULT 0, min_roe DOUBLE PRECISION NOT NULL DEFAULT 0, final_roe DOUBLE PRECISION,
        opened_at TIMESTAMPTZ NOT NULL DEFAULT now(), closed_at TIMESTAMPTZ);
      CREATE UNIQUE INDEX IF NOT EXISTS trades_open ON trades(leader_id, coin) WHERE closed_at IS NULL;
      CREATE INDEX IF NOT EXISTS trades_closed ON trades(closed_at);
      CREATE TABLE IF NOT EXISTS reactions (
        trade_id INT NOT NULL REFERENCES trades(id), wallet TEXT NOT NULL, kind TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (trade_id, wallet, kind));
      CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY, trade_id INT REFERENCES trades(id), author TEXT NOT NULL, kind TEXT NOT NULL,
        body TEXT NOT NULL, reports INT NOT NULL DEFAULT 0, hidden BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS posts_trade ON posts(trade_id);
      CREATE TABLE IF NOT EXISTS post_reports (post_id INT NOT NULL, wallet TEXT NOT NULL, PRIMARY KEY (post_id, wallet));
      CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, wallet TEXT NOT NULL, sub JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS watches (wallet TEXT NOT NULL, leader_id INT NOT NULL, PRIMARY KEY (wallet, leader_id));
    `);
  }

  // ---- sessions: sign once, then reactions/comments need no MetaMask pop-ups ----
  async function createSession(wallet) {
    const token = crypto.randomBytes(32).toString('hex');
    await q(`INSERT INTO sessions (token_hash, wallet, expires_at) VALUES ($1, $2, $3)`,
      [sha(token), wallet, new Date(Date.now() + SESSION_DAYS * 86400e3)]);
    await q(`DELETE FROM sessions WHERE expires_at < now()`);
    return token;
  }
  async function sessionWallet(req) {
    const token = String(req.headers?.['x-session'] || '');
    if (!/^[0-9a-f]{64}$/.test(token)) return null;
    const [s] = await q(`SELECT wallet FROM sessions WHERE token_hash = $1 AND expires_at > now()`, [sha(token)]);
    return s?.wallet || null;
  }
  async function endSession(req) {
    const token = String(req.headers?.['x-session'] || '');
    if (token) await q(`DELETE FROM sessions WHERE token_hash = $1`, [sha(token)]);
  }

  let weekCache = { at: 0, v: null };

  // ---- trade history: called every board refresh with what each sharing trader holds ----
  // snapshot: [{ leaderId, nickname, positions: [{ coin, side, lev, maxLev, entryPx, markPx, roe, pnl, sizeUsd }] }]
  async function track(snapshot) {
    if (!snapshot.length) return new Map();
    const ids = snapshot.map(s => s.leaderId);
    const open = await q(`SELECT * FROM trades WHERE closed_at IS NULL AND leader_id = ANY($1)`, [ids]);
    const byKey = new Map(open.map(t => [`${t.leader_id}|${t.coin}`, t]));
    const result = new Map(), events = [];
    for (const s of snapshot) {
      const seen = new Set();
      for (const p of s.positions) {
        const key = `${s.leaderId}|${p.coin}`;
        seen.add(key);
        let t = byKey.get(key);
        if (t && t.side !== p.side) { // flipped: close the old trade, start a new one
          await closeTrade(t, p.markPx); events.push({ type: 'close', trade: t, nickname: s.nickname });
          t = null;
        }
        if (!t) {
          const [n] = await q(`INSERT INTO trades (leader_id, coin, side, lev, max_lev, entry_px, size_usd, last_roe, last_pnl, max_roe, min_roe)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$8) RETURNING *`, [s.leaderId, p.coin, p.side, p.lev, p.maxLev, p.entryPx, p.sizeUsd, p.roe, p.pnl]);
          t = n; events.push({ type: 'open', trade: t, nickname: s.nickname });
        } else {
          await q(`UPDATE trades SET lev = $2, entry_px = $3, size_usd = $4, last_roe = $5, last_pnl = $6,
                   max_roe = GREATEST(max_roe, $5), min_roe = LEAST(min_roe, $5) WHERE id = $1`,
            [t.id, p.lev, p.entryPx, p.sizeUsd, p.roe, p.pnl]);
          Object.assign(t, { last_roe: p.roe, min_roe: Math.min(t.min_roe, p.roe), max_roe: Math.max(t.max_roe, p.roe), lev: p.lev });
        }
        result.set(key, t);
      }
      for (const t of open.filter(t => t.leader_id === s.leaderId && !seen.has(`${t.leader_id}|${t.coin}`))) {
        await closeTrade(t, null); events.push({ type: 'close', trade: t, nickname: s.nickname });
      }
    }
    if (events.some(e => e.type === 'close')) weekCache.at = 0; // hall of fame changes when trades close
    for (const e of events) alertTrade(e).catch(err => log('alert failed', err.message));
    return result;
  }
  async function closeTrade(t, px) {
    await q(`UPDATE trades SET closed_at = now(), final_roe = last_roe, exit_px = $2 WHERE id = $1`, [t.id, px]);
    t.closed_at = new Date(); t.final_roe = t.last_roe;
  }
  async function closeAllFor(leaderId) {
    await q(`UPDATE trades SET closed_at = now(), final_roe = last_roe WHERE leader_id = $1 AND closed_at IS NULL`, [leaderId]);
  }

  // ---- weekly picks used for flairs and the hall of fame ----
  async function week() {
    if (weekCache.v && Date.now() - weekCache.at < 60000) return weekCache.v;
    const rows = await q(`SELECT t.*, l.nickname FROM trades t JOIN leaders l ON l.id = t.leader_id
                          WHERE t.closed_at > now() - interval '7 days' AND l.active`);
    const best = rows.reduce((a, t) => (!a || t.final_roe > a.final_roe ? t : a), null);
    const worst = rows.reduce((a, t) => (!a || t.final_roe < a.final_roe ? t : a), null);
    const [react] = await q(`SELECT t.*, l.nickname, count(*)::int AS n FROM reactions r JOIN trades t ON t.id = r.trade_id
                             JOIN leaders l ON l.id = t.leader_id WHERE r.created_at > now() - interval '7 days' AND l.active
                             GROUP BY t.id, l.nickname ORDER BY n DESC LIMIT 1`);
    const [diamond] = await q(`SELECT t.*, l.nickname, count(*)::int AS n FROM reactions r JOIN trades t ON t.id = r.trade_id
                               JOIN leaders l ON l.id = t.leader_id WHERE r.kind = 'diamond' AND r.created_at > now() - interval '7 days' AND l.active
                               GROUP BY t.id, l.nickname ORDER BY n DESC LIMIT 1`);
    const [followed] = await q(`SELECT l.id, l.nickname, count(*)::int AS n FROM follows f JOIN leaders l ON l.id = f.leader_id
                                WHERE f.status = 'active' AND l.active GROUP BY l.id ORDER BY n DESC LIMIT 1`);
    const v = {
      weekWinner: best && best.final_roe > 0 ? best.leader_id : null,
      weekLoser: worst && worst.final_roe < 0 ? worst.leader_id : null,
      fame: {
        biggestGain: best && best.final_roe > 0 ? pub(best) : null,
        biggestLoss: worst && worst.final_roe < 0 ? pub(worst) : null,
        mostReacted: react ? { ...pub(react), count: react.n } : null,
        mostDiamond: diamond ? { ...pub(diamond), count: diamond.n } : null,
        mostFollowed: followed ? { leaderId: followed.id, nickname: followed.nickname, count: followed.n } : null,
      },
    };
    weekCache = { at: Date.now(), v };
    return v;
  }
  const pub = t => ({ tradeId: t.id, leaderId: t.leader_id, nickname: t.nickname, coin: t.coin, side: t.side, lev: t.lev,
    roe: t.final_roe ?? t.last_roe, entryPx: t.entry_px, exitPx: t.exit_px, openedAt: t.opened_at, closedAt: t.closed_at,
    flairs: tradeFlairs(t) });

  // Add ids, reactions, comment counts and flairs to the board for this viewer
  async function decorate(board, viewer) {
    const ids = board.trades.map(t => t.tradeId).filter(Boolean);
    const counts = ids.length ? await q(`SELECT trade_id, kind, count(*)::int AS n FROM reactions WHERE trade_id = ANY($1) GROUP BY 1, 2`, [ids]) : [];
    const mine = ids.length && viewer ? await q(`SELECT trade_id, kind FROM reactions WHERE trade_id = ANY($1) AND wallet = $2`, [ids, viewer]) : [];
    const posts = ids.length ? await q(`SELECT trade_id, count(*)::int AS n, bool_or(kind = 'dd') AS dd FROM posts
                                        WHERE trade_id = ANY($1) AND NOT hidden GROUP BY 1`, [ids]) : [];
    const leaderIds = [...new Set(board.traders.map(t => t.id))];
    const history = leaderIds.length ? await q(`SELECT * FROM trades WHERE leader_id = ANY($1) AND (closed_at IS NULL OR closed_at > now() - interval '30 days')`, [leaderIds]) : [];
    const wk = await week();
    const flairsOf = id => traderFlairs(history.filter(t => t.leader_id === id), { leaderId: id, ...wk });
    return {
      ...board,
      trades: board.trades.map(t => ({
        ...t,
        reactions: Object.fromEntries(counts.filter(c => c.trade_id === t.tradeId).map(c => [c.kind, c.n])),
        mine: mine.filter(m => m.trade_id === t.tradeId).map(m => m.kind),
        comments: posts.find(p => p.trade_id === t.tradeId)?.n || 0,
        hasDD: !!posts.find(p => p.trade_id === t.tradeId)?.dd,
        flairs: tradeFlairs(t.row || {}),
        traderFlairs: flairsOf(t.leaderId),
        row: undefined,
      })),
      traders: board.traders.map(t => ({ ...t, flairs: flairsOf(t.id) })),
      fame: wk.fame,
    };
  }

  // ---- reactions ----
  async function react(wallet, tradeId, kind) {
    if (!REACTIONS.includes(kind)) return [400, 'Unknown reaction'];
    const [t] = await q(`SELECT id FROM trades WHERE id = $1`, [Number(tradeId)]);
    if (!t) return [404, 'Trade not found'];
    const del = await q(`DELETE FROM reactions WHERE trade_id = $1 AND wallet = $2 AND kind = $3 RETURNING 1`, [t.id, wallet, kind]);
    if (!del.length) await q(`INSERT INTO reactions (trade_id, wallet, kind) VALUES ($1, $2, $3)`, [t.id, wallet, kind]);
    const [c] = await q(`SELECT count(*)::int AS n FROM reactions WHERE trade_id = $1 AND kind = $2`, [t.id, kind]);
    return [200, { on: !del.length, count: c.n }];
  }

  // ---- profiles ----
  async function profile(leaderId, viewer) {
    const [L] = await q(`SELECT id, nickname, active, joined_at,
        (SELECT count(*) FROM follows f WHERE f.leader_id = leaders.id AND f.status = 'active')::int AS followers
      FROM leaders WHERE id = $1`, [Number(leaderId)]);
    if (!L || !L.active) return [404, 'Trader not found'];
    const trades = await q(`SELECT * FROM trades WHERE leader_id = $1 ORDER BY opened_at DESC LIMIT 100`, [L.id]);
    const closed = trades.filter(t => t.closed_at);
    const wins = closed.filter(t => t.final_roe > 0).length;
    const wk = await week();
    const watching = viewer ? (await q(`SELECT 1 FROM watches WHERE wallet = $1 AND leader_id = $2`, [viewer, L.id])).length > 0 : false;
    const dds = await q(`SELECT p.id, p.body, p.created_at, t.coin, t.side FROM posts p JOIN trades t ON t.id = p.trade_id
                         WHERE t.leader_id = $1 AND p.kind = 'dd' AND NOT p.hidden ORDER BY p.created_at DESC LIMIT 10`, [L.id]);
    return [200, {
      id: L.id, nickname: L.nickname, joinedAt: L.joined_at, followers: L.followers, watching,
      flairs: traderFlairs(trades, { leaderId: L.id, ...wk }),
      stats: {
        trades: closed.length, winRate: closed.length ? wins / closed.length * 100 : null,
        avgRoe: closed.length ? closed.reduce((a, t) => a + t.final_roe, 0) / closed.length : null,
        best: closed.length ? Math.max(...closed.map(t => t.final_roe)) : null,
        worst: closed.length ? Math.min(...closed.map(t => t.final_roe)) : null,
      },
      trades: trades.slice(0, 30).map(t => ({ ...pub({ ...t, nickname: L.nickname }), open: !t.closed_at })),
      dd: dds,
    }];
  }

  // ---- comments and DD posts ----
  const nicknameOf = async wallet => (await q(`SELECT nickname FROM leaders WHERE wallet = $1`, [wallet]))[0]?.nickname || null;

  async function listPosts(tradeId, viewer) {
    const [t] = await q(`SELECT t.*, l.nickname, l.wallet AS owner FROM trades t JOIN leaders l ON l.id = t.leader_id WHERE t.id = $1`, [Number(tradeId)]);
    if (!t) return [404, 'Trade not found'];
    const posts = await q(`SELECT p.id, p.kind, p.body, p.created_at, p.author, l.nickname, l.id AS author_leader_id, l.active AS author_sharing
                           FROM posts p LEFT JOIN leaders l ON l.wallet = p.author
                           WHERE p.trade_id = $1 AND NOT p.hidden ORDER BY (p.kind = 'dd') DESC, p.created_at ASC LIMIT 300`, [t.id]);
    return [200, {
      trade: pub(t), isOwner: viewer === t.owner, isAdmin: adminSet.has(viewer || ''),
      posts: posts.map(p => ({ id: p.id, kind: p.kind, body: p.body, createdAt: p.created_at, nickname: p.nickname || 'anon ape',
        authorLeaderId: p.author_sharing ? p.author_leader_id : null, mine: p.author === viewer, byOwner: p.author === t.owner })),
    }];
  }

  async function addPost(wallet, b) {
    const kind = b.kind === 'dd' ? 'dd' : 'comment';
    const err = checkPost(b.body, kind);
    if (err) return [400, err];
    const nick = await nicknameOf(wallet);
    if (!nick) return [409, 'Pick a nickname first'];
    const [t] = await q(`SELECT t.id, t.coin, t.side, l.wallet AS owner, l.nickname FROM trades t JOIN leaders l ON l.id = t.leader_id WHERE t.id = $1`, [Number(b.tradeId)]);
    if (!t) return [404, 'Trade not found'];
    if (kind === 'dd' && t.owner !== wallet) return [403, 'Only the trader can post DD on their own trade'];
    const [last] = await q(`SELECT max(created_at) AS at, count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS today
                            FROM posts WHERE author = $1`, [wallet]);
    if (last.at && Date.now() - new Date(last.at) < POST_GAP_MS) return [429, 'Slow down a little, try again in a few seconds'];
    if (last.today >= POSTS_PER_DAY) return [429, 'Daily post limit reached'];
    const [p] = await q(`INSERT INTO posts (trade_id, author, kind, body) VALUES ($1, $2, $3, $4) RETURNING id`, [t.id, wallet, kind, String(b.body).trim()]);
    if (t.owner !== wallet) alertWallets([t.owner], { title: `💬 ${nick} on your ${label(t.coin)} ${t.side}`, body: String(b.body).slice(0, 120), tag: `post-${t.id}` }).catch(() => {});
    return [200, { id: p.id }];
  }

  async function deletePost(wallet, postId) {
    const [p] = await q(`SELECT id, author FROM posts WHERE id = $1`, [Number(postId)]);
    if (!p) return [404, 'Post not found'];
    if (p.author !== wallet && !adminSet.has(wallet)) return [403, 'You can only delete your own posts'];
    await q(`UPDATE posts SET hidden = TRUE WHERE id = $1`, [p.id]);
    return [200, 'ok'];
  }

  async function reportPost(wallet, postId) {
    const [p] = await q(`SELECT id, author FROM posts WHERE id = $1`, [Number(postId)]);
    if (!p) return [404, 'Post not found'];
    if (p.author === wallet) return [400, "You can't report your own post"];
    const added = await q(`INSERT INTO post_reports (post_id, wallet) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1`, [p.id, wallet]);
    if (added.length) await q(`UPDATE posts SET reports = reports + 1, hidden = (reports + 1 >= $2) WHERE id = $1`, [p.id, HIDE_AT_REPORTS]);
    if (adminSet.has(wallet)) await q(`UPDATE posts SET hidden = TRUE WHERE id = $1`, [p.id]);
    return [200, 'ok'];
  }

  // ---- phone alerts ----
  const label = coin => String(coin).replace(/^[a-z]+:/, '');
  async function savePush(wallet, sub) {
    if (!push) return [503, 'Alerts are not switched on yet'];
    if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return [400, 'Bad subscription'];
    await q(`INSERT INTO push_subs (endpoint, wallet, sub) VALUES ($1, $2, $3)
             ON CONFLICT (endpoint) DO UPDATE SET wallet = EXCLUDED.wallet, sub = EXCLUDED.sub`, [sub.endpoint, wallet, JSON.stringify(sub)]);
    return [200, 'ok'];
  }
  async function watch(wallet, leaderId, on) {
    if (on) await q(`INSERT INTO watches (wallet, leader_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [wallet, Number(leaderId)]);
    else await q(`DELETE FROM watches WHERE wallet = $1 AND leader_id = $2`, [wallet, Number(leaderId)]);
    return [200, { watching: !!on }];
  }
  async function alertWallets(wallets, payload) {
    if (!push || !wallets.length) return;
    const subs = await q(`SELECT endpoint, sub FROM push_subs WHERE wallet = ANY($1)`, [wallets]);
    for (const s of subs) {
      try { await push.sendNotification(s.sub, JSON.stringify(payload), { TTL: 3600 }); }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await q(`DELETE FROM push_subs WHERE endpoint = $1`, [s.endpoint]); }
    }
  }
  async function alertTrade({ type, trade, nickname }) {
    const rows = await q(`SELECT wallet FROM watches WHERE leader_id = $1
                          UNION SELECT follower FROM follows WHERE leader_id = $1 AND status = 'active'`, [trade.leader_id]);
    const side = trade.side === 'long' ? 'LONG' : 'SHORT';
    const payload = type === 'open'
      ? { title: `🚀 ${nickname} opened ${label(trade.coin)} ${side} ${Math.round(trade.lev || 1)}x`, body: 'Tap to see the trade', tag: `trade-${trade.id}` }
      : { title: `${(trade.final_roe ?? 0) >= 0 ? '🍗' : '💀'} ${nickname} closed ${label(trade.coin)} ${side}`,
          body: `${(trade.final_roe ?? 0) >= 0 ? '+' : ''}${Number(trade.final_roe ?? 0).toFixed(1)}%`, tag: `trade-${trade.id}` };
    await alertWallets(rows.map(r => r.wallet), payload);
  }

  return { init, createSession, sessionWallet, endSession, track, closeAllFor, decorate, react, profile,
    listPosts, addPost, deletePost, reportPost, savePush, watch, isAdmin: w => adminSet.has(w || '') };
}

module.exports = { createCommunity, tradeFlairs, traderFlairs, checkPost, sessionMessage, REACTIONS };
