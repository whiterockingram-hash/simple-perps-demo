// Simple Perps: leaderboard, one-tap copy data, and auto-follow (copy trading).
//
// How auto-follow works
// - A follower picks a trader and sets limits. Their browser creates a trading key, the follower approves
//   it once in MetaMask (Hyperliquid "agent" key named "copy"), and the key is sent here and stored encrypted.
//   Hyperliquid agent keys can place trades but can never withdraw or transfer funds.
// - Every few seconds the server compares each followed trader's positions with what it has copied and
//   opens, trims or closes the follower's matching trades, always within the follower's limits and the
//   site-wide trade cap.
// - Only trades the leader opens AFTER the follow starts are copied. Existing positions are left alone.
// - Follows last 30 days, then must be renewed in the app (which re-checks location). Paused or expired
//   follows still close and trim copied trades so nobody is left holding a trade the leader exited.
//
// Settings (Render → Environment): DATABASE_URL, COPY_KEY_SECRET (64 hex chars).

const crypto = require('crypto');

const COPY_LEVERAGE_MAX = 10;          // never copy at more than 10x, whatever the leader uses
const MIN_ORDER_USD = 10;              // Hyperliquid's minimum order value
const FOLLOW_DAYS = 30;                // monthly renewal (re-checks location)
const TICK_MS = 4000;
const MAX_ERRORS = 5;                  // pause a follow after this many failures in a row
const SIG_MAX_AGE_MS = 10 * 60 * 1000; // signed requests must be fresh

// ---- Pure helpers (unit-tested) ---------------------------------------------------------------
const sideOf = szi => (szi > 0 ? 'long' : 'short');
const roundDown = (x, dec) => { const f = 10 ** dec; return Math.floor(x * f + 1e-9) / f; };

// Hyperliquid prices: at most 5 significant figures and (6 - size decimals) decimal places
function fmtPx(x, szDecimals) {
  const maxDec = Math.max(0, 6 - (szDecimals || 0));
  return String(Number(Number(Number(x).toPrecision(5)).toFixed(maxDec)));
}

// Decide what to do for one follow. No network calls: everything is passed in.
//   follow:   { per_trade_usd, max_total_usd, stop_pct, ignore, status }
//   copies:   open copy records [{ id, coin, side, leader_sz, follower_sz }]
//   leader:   Map coin -> { szi, lev }
//   follower: Map coin -> szi
//   mids:     { coin: price }, meta: { coin: { szDecimals, maxLeverage } }, cap: site-wide max order USD
// Returns { actions, ignore } where actions are open / reduce / close / forget / skip.
function planFollow({ follow, copies, leader, follower, mids, meta, cap }) {
  const ignore = { ...(follow.ignore || {}) };
  const actions = [];
  const canOpen = follow.status === 'active';

  // Ignored positions: once the leader closes or flips them, they're fair game again
  for (const [coin, s] of Object.entries(ignore)) {
    const L = leader.get(coin);
    if (!L || sideOf(L.szi) !== s) delete ignore[coin];
  }

  const covered = new Set();
  let usedUsd = 0;
  for (const c of copies) {
    covered.add(c.coin);
    const L = leader.get(c.coin);
    const F = follower.get(c.coin) || 0;
    const fAbs = F && sideOf(F) === c.side ? Math.abs(F) : 0;
    const szd = meta[c.coin]?.szDecimals ?? 4;
    const isBuy = c.side === 'short'; // closing a short buys

    if (!fAbs) { // follower's trade is already gone: stop-loss hit or closed by hand
      actions.push({ kind: 'forget', copyId: c.id, coin: c.coin });
      if (L && sideOf(L.szi) === c.side) ignore[c.coin] = c.side; // don't jump back in
      continue;
    }
    const held = Math.min(c.follower_sz, fAbs);
    if (!L || sideOf(L.szi) !== c.side) { // leader closed or flipped
      actions.push({ kind: 'close', copyId: c.id, coin: c.coin, isBuy, sz: held });
      continue;
    }
    const ratio = Math.abs(L.szi) / c.leader_sz;
    if (ratio < 0.9) { // leader trimmed by 10% or more: trim the same share
      const keep = roundDown(c.follower_sz * ratio, szd);
      const sz = roundDown(held - keep, szd);
      if (keep * (mids[c.coin] || 0) < MIN_ORDER_USD) {
        actions.push({ kind: 'close', copyId: c.id, coin: c.coin, isBuy, sz: held });
        continue;
      }
      if (sz > 0) actions.push({ kind: 'reduce', copyId: c.id, coin: c.coin, isBuy, sz, leaderSz: Math.abs(L.szi), followerSz: keep });
      usedUsd += keep * (mids[c.coin] || 0);
      continue;
    }
    usedUsd += held * (mids[c.coin] || 0);
  }

  if (canOpen) {
    for (const [coin, L] of leader) {
      if (covered.has(coin) || ignore[coin]) continue;
      const m = meta[coin], mid = mids[coin];
      if (!m || !mid) continue;
      const s = sideOf(L.szi);
      if (follower.get(coin)) { ignore[coin] = s; actions.push({ kind: 'skip', coin, reason: 'You already have your own trade on this market' }); continue; }
      const usd = Math.min(follow.per_trade_usd, cap || Infinity);
      if (usedUsd + usd > follow.max_total_usd + 0.01) { ignore[coin] = s; actions.push({ kind: 'skip', coin, reason: 'Your total limit is used up' }); continue; }
      const sz = roundDown(usd / mid, m.szDecimals);
      if (sz * mid < MIN_ORDER_USD) { ignore[coin] = s; actions.push({ kind: 'skip', coin, reason: 'Trade size is below the $10 minimum' }); continue; }
      const lev = Math.max(1, Math.min(Math.round(L.lev || 1), COPY_LEVERAGE_MAX, m.maxLeverage || COPY_LEVERAGE_MAX));
      const pct = Number(follow.stop_pct) || 0;
      const stopPx = pct ? mid * (s === 'long' ? 1 - pct / 100 : 1 + pct / 100) : 0;
      actions.push({ kind: 'open', coin, side: s, isBuy: s === 'long', sz, lev, leaderSz: Math.abs(L.szi), stopPx });
      usedUsd += sz * mid;
    }
  }
  return { actions, ignore };
}

