// ─── QLD FuelPriceQLD API client ────────────────────────
// Wraps the Queensland FPDirect API. Prices fetched on-demand
// (the QLD API is fast and quota is generous). Sites cached 24h.
//
// All transformations are no-ops — the QLD API shape is already
// what the app expects. The combined-proxy `/all/prices` endpoint
// returns this data as-is alongside NSW's normalised payload.

const fetch = require('node-fetch');

const QLD_BASE = 'https://fppdirectapi-prod.fuelpricesqld.com.au';
const QLD_PRICES_URL = `${QLD_BASE}/Price/GetSitesPrices?countryId=21&geoRegionLevel=3&geoRegionId=1`;
const QLD_SITES_URL  = `${QLD_BASE}/Subscriber/GetFullSiteDetails?countryId=21&geoRegionLevel=3&geoRegionId=1`;
const QLD_TOKEN = process.env.QLD_TOKEN || '90fb2504-6e01-4528-9640-b0f37265e749';

const SITES_CACHE_MS = 24 * 60 * 60 * 1000; // 24h
let sitesCache = { data: null, fetchedAt: 0 };

async function qldGet(url) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `FPDAPI SubscriberToken=${QLD_TOKEN}`,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QLD API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function getPrices() {
  return qldGet(QLD_PRICES_URL); // { SitePrices: [...] }
}

async function getSites() {
  const now = Date.now();
  if (sitesCache.data && now - sitesCache.fetchedAt < SITES_CACHE_MS) {
    return { data: sitesCache.data, cached: true, ageMs: now - sitesCache.fetchedAt };
  }
  const data = await qldGet(QLD_SITES_URL);
  const sites = Array.isArray(data) ? data : (data.S || []);
  sitesCache = { data: sites, fetchedAt: now };
  return { data: sites, cached: false, ageMs: 0 };
}

function getSitesCacheStale() {
  return sitesCache.data; // may be null
}

module.exports = {
  getPrices,
  getSites,
  getSitesCacheStale,
};
