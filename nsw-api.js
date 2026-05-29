// ─── NSW FuelCheck API client ────────────────────────────
// Handles OAuth token caching + the prices endpoint (which returns stations too).
//
// Critical NSW API gotchas — verified live against the API on 2026-05-08:
//   - OAuth call uses GET (not POST!) with grant_type as a QUERY param.
//     Posting to it just echoes your body back.
//   - Authorization header MUST include "Bearer " prefix on data calls.
//   - apikey header is REQUIRED (different from Basic auth used on token req).
//   - requesttimestamp format: "dd/MM/yyyy hh:mm:ss AM/PM" UTC, 12-hour.
//   - /FuelCheckRefData/v1/fuel/lovs currently returns 500 — don't use it.
//     /FuelPriceCheck/v1/fuel/prices returns both stations AND prices.
//   - Tokens last ~12h — cache them.

const OAUTH_URL = 'https://api.onegov.nsw.gov.au/oauth/client_credential/accesstoken?grant_type=client_credentials';
const API_BASE = 'https://api.onegov.nsw.gov.au';

const APIKEY = process.env.NSW_API_KEY;
const APISECRET = process.env.NSW_API_SECRET;
if (!APIKEY || !APISECRET) {
  console.error('[NSW] FATAL: NSW_API_KEY and NSW_API_SECRET env vars are required');
  process.exit(1);
}

function buildBasicAuth() {
  if (process.env.NSW_BASIC_AUTH) return process.env.NSW_BASIC_AUTH;
  const raw = `${APIKEY}:${APISECRET}`;
  return 'Basic ' + Buffer.from(raw, 'utf8').toString('base64');
}

// ─── Token cache ─────────────────────────────────────────
let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 60000) {
    return tokenCache.token;
  }

  console.log('[NSW] Fetching new access token...');
  // *** GET, not POST — this is the gotcha that costs hours ***
  const res = await fetch(OAUTH_URL, {
    method: 'GET',
    headers: {
      'Authorization': buildBasicAuth(),
      'Accept': 'application/json',
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`NSW OAuth failed (${res.status}): ${text.slice(0, 500)}`);
  }

  let data;
  try { data = JSON.parse(text); }
  catch (e) { throw new Error(`NSW OAuth bad response: ${text.slice(0, 500)}`); }

  if (!data.access_token) {
    throw new Error(`NSW OAuth no token: ${text}`);
  }

  const expiresInSec = parseInt(data.expires_in, 10) || 43199;
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + expiresInSec * 1000,
  };
  console.log(`[NSW] Token cached, expires in ${expiresInSec}s`);
  return tokenCache.token;
}

// ─── Build the dd/MM/yyyy hh:mm:ss AM/PM UTC timestamp ───
function nswTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dd = pad(d.getUTCDate());
  const MM = pad(d.getUTCMonth() + 1);
  const yyyy = d.getUTCFullYear();
  let h = d.getUTCHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const hh = pad(h);
  const mm = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return `${dd}/${MM}/${yyyy} ${hh}:${mm}:${ss} ${ampm}`;
}

// ─── Authenticated GET helper ────────────────────────────
async function authedGet(path, retried = false) {
  const token = await getAccessToken();
  const url = `${API_BASE}${path}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'apikey': APIKEY,
      'transactionid': String(Date.now()),
      'requesttimestamp': nswTimestamp(),
      'Accept': 'application/json',
    },
  });

  // Token expired? Force re-auth and retry once.
  if (res.status === 401 && !retried) {
    console.warn('[NSW] 401 — clearing token cache and retrying');
    tokenCache = { token: null, expiresAt: 0 };
    return authedGet(path, true);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`NSW ${path} failed (${res.status}): ${text.slice(0, 500)}`);
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`NSW ${path} bad JSON: ${text.slice(0, 500)}`);
  }
}

// ─── Endpoints ───────────────────────────────────────────

// All current prices. v2 = NSW + TAS + ACT (single subscription).
// Returns BOTH stations AND prices in one call:
//   - stations: [{ code, brand, name, address, location: {latitude, longitude}, state, ... }]
//   - prices:   [{ stationcode, fueltype, price, lastupdated }]
async function getAllPrices() {
  return authedGet('/FuelPriceCheck/v2/fuel/prices');
}

// Delta — only prices changed since last call from this apikey.
async function getNewPrices() {
  return authedGet('/FuelPriceCheck/v2/fuel/prices/new');
}

module.exports = {
  getAllPrices,
  getNewPrices,
};
