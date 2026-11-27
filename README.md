# Simple Perps

A simple trading app on Hyperliquid: crypto, stocks (Tesla, Nvidia, Apple) and pre-IPO markets (SpaceX, OpenAI), plus Anthropic.

## Run it
    npm install
    npm start        # http://localhost:3000

Every trade goes through `server.js`, which blocks new trades from the United States, Ontario and
sanctioned regions (by IP and by the residence each user confirms), and caps trade size.
Closing trades always works.

## Settings (Render → Environment)
- `HL_NETWORK`: `testnet` (default) or `mainnet`
- `MAX_ORDER_USD`: largest new trade allowed, default 1000 (0 = no cap)
- `PROXYCHECK_KEY`: optional proxycheck.io key to also block VPNs and proxies

Run `npm test` to check the blocking rules.
