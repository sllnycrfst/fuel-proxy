// ─── VIC Service Victoria "Fair Fuel" Open Data client ───────────────
// Wraps the Victorian open-data fuel API and normalises it to the same
// shapes the app already consumes for QLD/NSW:
//   getSites()  -> [ { S, N, A, B, BrandName, P, Sub, Pcode, Lat, Lng, State } ]
//   getPrices() -> { SitePrices: [ { SiteId, FuelId, Price, TransactionDateUtc, CollectionMethod } ] }
//
// The Fair Fuel Open Data feed is published with a ~24h delay and only
// changes once a day, so we cache for 24h (no delta endpoint exists).
// One /fuel/prices call returns stations AND prices together.
//
// Auth: x-consumer-id (env VIC_CONSUMER_ID), x-transactionid (UUID v4 per
// request), User-Agent. HTTPS only. Rate limit 10 req/60s — we make at
// most 2 calls per daily refresh (brands + prices), so never close.

const fetch = require('node-fetch');
const crypto = require('crypto');

const VIC_BASE = 'https://api.fuel.service.vic.gov.au/open-data/v1';
const CONSUMER_ID = process.env.VIC_CONSUMER_ID || '';

const CACHE_MS   = 24 * 60 * 60 * 1000; // 24h — matches the daily-delayed feed
const STALE_MS   = 48 * 60 * 60 * 1000; // serve up to 48h old on upstream failure
const TIMEOUT_MS = 60000;
const ATTEMPTS   = 3;

// VIC fuel code -> QLD numeric FuelId (matches transform.js + the QLD scheme).
const FUEL_TO_QLD_ID = {
  U91: 2, E10: 12, P95: 5, P98: 8,
  DSL: 3, PDSL: 14, E85: 19, B20: 14,
  LPG: 6, LNG: 6, CNG: 6,
};

// VIC brand NAME (normalised) -> existing QLD icon ID, so shared chains reuse PNGs.
const SHARED_BRANDS = {
  bp: '5', bpbowserbean: '5',
  shell: '20', shellbowserbean: '20',
  caltex: '2',
  '7eleven': '113',
  costco: '2031031',
  liberty: '86',
  united: '23',
  ampol: '3421066',
  egampol: '3421073',
  pearlenergy: '3421139',
  reddyexpress: '3421193',
  metrofuel: '57', metropetroleum: '57',
  mobil: '16',
  ugo: 'NSW_U-Go',
  independent: '12',
};

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// brandId -> icon id + name. Shared chain -> numeric. major -> VIC_<Name>. else -> 12.
function resolveBrand(brandId, brandsById) {
  const b = brandsById[brandId];
  if (!b) return ['12', 'Independent'];
  const name = String(b.name || '').trim();
  const n = norm(name);
  if (SHARED_BRANDS[n]) return [SHARED_BRANDS[n], name];
  if (b.type === 'major') return ['VIC_' + name.replace(/[^A-Za-z0-9]/g, ''), name];
  return ['12', name];
}

// VIC station ids are opaque base64 (contain / + =) — make a URL/selector-safe key.
const safeId = raw => 'VIC_' + String(raw || '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

// "945-957 Pascoe Vale RD, BROADMEADOWS, 3047" -> [street, suburb(Title), postcode]
function parseAddr(addr) {
  addr = String(addr || '').trim();
  const parts = addr.split(',').map(p => p.trim()).filter(Boolean);
  let postcode = '', suburb = '', street = addr;
  if (parts.length) {
    const last = parts[parts.length - 1];
    const m = last.match(/(\d{4})\s*$/);
    if (m) {
      postcode = m[1];
      let tail = last.replace(/\b(VIC|VICTORIA)\b/i, '').replace(/\d{4}\s*$/, '').trim().replace(/[,\s]+$/, '');
      if (tail) {
        suburb = tail;
        street = parts.slice(0, -1).join(', ');
      } else {
        suburb = parts.length >= 2 ? parts[parts.length - 2] : '';
        street = parts.length >= 2 ? parts.slice(0, -2).join(', ') : parts[0];
      }
    } else {
      suburb = last;
      street = parts.slice(0, -1).join(', ') || addr;
    }
  }
  suburb = suburb ? suburb.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : '';
  return [street.replace(/^[,\s]+|[,\s]+$/g, ''), suburb, postcode];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function vicGet(path, attempts = ATTEMPTS) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(VIC_BASE + path, {
        method: 'GET',
        timeout: TIMEOUT_MS,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'FuelDaddy/1.0 (+https://fueldaddy.com.au)',
          'x-consumer-id': CONSUMER_ID,
          'x-transactionid': crypto.randomUUID(),
          'Connection': 'close',
        },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`VIC API ${res.status} on ${path}: ${text.slice(0, 200)}`);
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(600 * (i + 1)); // 600ms, 1200ms backoff
    }
  }
  throw lastErr;
}

