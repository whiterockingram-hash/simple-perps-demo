// Simple Perps server
// Serves the app and is the only route trades take to Hyperliquid, so the location
// rules below can't be skipped by editing the page in a browser.
//
// Settings (Render → Environment):
//   HL_NETWORK       testnet | mainnet            (default testnet)
//   MAX_ORDER_USD    largest new trade per order   (default 1000, 0 = no cap)
//   PROXYCHECK_KEY   optional proxycheck.io key, turns on VPN/proxy blocking
//   DATABASE_URL     Postgres for the leaderboard and auto-follow (off without it)
//   COPY_KEY_SECRET  64 hex chars; encrypts stored auto-follow keys (auto-follow off without it)
//   PORT             set by Render automatically

const http = require('http');
const fs = require('fs');
const path = require('path');
const geoip = require('geoip-lite');
const { createSocial } = require('./social');

const NETWORK = process.env.HL_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
const HL_API = NETWORK === 'mainnet' ? 'https://api.hyperliquid.xyz' : 'https://api.hyperliquid-testnet.xyz';
const MAX_ORDER_USD = Number(process.env.MAX_ORDER_USD ?? 1000) || 0;
const PROXYCHECK_KEY = process.env.PROXYCHECK_KEY || '';
const PORT = process.env.PORT || 3000;

// Markets the app offers (same list as the page). Leaderboard and auto-follow only cover these.
const MARKETS = ['BTC', 'ETH', 'SOL', 'xyz:TSLA', 'xyz:NVDA', 'xyz:AAPL', 'xyz:SPCX', 'xyz:ANT', 'io:OAI'];
const BUILDER = '0x96405e5cf188526d6f0d2e8a7a403aa1e6d11b00', BUILDER_FEE = 30; // 0.03% app fee

// ---- Who can't open trades -------------------------------------------------
// Matches Hyperliquid's Terms of Use: the United States, Ontario, and sanctioned territories.
// Region codes are ISO 3166-2 subdivisions (UA-43 Crimea, UA-40 Sevastopol, UA-14 Donetsk, UA-09 Luhansk).
const BLOCKED_COUNTRIES = new Set(['US', 'CU', 'IR', 'KP', 'SY', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM']);
const BLOCKED_REGIONS = new Set(['CA-ON', 'UA-43', 'UA-40', 'UA-14', 'UA-09']);

function isBlockedPlace(country, region) {
  if (!country) return false;
  return BLOCKED_COUNTRIES.has(country) || BLOCKED_REGIONS.has(`${country}-${region}`);
}

function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return cf;
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || '';
}

const isPrivateIp = ip => /^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::ffff:127\.|fc|fd)/i.test(ip.replace(/^::ffff:/, '')) || ip === '::1';