// ---- Encryption for stored copy keys (AES-256-GCM) -------------------------------------------
function makeVault(secretHex) {
  if (!/^[0-9a-f]{64}$/i.test(secretHex || '')) return null;
  const key = Buffer.from(secretHex, 'hex');
  return {
    seal(text) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
      return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
    },
    open(sealed) {
      const [iv, tag, enc] = sealed.split('.').map(s => Buffer.from(s, 'base64'));
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
    },
  };
}

// ---- Signed messages (prove a wallet asked for something) --------------------------------------
const messages = {
  join: (wallet, nickname, ts) => `Simple Perps leaderboard\nShow my open trades as: ${nickname}\nWallet: ${wallet}\nTime: ${ts}`,
  leave: (wallet, ts) => `Simple Perps leaderboard\nRemove my trades\nWallet: ${wallet}\nTime: ${ts}`,
  stop: (wallet, id, closeTrades, ts) => `Simple Perps\nStop following #${id}${closeTrades ? ' and close copied trades' : ''}\nWallet: ${wallet}\nTime: ${ts}`,
  renew: (wallet, id, ts) => `Simple Perps\nRenew following #${id} for ${FOLLOW_DAYS} days\nWallet: ${wallet}\nTime: ${ts}`,
};

const isAddr = a => /^0x[0-9a-fA-F]{40}$/.test(a || '');
const NICK_RE = /^[A-Za-z0-9 _.-]{2,20}$/;

