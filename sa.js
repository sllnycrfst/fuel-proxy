// ─── SA SAFPIS (SA Fuel Pricing Information Scheme) client ───────────
// SAFPIS is run by Informed Sources — the SAME API family as QLD, so the
// response shapes are already what the app consumes:
//   GetFullSiteDetails -> { S: [ {S,A,N,B,P,G1..G5,Lat,Lng,M,...} ] }
//   GetSitesPrices     -> { SitePrices: [ {SiteId,FuelId,Price,...} ] }
// FuelIds already match the QLD/Informed-Sources scheme, prices are already
// tenths-of-cents, and brand IDs already line up with the QLD icon set.
//
// We normalise to the app shapes used for NSW/VIC:
//   getSites()  -> [ { S, N, A, B, BrandName, P, Sub, Pcode, Lat, Lng, State:'SA' } ]
//   getPrices() -> { SitePrices: [ { SiteId, FuelId, Price, TransactionDateUtc, CollectionMethod } ] }
// Site ids are prefixed SA_ to avoid colliding with QLD's numeric ids.
//
// Auth: Authorization: FPDAPI SubscriberToken=<token> (token = 32-digit GUID,
// env SA_SUBSCRIBER_TOKEN). HTTPS only. SAFPIS asks: prices no more than once
// per minute; metadata once per day. Prices ~30 min fresh (retailer rule).

const fetch = require('node-fetch');

// Production host mirrors QLD's fppdirectapi-prod.* naming. Override via env if
// the registration email gives a different host. (UAT is fppdirectapi-uat.*)
const SA_HOST  = process.env.SA_API_HOST || 'fppdirectapi-prod.safuelpricinginformation.com.au';
const SA_BASE  = `https://${SA_HOST}`;
const TOKEN    = process.env.SA_SUBSCRIBER_TOKEN || '';
const COUNTRY  = 21; // Australia
const SA_LEVEL = 3;  // states
const SA_REGION = 4; // South Australia

const PRICES_CACHE_MS = 15 * 60 * 1000;      // 15 min (SAFPIS: max once/min; data ~30 min)
const META_CACHE_MS   = 24 * 60 * 60 * 1000; // sites/brands/regions once/day
const STALE_MS        = 60 * 60 * 1000;      // serve ≤1h-old prices on upstream failure
const TIMEOUT_MS = 20000;
const ATTEMPTS   = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function saGet(path, attempts = ATTEMPTS) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(SA_BASE + path, {
        method: 'GET',
        timeout: TIMEOUT_MS,
        headers: {
          'Authorization': `FPDAPI SubscriberToken=${TOKEN}`,
          'Accept': 'application/json',
          'Connection': 'close',
        },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`SA API ${res.status} on ${path}: ${text.slice(0, 200)}`);
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(500 * (i + 1));
    }
  }
  throw lastErr;
}

function isEnabled() {
  return !!TOKEN;
}

// ── metadata cache (brands + suburb names) ──
let meta = { brandsById: {}, suburbById: {}, fetchedAt: 0 };

async function ensureMeta() {
  const now = Date.now();
  if (meta.fetchedAt && now - meta.fetchedAt < META_CACHE_MS) return meta;
  const brandsById = {};
  const suburbById = {};
  try {
    const brands = await saGet(`/Subscriber/GetCountryBrands?countryId=${COUNTRY}`);
    for (const b of brands || []) if (b && b.BrandId != null) brandsById[String(b.BrandId)] = b.Name;
  } catch (e) { console.warn('[SA] brands fetch failed (names degrade):', e.message); }
  try {
    const regions = await saGet(`/Subscriber/GetCountryGeographicRegions?countryId=${COUNTRY}`);
    // level 1 = suburb. site.G1 -> suburb name.
    for (const r of regions || []) {
      if (r && r.GeoRegionLevel === 1 && r.GeoRegionId != null) suburbById[String(r.GeoRegionId)] = r.Name;
    }
  } catch (e) { console.warn('[SA] regions fetch failed (suburb degrades):', e.message); }
  meta = { brandsById, suburbById, fetchedAt: now };
  return meta;
}

// ── sites cache ──
let sitesCache = { data: null, fetchedAt: 0 };