// Build normalised { sites, prices } from the two upstream payloads.
function build(pricesPayload, brandsPayload) {
  const brandsById = {};
  for (const b of (brandsPayload && brandsPayload.brands) || []) {
    if (b && b.id) brandsById[b.id] = b;
  }

  const sites = [];
  const SitePrices = [];
  const details = (pricesPayload && pricesPayload.fuelPriceDetails) || [];

  for (const rec of details) {
    const st = rec.fuelStation;
    if (!st) continue;
    const loc = st.location || {};
    const lat = loc.latitude, lng = loc.longitude;
    if (lat == null || lng == null) continue;

    const sid = safeId(st.id);
    const [iconId, brandName] = resolveBrand(st.brandId, brandsById);
    const name = String(st.name || '').trim();
    const [street, suburb, postcode] = parseAddr(st.address);
    const full = `${street}, ${suburb} VIC ${postcode}`.replace(/^[,\s]+|[,\s]+$/g, '');

    sites.push({
      S: sid, N: name, A: full, B: iconId, BrandName: brandName,
      P: postcode, Sub: suburb, Pcode: postcode,
      Lat: Math.round(lat * 1e6) / 1e6, Lng: Math.round(lng * 1e6) / 1e6,
      State: 'VIC',
    });

    for (const p of rec.fuelPrices || []) {
      const fid = FUEL_TO_QLD_ID[p.fuelType];
      if (fid == null) continue;
      // Out of stock: the VIC feed explicitly flags unavailable fuels
      // (isAvailable:false, price:null). Emit a QLD-style placeholder (>900 c/L)
      // so the existing outage detection (page-fuel-outages.php +
      // fd-live-snapshot.php, both treat Price > 8000 as "out") picks it up with
      // NO website change. When the station restocks isAvailable flips true and
      // the sentinel disappears on the next daily refresh. updatedAt is the
      // feed's batch date (~1 day old), so it passes the 7-day freshness gate.
      if (p.isAvailable === false) {
        SitePrices.push({
          SiteId: sid,
          FuelId: fid,
          Price: 99999,                                // 9999.9 c/L sentinel = out of fuel
          TransactionDateUtc: p.updatedAt || null,
          CollectionMethod: 'V',
        });
        continue;
      }
      if (p.price == null) continue;
      SitePrices.push({
        SiteId: sid,
        FuelId: fid,
        Price: Math.round(parseFloat(p.price) * 10), // tenths of cents (QLD format)
        TransactionDateUtc: p.updatedAt || null,
        CollectionMethod: 'V',
      });
    }
  }
  return { sites, prices: { SitePrices } };
}

let cache = { sites: null, prices: null, fetchedAt: 0, lastError: null };

function isEnabled() {
  return !!CONSUMER_ID;
}

async function refresh() {
  if (!isEnabled()) throw new Error('VIC disabled — set VIC_CONSUMER_ID env var');
  // brands is best-effort (icons degrade to generic independent if it fails)
  let brands = null;
  try { brands = await vicGet('/fuel/reference-data/brands'); }
  catch (e) { console.warn('[VIC] brands fetch failed (icons degrade):', e.message); }

  const prices = await vicGet('/fuel/prices');
  const built = build(prices, brands);
  cache = { sites: built.sites, prices: built.prices, fetchedAt: Date.now(), lastError: null };
  console.log(`[VIC] refresh ok: ${built.sites.length} sites, ${built.prices.SitePrices.length} prices`);
  return cache;
}

async function ensureFresh() {
  const now = Date.now();
  if (cache.sites && now - cache.fetchedAt < CACHE_MS) return cache;
  try {
    return await refresh();
  } catch (e) {
    cache.lastError = e.message;
    if (cache.sites && now - cache.fetchedAt < STALE_MS) {
      console.warn('[VIC] upstream failed, serving stale cache:', e.message);
      return cache;
    }
    throw e;
  }
}

async function getSites() {
  await ensureFresh();
  return cache.sites || [];
}

async function getPrices() {
  await ensureFresh();
  return cache.prices || { SitePrices: [] };
}

function state() {
  return {
    enabled: isEnabled(),
    sites: cache.sites ? cache.sites.length : 0,
    prices: cache.prices ? cache.prices.SitePrices.length : 0,
    updatedAt: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
    lastError: cache.lastError,
  };
}

module.exports = { isEnabled, refresh, getSites, getPrices, state };