// VPN / proxy check (only when a proxycheck.io key is set). Results cached for an hour.
const vpnCache = new Map();
async function isVpn(ip) {
  if (!PROXYCHECK_KEY || isPrivateIp(ip)) return false;
  const hit = vpnCache.get(ip);
  if (hit && hit.until > Date.now()) return hit.vpn;
  try {
    const r = await fetch(`https://proxycheck.io/v2/${encodeURIComponent(ip)}?key=${PROXYCHECK_KEY}&vpn=1`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    const vpn = j[ip]?.proxy === 'yes';
    vpnCache.set(ip, { vpn, until: Date.now() + 3600e3 });
    return vpn;
  } catch { return false; } // don't lock everyone out if the checker is down
}

// The full location verdict for one request
async function checkLocation(req) {
  const ip = clientIp(req);
  // Cloudflare (once the domain sits behind it) gives the country directly
  const cfCountry = req.headers['cf-ipcountry'];
  const geo = geoip.lookup(ip.replace(/^::ffff:/, ''));
  const country = (cfCountry && cfCountry !== 'XX' ? cfCountry : geo?.country) || '';
  const region = geo?.region || '';

  if (!country) {
    if (isPrivateIp(ip)) return { allowed: true, country: 'LOCAL', region: '', reason: '' }; // running on your own laptop
    return { allowed: false, country: '', region: '', reason: "We couldn't confirm your location" };
  }
  if (isBlockedPlace(country, region)) return { allowed: false, country, region, reason: 'Trading is not available in your location' };
  if (await isVpn(ip)) return { allowed: false, country, region, reason: 'Turn off your VPN or proxy to trade' };
  return { allowed: true, country, region, reason: '' };
}

// ---- What counts as opening risk --------------------------------------------
// Opening, adding to, flipping or re-opening a position is blocked for restricted users.
// Closing, cancelling, stop-loss changes on existing trades, and adding margin stay allowed,
// so nobody is ever stuck in a trade.
function opensRisk(action) {
  if (!action || typeof action !== 'object') return false;
  switch (action.type) {
    case 'order': return (action.orders || []).some(o => !o.r);
    case 'modify': return !action.order?.r;
    case 'batchModify': return (action.modifies || []).some(m => !m.order?.r);
    case 'twapOrder': return !action.twap?.r;
    default: return false;
  }
}

// Largest new (non-reduce-only) order value in USD
function largestNewOrderUsd(action) {
  const list = action?.type === 'order' ? action.orders || []
    : action?.type === 'modify' ? [action.order]
    : action?.type === 'batchModify' ? (action.modifies || []).map(m => m.order) : [];
  return Math.max(0, ...list.filter(o => o && !o.r && !o.t?.trigger).map(o => Number(o.p) * Number(o.s) || 0));
}

// ---- HTTP -------------------------------------------------------------------
const send = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readBody = req => new Promise((ok, fail) => {
  let data = '';
  req.on('data', c => { data += c; if (data.length > 1e6) { fail(new Error('too large')); req.destroy(); } });
  req.on('end', () => ok(data));
  req.on('error', fail);
});

async function handleExchange(req, res) {
  let payload;
  try { payload = JSON.parse(await readBody(req)); } catch { return send(res, 400, { status: 'err', response: 'Bad request' }); }
  const action = payload?.action;

  if (opensRisk(action)) {
    const loc = await checkLocation(req);
    const declared = String(req.headers['x-residence'] || '');
    const [dc, dr] = declared.split('-');
    if (!loc.allowed) {
      console.log(`blocked trade: ${loc.country}-${loc.region} ${clientIp(req)} (${loc.reason})`);
      return send(res, 403, { status: 'err', response: loc.reason });
    }
    if (!declared) return send(res, 403, { status: 'err', response: 'Confirm where you live before trading' });
    if (isBlockedPlace(dc, dr)) return send(res, 403, { status: 'err', response: 'Trading is not available where you live' });
    const usd = largestNewOrderUsd(action);
    if (MAX_ORDER_USD && usd > MAX_ORDER_USD * 1.02) // small allowance for the slippage built into market orders
      return send(res, 403, { status: 'err', response: `Max trade size is $${MAX_ORDER_USD.toLocaleString()} for now` });
  }

  try {
    const r = await fetch(`${HL_API}/exchange`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    res.writeHead(r.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(text);
  } catch (e) {
    send(res, 502, { status: 'err', response: 'Hyperliquid did not respond, try again' });
  }
}

const readJson = req => readBody(req).then(t => { try { return JSON.parse(t || '{}'); } catch { return {}; } });

const social = createSocial({ network: NETWORK, hlApi: HL_API, cap: MAX_ORDER_USD, markets: MARKETS,
  builder: BUILDER, builderFee: BUILDER_FEE, checkLocation, isBlockedPlace });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const ROOT = __dirname;
const PUBLIC = new Set(['index.html', 'manifest.json', 'sw.js', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']);

function serveFile(req, res) {
  let name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  if (!PUBLIC.has(name)) name = 'index.html'; // only the app's own files are served
  fs.readFile(path.join(ROOT, name), (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(name)] || 'application/octet-stream',
      'Cache-Control': name === 'index.html' || name === 'sw.js' ? 'no-cache' : 'public, max-age=3600' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/config') return send(res, 200, { network: NETWORK, maxOrderUsd: MAX_ORDER_USD });
    if (url.pathname === '/api/geo') return send(res, 200, await checkLocation(req));
    if (url.pathname === '/api/exchange' && req.method === 'POST') return handleExchange(req, res);
    if (await social.route(req, res, url, { send, readJson })) return;
    if (url.pathname.startsWith('/api/')) return send(res, 404, { status: 'err', response: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveFile(req, res);
  } catch (e) {
    console.error(e);
    send(res, 500, { status: 'err', response: 'Server error' });
  }
});
if (require.main === module) {
  server.listen(PORT, () => console.log(`Simple Perps on :${PORT} (${NETWORK}, max order $${MAX_ORDER_USD || '∞'})`));
  social.start().catch(e => console.error('Leaderboard failed to start:', e.message));
}

module.exports = { opensRisk, largestNewOrderUsd, isBlockedPlace };