function titleCase(s) {
  return String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

async function getSites() {
  const now = Date.now();
  if (sitesCache.data && now - sitesCache.fetchedAt < META_CACHE_MS) return sitesCache.data;
  if (!isEnabled()) throw new Error('SA disabled — set SA_SUBSCRIBER_TOKEN env var');
  const m = await ensureMeta();
  const raw = await saGet(`/Subscriber/GetFullSiteDetails?countryId=${COUNTRY}&geoRegionLevel=${SA_LEVEL}&geoRegionId=${SA_REGION}`);
  const list = Array.isArray(raw) ? raw : (raw.S || []);
  const sites = [];
  for (const s of list) {
    if (s.Lat == null || s.Lng == null) continue;
    const brandName = m.brandsById[String(s.B)] || '';
    const suburb = titleCase(m.suburbById[String(s.G1)] || '');
    sites.push({
      S: 'SA_' + s.S,
      N: String(s.N || '').trim(),
      A: String(s.A || '').trim(),
      B: String(s.B),
      BrandName: brandName,
      P: String(s.P || ''),
      Sub: suburb,
      Pcode: String(s.P || ''),
      Lat: s.Lat,
      Lng: s.Lng,
      State: 'SA',
    });
  }
  sitesCache = { data: sites, fetchedAt: now };
  return sites;
}

// ── prices cache ──
let pricesCache = { data: null, fetchedAt: 0 };

async function getPrices() {
  const now = Date.now();
  if (pricesCache.data && now - pricesCache.fetchedAt < PRICES_CACHE_MS) return pricesCache.data;
  if (!isEnabled()) throw new Error('SA disabled — set SA_SUBSCRIBER_TOKEN env var');
  try {
    const raw = await saGet(`/Price/GetSitesPrices?countryId=${COUNTRY}&geoRegionLevel=${SA_LEVEL}&geoRegionId=${SA_REGION}`);
    const SitePrices = [];
    for (const p of (raw && raw.SitePrices) || []) {
      if (p.Price == null || p.Price >= 9999) continue; // 9999 = unavailable
      SitePrices.push({
        SiteId: 'SA_' + p.SiteId,
        FuelId: p.FuelId,
        Price: Math.round(parseFloat(p.Price)), // already tenths-of-cents
        TransactionDateUtc: p.TransactionDateUtc || null,
        CollectionMethod: p.CollectionMethod || 'S',
      });
    }
    const out = { SitePrices };
    pricesCache = { data: out, fetchedAt: now };
    return out;
  } catch (e) {
    if (pricesCache.data && now - pricesCache.fetchedAt < STALE_MS) {
      console.warn('[SA] prices upstream failed, serving stale cache:', e.message);
      return pricesCache.data;
    }
    throw e;
  }
}

function state() {
  return {
    enabled: isEnabled(),
    host: SA_HOST,
    sites: sitesCache.data ? sitesCache.data.length : 0,
    prices: pricesCache.data ? pricesCache.data.SitePrices.length : 0,
    sitesUpdated: sitesCache.fetchedAt ? new Date(sitesCache.fetchedAt).toISOString() : null,
    pricesUpdated: pricesCache.fetchedAt ? new Date(pricesCache.fetchedAt).toISOString() : null,
  };
}

// ── TEMP debug probe: reveals raw response shapes to fix field mapping.
// Returns sample keys + first object only (public fuel metadata, no token).
async function debugRaw() {
  const out = {};
  try {
    const brands = await saGet(`/Subscriber/GetCountryBrands?countryId=${COUNTRY}`);
    const barr = Array.isArray(brands) ? brands : (brands && (brands.Brands || brands.BrandList || Object.values(brands).find(Array.isArray))) || [];
    out.brands = { topType: Array.isArray(brands) ? 'array' : typeof brands, topKeys: Array.isArray(brands) ? null : Object.keys(brands || {}), count: barr.length, sample: barr[0] || null };
  } catch (e) { out.brands = { error: e.message }; }
  try {
    const regions = await saGet(`/Subscriber/GetCountryGeographicRegions?countryId=${COUNTRY}`);
    const rarr = Array.isArray(regions) ? regions : (regions && (regions.GeographicRegions || regions.Regions || Object.values(regions).find(Array.isArray))) || [];
    const levels = {};
    for (const r of rarr) { const lv = r && (r.GeoRegionLevel ?? r.GeographicRegionLevel ?? r.Level); levels[lv] = (levels[lv] || 0) + 1; }
    out.regions = { topType: Array.isArray(regions) ? 'array' : typeof regions, topKeys: Array.isArray(regions) ? null : Object.keys(regions || {}), count: rarr.length, levelCounts: levels, sample: rarr[0] || null };
  } catch (e) { out.regions = { error: e.message }; }
  try {
    const raw = await saGet(`/Subscriber/GetFullSiteDetails?countryId=${COUNTRY}&geoRegionLevel=${SA_LEVEL}&geoRegionId=${SA_REGION}`);
    const list = Array.isArray(raw) ? raw : (raw.S || []);
    out.sites = { topType: Array.isArray(raw) ? 'array' : typeof raw, topKeys: Array.isArray(raw) ? null : Object.keys(raw || {}), count: list.length, sampleKeys: list[0] ? Object.keys(list[0]) : null, sample: list[0] || null };
  } catch (e) { out.sites = { error: e.message }; }
  return out;
}

module.exports = { isEnabled, getSites, getPrices, state, debugRaw };
