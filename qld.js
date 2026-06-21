// ─── QLD FuelPriceQLD API client ────────────────────────
// Wraps the Queensland FPDirect API. Prices fetched on-demand
// (the QLD API is fast and quota is generous). Sites cached 24h.
//
// All transformations are no-ops — the QLD API shape is already
// what the app expects. The combined-proxy `/all/prices` endpoint
// returns this data as-is alongside NSW's normalised payload.
//
// 2026-06-21 — resilience: the upstream intermittently drops the
// connection mid-body ("Premature close") on the ~800 KB prices
// payload. Without retry/cache that surfaced as a 502 and took the
// whole app + website down (everything reads /prices). Now: retry
// with backoff + a short-lived last-good cache served on failure.

const fetch = require('node-fetch');

const QLD_BASE = 'https://fppdirectapi-prod.fuelpricesqld.com.au';
const QLD_PRICES_URL = `${QLD_BASE}/Price/GetSitesPrices?countryId=21&geoRegionLevel=3&geoRegionId=1`;
const QLD_SITES_URL  = `${QLD_BASE}/Subscriber/GetFullSiteDetails?countryId=21&geoRegionLevel=3&geoRegionId=1`;
const QLD_TOKEN = process.env.QLD_TOKEN || '90fb2504-6e01-4528-9640-b0f37265e749';

const SITES_CACHE_MS  = 24 * 60 * 60 * 1000; // 24h
const PRICES_CACHE_MS = 5 * 60 * 1000;       // 5 min — serve fresh within this without refetch
const PRICES_STALE_MS = 60 * 60 * 1000;      // up to 1h old is acceptable as a 502 fallback
const FETCH_TIMEOUT_MS = 20000;
const ATTEMPTS = 3;

let sitesCache  = { data: null, fetchedAt: 0 };
let pricesCache = { data: null, fetchedAt: 0 };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// GET with retry/backoff. `Connection: close` avoids reusing a stale keep-alive
// socket, which is a common source of "Premature close" on large responses.
async function qldGet(url, attempts = ATTEMPTS) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        timeout: FETCH_TIMEOUT_MS,
        headers: {
          'Authorization': `FPDAPI SubscriberToken=${QLD_TOKEN}`,
          'Accept': 'application/json',
          'Connection': 'close',
        },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`QLD API ${res.status}: ${text.slice(0, 300)}`);
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(400 * (i + 1)); // 400ms, 800ms backoff
    }
  }
  throw lastErr;
}

async function getPrices() {
  const now = Date.now();
  if (pricesCache.data && now - pricesCache.fetchedAt < PRICES_CACHE_MS) {
    return pricesCache.data; // fresh enough — skip the upstream round-trip
  }
  try {
    const data = await qldGet(QLD_PRICES_URL); // { SitePrices: [...] }
    if (data && Array.isArray(data.SitePrices)) {
      pricesCache = { data, fetchedAt: now };
    }
    return data;
  } catch (e) {
    // Upstream hiccup — serve last-good prices if recent enough, else rethrow.
    if (pricesCache.data && now - pricesCache.fetchedAt < PRICES_STALE_MS) {
      console.warn('[QLD] prices upstream failed, serving stale cache:', e.message);
      return pricesCache.data;
    }
    throw e;
  }
}

async function getSites() {
  const now = Date.now();
  if (sitesCache.data && now - sitesCache.fetchedAt < SITES_CACHE_MS) {
    return { data: sitesCache.data, cached: true, ageMs: now - sitesCache.fetchedAt };
  }
  try {
    const data = await qldGet(QLD_SITES_URL);
    const sites = Array.isArray(data) ? data : (data.S || []);
    sitesCache = { data: sites, fetchedAt: now };
    return { data: sites, cached: false, ageMs: 0 };
  } catch (e) {
    if (sitesCache.data) {
      console.warn('[QLD] sites upstream failed, serving stale cache:', e.message);
      return { data: sitesCache.data, cached: true, stale: true, ageMs: now - sitesCache.fetchedAt };
    }
    throw e;
  }
}

function getSitesCacheStale() {
  return sitesCache.data; // may be null
}

module.exports = {
  getPrices,
  getSites,
  getSitesCacheStale,
};