// ---- The service ---------------------------------------------------------------------------------
function createSocial(opts) {
  const { network, hlApi, cap, markets, builder, builderFee, checkLocation, isBlockedPlace, log = console.log } = opts;
  const dbUrl = opts.databaseUrl || process.env.DATABASE_URL || '';
  const vault = makeVault(opts.secret ?? process.env.COPY_KEY_SECRET);
  const hl = opts.hl || makeHl({ network, hlApi, markets });
  const enabled = !!dbUrl;
  const copyEnabled = enabled && !!vault;

  let pool = null;
  if (enabled) {
    const { Pool } = require('pg');
    const ssl = /\.render\.com/.test(dbUrl) ? { rejectUnauthorized: false } : false;
    pool = new Pool({ connectionString: dbUrl, ssl, max: 5 });
    pool.on('error', e => log('db error', e.message));
  }
  const q = (text, params) => pool.query(text, params).then(r => r.rows);

  async function init() {
    if (!enabled) return;
    await q(`
      CREATE TABLE IF NOT EXISTS leaders (
        id SERIAL PRIMARY KEY, wallet TEXT UNIQUE NOT NULL, nickname TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE, joined_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS copy_keys (
        follower TEXT PRIMARY KEY, agent_address TEXT NOT NULL, key_enc TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS follows (
        id SERIAL PRIMARY KEY, follower TEXT NOT NULL, leader_id INT NOT NULL REFERENCES leaders(id),
        per_trade_usd DOUBLE PRECISION NOT NULL, max_total_usd DOUBLE PRECISION NOT NULL,
        stop_pct DOUBLE PRECISION, builder_ok BOOLEAN NOT NULL DEFAULT FALSE,
        residence TEXT NOT NULL, country TEXT, status TEXT NOT NULL DEFAULT 'active', status_reason TEXT,
        ignore JSONB NOT NULL DEFAULT '{}', errors INT NOT NULL DEFAULT 0, last_error TEXT,
        expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS follows_follower ON follows(follower);
      CREATE TABLE IF NOT EXISTS copies (
        id SERIAL PRIMARY KEY, follow_id INT NOT NULL REFERENCES follows(id), coin TEXT NOT NULL,
        side TEXT NOT NULL, leader_sz DOUBLE PRECISION NOT NULL, follower_sz DOUBLE PRECISION NOT NULL,
        entry_px DOUBLE PRECISION, status TEXT NOT NULL DEFAULT 'open',
        opened_at TIMESTAMPTZ NOT NULL DEFAULT now(), closed_at TIMESTAMPTZ);
      CREATE INDEX IF NOT EXISTS copies_open ON copies(follow_id) WHERE status = 'open';
    `);
  }

  // ---- signature check (EIP-191 personal_sign) ----
  async function verifySigned(wallet, message, signature, ts) {
    if (!isAddr(wallet) || !signature) return 'Missing signature';
    if (!(Math.abs(Date.now() - Number(ts)) < SIG_MAX_AGE_MS)) return 'Request expired, please try again';
    const { verifyMessage } = await import('viem');
    const ok = await verifyMessage({ address: wallet, message, signature }).catch(() => false);
    return ok ? '' : 'Signature does not match this wallet';
  }

  async function locationOk(req, residence) {
    const loc = await checkLocation(req);
    if (!loc.allowed) return { error: loc.reason, loc };
    const [dc, dr] = String(residence || '').split('-');
    if (!residence) return { error: 'Confirm where you live first', loc };
    if (isBlockedPlace(dc, dr)) return { error: 'Not available where you live', loc };
    return { error: '', loc };
  }

  // ---- leaderboard ----
  let boardCache = { at: 0, data: null };
  async function leaderboard() {
    if (boardCache.data && Date.now() - boardCache.at < 15000) return boardCache.data;
    const leaders = await q(`SELECT l.id, l.wallet, l.nickname,
        (SELECT count(*) FROM follows f WHERE f.leader_id = l.id AND f.status = 'active')::int AS followers
      FROM leaders l WHERE l.active ORDER BY l.id`);
    const mids = await hl.mids();
    const trades = [], traders = [];
    for (const L of leaders) {
      try {
        const [st, trig] = await Promise.all([hl.state(L.wallet), hl.triggers(L.wallet)]);
        let pnl = 0, margin = 0;
        for (const p of st.positions) {
          const t = trig.filter(o => o.coin === p.coin);
          const tp = t.find(o => o.kind === 'tp'), sl = t.find(o => o.kind === 'sl');
          pnl += p.unrealizedPnl; margin += p.marginUsed;
          trades.push({ leaderId: L.id, nickname: L.nickname, followers: L.followers, coin: p.coin, side: sideOf(p.szi),
            lev: p.lev, sizeUsd: Math.abs(p.szi) * (mids[p.coin] || p.entryPx), entryPx: p.entryPx, markPx: mids[p.coin] || null,
            pnl: p.unrealizedPnl, roe: p.roe * 100, tp: tp ? tp.px : null, sl: sl ? sl.px : null });
        }
        traders.push({ id: L.id, nickname: L.nickname, followers: L.followers, openTrades: st.positions.length,
          pnl, roe: margin ? pnl / margin * 100 : 0 });
      } catch (e) { log('leaderboard read failed', L.id, e.message); }
    }
    trades.sort((a, b) => b.roe - a.roe);
    traders.sort((a, b) => b.roe - a.roe);
    boardCache = { at: Date.now(), data: { trades: trades.slice(0, 50), traders, copyEnabled } };
    return boardCache.data;
  }

  async function joinBoard(req, b) {
    const wallet = String(b.wallet || '').toLowerCase(), nickname = String(b.nickname || '').trim();
    if (!NICK_RE.test(nickname)) return [400, 'Nickname: 2–20 letters, numbers, spaces, _ . -'];
    const err = await verifySigned(wallet, messages.join(wallet, nickname, b.ts), b.sig, b.ts);
    if (err) return [403, err];
    const { error } = await locationOk(req, b.residence);
    if (error) return [403, error];
    const taken = await q(`SELECT 1 FROM leaders WHERE lower(nickname) = lower($1) AND wallet <> $2 AND active`, [nickname, wallet]);
    if (taken.length) return [409, 'That nickname is taken'];
    await q(`INSERT INTO leaders (wallet, nickname) VALUES ($1, $2)
             ON CONFLICT (wallet) DO UPDATE SET nickname = EXCLUDED.nickname, active = TRUE`, [wallet, nickname]);
    boardCache.at = 0;
    return [200, 'ok'];
  }

  async function leaveBoard(b) {
    const wallet = String(b.wallet || '').toLowerCase();
    const err = await verifySigned(wallet, messages.leave(wallet, b.ts), b.sig, b.ts);
    if (err) return [403, err];
    const [L] = await q(`UPDATE leaders SET active = FALSE WHERE wallet = $1 RETURNING id`, [wallet]);
    if (L) await q(`UPDATE follows SET status = 'paused', status_reason = 'Trader left the leaderboard', updated_at = now()
                    WHERE leader_id = $1 AND status = 'active'`, [L.id]);
    boardCache.at = 0;
    return [200, 'ok'];
  }

  // ---- follows ----
  async function startFollow(req, b) {
    if (!copyEnabled) return [503, 'Auto-follow is not switched on yet'];
    const follower = String(b.follower || '').toLowerCase();
    const leaderId = Number(b.leaderId), per = Number(b.perTradeUsd), total = Number(b.maxTotalUsd);
    const stop = b.stopPct === null || b.stopPct === '' || b.stopPct === undefined ? null : Number(b.stopPct);
    if (!isAddr(follower)) return [400, 'Connect your wallet first'];
    if (!(per >= MIN_ORDER_USD)) return [400, `Amount per trade must be at least $${MIN_ORDER_USD}`];
    if (cap && per > cap) return [400, `Amount per trade can be at most $${cap} for now`];
    if (!(total >= per) || total > 100000) return [400, 'Total limit must be at least the amount per trade'];
    if (stop !== null && !(stop >= 1 && stop <= 50)) return [400, 'Stop-loss must be between 1% and 50%'];
    if (!/^0x[0-9a-fA-F]{64}$/.test(b.agentKey || '')) return [400, 'Missing trading key'];

    const [leader] = await q(`SELECT id, wallet, nickname FROM leaders WHERE id = $1 AND active`, [leaderId]);
    if (!leader) return [404, 'That trader is no longer on the leaderboard'];
    if (leader.wallet === follower) return [400, "You can't follow yourself"];

    const { error, loc } = await locationOk(req, b.residence);
    if (error) return [403, error];

    // The key must be one this wallet approved on Hyperliquid. That proves the follower owns the wallet.
    const { privateKeyToAccount } = await import('viem/accounts');
    const agentAddress = privateKeyToAccount(b.agentKey).address.toLowerCase();
    let approved = false;
    for (let i = 0; i < 5 && !approved; i++) {
      const agents = await hl.agents(follower).catch(() => []);
      approved = agents.some(a => String(a.address).toLowerCase() === agentAddress);
      if (!approved) await new Promise(r => setTimeout(r, 1500));
    }
    if (!approved) return [403, 'Hyperliquid has not confirmed the trading key yet. Try again in a moment.'];

    const builderOk = await hl.builderOk(follower, builder, builderFee).catch(() => false);

    await q(`INSERT INTO copy_keys (follower, agent_address, key_enc) VALUES ($1, $2, $3)
             ON CONFLICT (follower) DO UPDATE SET agent_address = EXCLUDED.agent_address, key_enc = EXCLUDED.key_enc, updated_at = now()`,
      [follower, agentAddress, vault.seal(b.agentKey)]);
    clients.delete(follower);
    const expires = new Date(Date.now() + FOLLOW_DAYS * 86400e3);
    const [existing] = await q(`SELECT id, ignore FROM follows WHERE follower = $1 AND leader_id = $2 AND status <> 'stopped'`, [follower, leader.id]);
    const ignore = await freshIgnore(existing?.id, leader.wallet, existing?.ignore);
    if (existing) {
      await q(`UPDATE follows SET per_trade_usd = $2, max_total_usd = $3, stop_pct = $4, builder_ok = $5, residence = $6,
               country = $7, status = 'active', status_reason = NULL, errors = 0, last_error = NULL, expires_at = $8,
               ignore = $9, updated_at = now() WHERE id = $1`,
        [existing.id, per, total, stop, builderOk, b.residence, loc.country, expires, JSON.stringify(ignore)]);
    } else {
      await q(`INSERT INTO follows (follower, leader_id, per_trade_usd, max_total_usd, stop_pct, builder_ok, residence, country, ignore, expires_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [follower, leader.id, per, total, stop, builderOk, b.residence, loc.country, JSON.stringify(ignore), expires]);
    }
    log(`follow started: ${follower.slice(0, 8)} → leader #${leader.id}`);
    return [200, 'ok'];
  }

  // Only trades the leader opens from now on get copied
  async function freshIgnore(followId, leaderWallet, current = {}) {
    const lstate = await hl.state(leaderWallet);
    const open = followId ? await q(`SELECT coin FROM copies WHERE follow_id = $1 AND status = 'open'`, [followId]) : [];
    const covered = new Set(open.map(c => c.coin));
    const ignore = { ...current };
    for (const p of lstate.positions) if (!covered.has(p.coin)) ignore[p.coin] = sideOf(p.szi);
    return ignore;
  }

  async function ownFollow(wallet, id) {
    const [f] = await q(`SELECT * FROM follows WHERE id = $1 AND follower = $2`, [Number(id), wallet]);
    return f;
  }

  async function stopFollow(b) {
    const wallet = String(b.wallet || '').toLowerCase(), closeTrades = !!b.closeTrades;
    const err = await verifySigned(wallet, messages.stop(wallet, b.followId, closeTrades, b.ts), b.sig, b.ts);
    if (err) return [403, err];
    const f = await ownFollow(wallet, b.followId);
    if (!f) return [404, 'Follow not found'];
    if (closeTrades) {
      const copies = await q(`SELECT * FROM copies WHERE follow_id = $1 AND status = 'open'`, [f.id]);
      const fstate = await hl.state(wallet);
      const fmap = new Map(fstate.positions.map(p => [p.coin, p.szi]));
      for (const c of copies) {
        const F = fmap.get(c.coin) || 0;
        const held = F && sideOf(F) === c.side ? Math.min(c.follower_sz, Math.abs(F)) : 0;
        if (held) await execute(f, { kind: 'close', copyId: c.id, coin: c.coin, isBuy: c.side === 'short', sz: held }).catch(e => log('stop close failed', e.message));
        else await q(`UPDATE copies SET status = 'closed', closed_at = now() WHERE id = $1`, [c.id]);
      }
    }
    await q(`UPDATE follows SET status = 'stopped', status_reason = 'Stopped by you', updated_at = now() WHERE id = $1`, [f.id]);
    return [200, 'ok'];
  }

  async function renewFollow(req, b) {
    const wallet = String(b.wallet || '').toLowerCase();
    const err = await verifySigned(wallet, messages.renew(wallet, b.followId, b.ts), b.sig, b.ts);
    if (err) return [403, err];
    const f = await ownFollow(wallet, b.followId);
    if (!f || f.status === 'stopped') return [404, 'Follow not found'];
    const { error } = await locationOk(req, b.residence || f.residence);
    if (error) return [403, error];
    const [L] = await q(`SELECT active, wallet FROM leaders WHERE id = $1`, [f.leader_id]);
    if (!L?.active) return [409, 'That trader left the leaderboard'];
    const ignore = await freshIgnore(f.id, L.wallet, f.ignore); // skip anything opened while paused
    await q(`UPDATE follows SET status = 'active', status_reason = NULL, errors = 0, expires_at = $2, ignore = $3, updated_at = now() WHERE id = $1`,
      [f.id, new Date(Date.now() + FOLLOW_DAYS * 86400e3), JSON.stringify(ignore)]);
    return [200, 'ok'];
  }

  async function me(wallet) {
    wallet = String(wallet || '').toLowerCase();
    if (!isAddr(wallet)) return { leader: null, follows: [] };
    const [leader] = await q(`SELECT id, nickname, active FROM leaders WHERE wallet = $1`, [wallet]);
    const follows = await q(`SELECT f.id, f.leader_id, l.nickname, f.per_trade_usd, f.max_total_usd, f.stop_pct, f.status,
        f.status_reason, f.last_error, f.expires_at,
        (SELECT json_agg(json_build_object('coin', c.coin, 'side', c.side, 'size', c.follower_sz, 'entryPx', c.entry_px))
           FROM copies c WHERE c.follow_id = f.id AND c.status = 'open') AS copies
      FROM follows f JOIN leaders l ON l.id = f.leader_id WHERE f.follower = $1 AND f.status <> 'stopped' ORDER BY f.id`, [wallet]);
    return { leader: leader?.active ? { id: leader.id, nickname: leader.nickname } : null, follows, copyEnabled };
  }

  // ---- the copy engine ----
  const clients = new Map(); // follower -> ExchangeClient
  async function clientFor(follower) {
    if (clients.has(follower)) return clients.get(follower);
    const [k] = await q(`SELECT key_enc FROM copy_keys WHERE follower = $1`, [follower]);
    if (!k) throw new Error('No trading key on file');
    const c = await hl.client(vault.open(k.key_enc));
    clients.set(follower, c);
    return c;
  }

  async function execute(follow, a) {
    const mids = await hl.mids();
    const m = hl.meta()[a.coin];
    if (!m) throw new Error('Unknown market ' + a.coin);
    const client = await clientFor(follow.follower);
    const mid = mids[a.coin];
    if (a.kind === 'open') {
      if (cap && a.sz * mid > cap * 1.02) throw new Error('Above the trade cap');
      try { await client.updateLeverage({ asset: m.asset, isCross: true, leverage: a.lev }); }
      catch { await client.updateLeverage({ asset: m.asset, isCross: false, leverage: a.lev }); } // isolated-only markets
      const orders = [{ a: m.asset, b: a.isBuy, p: fmtPx(mid * (a.isBuy ? 1.01 : 0.99), m.szDecimals), s: String(a.sz), r: false, t: { limit: { tif: 'Ioc' } } }];
      if (a.stopPx) orders.push({ a: m.asset, b: !a.isBuy, p: fmtPx(a.stopPx * (a.isBuy ? 0.9 : 1.1), m.szDecimals), s: String(a.sz), r: true,
        t: { trigger: { isMarket: true, triggerPx: fmtPx(a.stopPx, m.szDecimals), tpsl: 'sl' } } });
      const req = { orders, grouping: orders.length > 1 ? 'normalTpsl' : 'na' };
      if (follow.builder_ok) req.builder = { b: builder, f: builderFee };
      const r = await client.order(req);
      const filled = r?.response?.data?.statuses?.[0]?.filled;
      if (!filled) throw new Error('Order did not fill');
      await q(`INSERT INTO copies (follow_id, coin, side, leader_sz, follower_sz, entry_px) VALUES ($1,$2,$3,$4,$5,$6)`,
        [follow.id, a.coin, a.side, a.leaderSz, Number(filled.totalSz), Number(filled.avgPx)]);
      log(`copy opened #${follow.id} ${a.side} ${filled.totalSz} ${a.coin}`);
    } else if (a.kind === 'close' || a.kind === 'reduce') {
      const req = { orders: [{ a: m.asset, b: a.isBuy, p: fmtPx(mid * (a.isBuy ? 1.01 : 0.99), m.szDecimals), s: String(a.sz), r: true, t: { limit: { tif: 'Ioc' } } }], grouping: 'na' };
      if (follow.builder_ok) req.builder = { b: builder, f: builderFee };
      await client.order(req);
      if (a.kind === 'close') {
        await q(`UPDATE copies SET status = 'closed', closed_at = now() WHERE id = $1`, [a.copyId]);
        const trig = (await hl.triggers(follow.follower)).filter(o => o.coin === a.coin);
        if (trig.length) await client.cancel({ cancels: trig.map(o => ({ a: m.asset, o: o.oid })) }).catch(() => {});
        log(`copy closed #${follow.id} ${a.coin}`);
      } else {
        await q(`UPDATE copies SET leader_sz = $2, follower_sz = $3 WHERE id = $1`, [a.copyId, a.leaderSz, a.followerSz]);
        log(`copy trimmed #${follow.id} ${a.coin}`);
      }
    } else if (a.kind === 'forget') {
      await q(`UPDATE copies SET status = 'closed', closed_at = now() WHERE id = $1`, [a.copyId]);
    }
  }

  let ticking = false, timer = null;
  async function tick() {
    if (ticking || !copyEnabled) return;
    ticking = true;
    try {
      await q(`UPDATE follows SET status = 'paused', status_reason = 'Renew to keep copying (monthly check)', updated_at = now()
               WHERE status = 'active' AND expires_at < now()`);
      const follows = await q(`SELECT f.*, l.wallet AS leader_wallet FROM follows f JOIN leaders l ON l.id = f.leader_id
                               WHERE f.status IN ('active', 'paused')`);
      if (!follows.length) return;
      const copiesAll = await q(`SELECT * FROM copies WHERE status = 'open' AND follow_id = ANY($1)`, [follows.map(f => f.id)]);
      const mids = await hl.mids();
      const meta = hl.meta();
      const leaderStates = new Map();
      for (const f of follows) {
        const copies = copiesAll.filter(c => c.follow_id === f.id);
        if (f.status === 'paused' && !copies.length) continue; // nothing to look after
        try {
          if (!leaderStates.has(f.leader_wallet)) leaderStates.set(f.leader_wallet, await hl.state(f.leader_wallet));
          const ls = leaderStates.get(f.leader_wallet);
          const fs = await hl.state(f.follower);
          const leader = new Map(ls.positions.map(p => [p.coin, { szi: p.szi, lev: p.lev }]));
          const follower = new Map(fs.positions.map(p => [p.coin, p.szi]));
          const { actions, ignore } = planFollow({ follow: f, copies, leader, follower, mids, meta, cap });
          let lastError = null;
          for (const a of actions) {
            if (a.kind === 'skip') { lastError = `Skipped ${a.coin}: ${a.reason}`; continue; }
            try { await execute(f, a); }
            catch (e) {
              lastError = `${a.kind} ${a.coin}: ${e.message}`.slice(0, 300);
              if (a.kind === 'open') ignore[a.coin] = a.side; // don't retry an entry over and over
              throw Object.assign(e, { handledIgnore: ignore, lastError });
            }
          }
          await q(`UPDATE follows SET ignore = $2, errors = 0, last_error = COALESCE($3, last_error), updated_at = now() WHERE id = $1`,
            [f.id, JSON.stringify(ignore), lastError]);
        } catch (e) {
          const errors = f.errors + 1;
          log(`follow #${f.id} error: ${e.lastError || e.message}`);
          await q(`UPDATE follows SET errors = $2, last_error = $3, ignore = COALESCE($4, ignore),
                   status = CASE WHEN $2 >= $5 AND status = 'active' THEN 'paused' ELSE status END,
                   status_reason = CASE WHEN $2 >= $5 AND status = 'active' THEN 'Paused after repeated errors' ELSE status_reason END,
                   updated_at = now() WHERE id = $1`,
            [f.id, errors, (e.lastError || e.message).slice(0, 300), e.handledIgnore ? JSON.stringify(e.handledIgnore) : null, MAX_ERRORS]).catch(() => {});
        }
      }
    } catch (e) { log('copy tick failed', e.message); }
    finally { ticking = false; }
  }

  async function start() {
    if (!enabled) { log('Leaderboard and auto-follow off (no DATABASE_URL)'); return; }
    await init();
    await hl.ready();
    if (copyEnabled) timer = setInterval(tick, TICK_MS);
    log(`Leaderboard on${copyEnabled ? ', auto-follow on' : ', auto-follow off (no COPY_KEY_SECRET)'}`);
  }

  // ---- HTTP routes ----
  async function route(req, res, url, { send, readJson }) {
    if (!url.pathname.startsWith('/api/social/')) return false;
    if (!enabled) { send(res, 503, { error: 'Leaderboard is coming soon' }); return true; }
    const p = url.pathname.slice('/api/social/'.length);
    const reply = ([code, msg]) => send(res, code, code === 200 ? { ok: true } : { error: msg });
    if (p === 'leaderboard' && req.method === 'GET') send(res, 200, await leaderboard());
    else if (p === 'me' && req.method === 'GET') send(res, 200, await me(url.searchParams.get('wallet')));
    else if (req.method === 'POST') {
      const b = await readJson(req);
      if (p === 'join') reply(await joinBoard(req, b));
      else if (p === 'leave') reply(await leaveBoard(b));
      else if (p === 'follow') reply(await startFollow(req, b));
      else if (p === 'stop') reply(await stopFollow(b));
      else if (p === 'renew') reply(await renewFollow(req, b));
      else send(res, 404, { error: 'Not found' });
    } else send(res, 404, { error: 'Not found' });
    return true;
  }

  return { start, route, tick, init, query: q, end: () => { clearInterval(timer); return pool && pool.end(); } };
}

// ---- Hyperliquid access for the server ------------------------------------------------------------
function makeHl({ network, hlApi, markets }) {
  const info = body => fetch(`${hlApi}/info`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }).then(r => { if (!r.ok) throw new Error('Hyperliquid ' + r.status); return r.json(); });
  const dexes = [...new Set(markets.map(id => (id.includes(':') ? id.split(':')[0] : '')))];
  const wanted = new Set(markets);
  let meta = {}, metaAt = 0;

  async function loadMeta() {
    const dexList = await info({ type: 'perpDexs' });
    const next = {};
    for (const dex of dexes) {
      const di = dex === '' ? 0 : dexList.findIndex(d => d && d.name === dex);
      if (di < 0) continue;
      const m = await info({ type: 'meta', ...(dex ? { dex } : {}) });
      m.universe.forEach((u, i) => {
        if (wanted.has(u.name) && !u.isDelisted)
          next[u.name] = { asset: dex ? 100000 + di * 10000 + i : i, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage, dex };
      });
    }
    meta = next; metaAt = Date.now();
  }

  let midsCache = { at: 0, v: {} };
  return {
    async ready() { await loadMeta(); },
    meta() { if (Date.now() - metaAt > 600000) loadMeta().catch(() => {}); return meta; },
    async mids() {
      if (Date.now() - midsCache.at < 2000) return midsCache.v;
      const all = {};
      for (const dex of dexes) Object.assign(all, await info({ type: 'allMids', ...(dex ? { dex } : {}) }));
      midsCache = { at: Date.now(), v: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, Number(v)])) };
      return midsCache.v;
    },
    async state(user) {
      const positions = [];
      for (const dex of dexes) {
        const s = await info({ type: 'clearinghouseState', user, ...(dex ? { dex } : {}) });
        for (const { position: p } of s.assetPositions) {
          if (!wanted.has(p.coin) || !Number(p.szi)) continue;
          positions.push({ coin: p.coin, szi: Number(p.szi), entryPx: Number(p.entryPx), lev: Number(p.leverage?.value) || 1,
            unrealizedPnl: Number(p.unrealizedPnl), roe: Number(p.returnOnEquity) || 0, marginUsed: Number(p.marginUsed) || 0 });
        }
      }
      return { positions };
    },
    async triggers(user) {
      const out = [];
      for (const dex of dexes) {
        const orders = await info({ type: 'frontendOpenOrders', user, ...(dex ? { dex } : {}) }).catch(() => []);
        for (const o of orders) if (o.isTrigger && wanted.has(o.coin))
          out.push({ coin: o.coin, oid: o.oid, px: Number(o.triggerPx), kind: /take/i.test(o.orderType) ? 'tp' : 'sl' });
      }
      return out;
    },
    agents: user => info({ type: 'extraAgents', user }),
    async builderOk(user, builder, fee) { return Number(await info({ type: 'maxBuilderFee', user, builder })) >= fee; },
    async client(privateKey) {
      const hl = await import('@nktkas/hyperliquid');
      const { privateKeyToAccount } = await import('viem/accounts');
      return new hl.ExchangeClient({ wallet: privateKeyToAccount(privateKey), transport: new hl.HttpTransport({ isTestnet: network !== 'mainnet' }) });
    },
  };
}

module.exports = { createSocial, planFollow, makeVault, messages, fmtPx, roundDown };
