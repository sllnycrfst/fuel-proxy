// ─── WA FuelWatch (Department of Mines, Industry Regulation & Safety) ─
// FuelWatch publishes an RSS feed — no auth, no key. A query with just a
// Product (no Region) returns ALL WA stations for that fuel type. We loop the
// 7 product codes and merge by station (keyed on lat/lng, since the feed has
// no station id) to build per-station multi-fuel records, normalised to the
// app shapes used for NSW/VIC/SA:
//   getSites()  -> [ { S, N, A, B, BrandName, P, Sub, Pcode, Lat, Lng, State:'WA' } ]
//   getPrices() -> { SitePrices: [ { SiteId, FuelId, Price, TransactionDateUtc, CollectionMethod:'W' } ] }
//
// WA runs a 24-hour rule: one price per day, set in advance (tomorrow's prices
// publish after 2:30pm WST). So we cache 24h and refresh daily. No key needed,
// so WA is always enabled.

const fetch = require('node-fetch');

const WA_RSS = 'https://www.fuelwatch.wa.gov.au/fuelwatch/fuelWatchRSS';

// FuelWatch product code -> QLD numeric FuelId.
const PRODUCT_TO_QLD_ID = {
  1: 2,   // Unleaded Petrol (ULP 91)
  2: 5,   // Premium Unleaded (95)
  6: 8,   // 98 RON
  4: 3,   // Diesel
  11: 14, // Brand diesel (premium diesel)
  5: 6,   // LPG
  10: 19, // E85
};

const CACHE_MS   = 24 * 60 * 60 * 1000;
const STALE_MS   = 48 * 60 * 60 * 1000;
const TIMEOUT_MS = 30000;
const ATTEMPTS   = 3;

// Brand NAME (normalised) -> icon id. Shared national chains reuse existing
// QLD/NSW/VIC PNGs; WA-only brands get a WA_<Name> placeholder.
const SHARED_BRANDS = {
  bp: '5', caltex: '2', caltexwoolworths: '2',
  shell: '20', ampol: '3421066', egampol: '3421073',
  united: '23', liberty: '86', mobil: '16',
  '7eleven': '113', colesexpress: '111', costco: '2031031',
  reddyexpress: '3421193', metropetroleum: '57', metrofuel: '57',
  ugo: 'NSW_U-Go', independent: '12',
  // national brands that already have a VIC_ placeholder — reuse it:
  atlas: 'VIC_Atlas', astron: 'VIC_ASTRON', betterchoice: 'VIC_BetterChoice',
  burk: 'VIC_Burk', mogas: 'VIC_Mogas', otr: 'VIC_OnTheRun', perrys: 'VIC_Perrys',
  ior: 'VIC_iOR', solo: 'VIC_Solo',
};

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function resolveBrand(name) {
  const n = norm(name);
  if (!n) return ['12', 'Independent'];
  if (SHARED_BRANDS[n]) return [SHARED_BRANDS[n], String(name).trim()];
  return ['WA_' + String(name).replace(/[^A-Za-z0-9]/g, ''), String(name).trim()];
}

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .trim();
}

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
};

function titleCase(s) {
  return String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// lat/lng -> stable station key (feed has no station id).
function stationId(lat, lng) {
  const a = Math.round(lat * 1e5);
  const b = Math.round(lng * 1e5);
  return ('WA_' + a + '_' + b).replace(/-/g, 'n');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchProduct(product) {
  let lastErr;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const res = await fetch(`${WA_RSS}?Product=${product}`, {
        method: 'GET',
        timeout: TIMEOUT_MS,
        headers: {
          'Accept': 'application/rss+xml, application/xml, text/xml',
          'User-Agent': 'FuelDaddy/1.0 (+https://fueldaddy.com.au)',
          'Connection': 'close',
        },
      });
      if (!res.ok) throw new Error(`FuelWatch HTTP ${res.status} (product ${product})`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (i < ATTEMPTS - 1) await sleep(600 * (i + 1));
    }
  }
  throw lastErr;
}

async function buildAll() {
  const sitesByKey = new Map();
  const SitePrices = [];

  for (const [product, fuelId] of Object.entries(PRODUCT_TO_QLD_ID)) {
    let xml;
    try {
      xml = await fetchProduct(product);
    } catch (e) {
      console.warn(`[WA] product ${product} fetch failed:`, e.message);
      continue; // partial data better than none
    }
    const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
    for (const it of items) {
      const lat = parseFloat(tag(it, 'latitude'));
      const lng = parseFloat(tag(it, 'longitude'));
      if (!isFinite(lat) || !isFinite(lng)) continue;
      const priceC = parseFloat(tag(it, 'price'));
      if (!isFinite(priceC) || priceC <= 0) continue;

      const sid = stationId(lat, lng);
      if (!sitesByKey.has(sid)) {
        const brandName = tag(it, 'brand');
        const [iconId, bName] = resolveBrand(brandName);
        sitesByKey.set(sid, {
          S: sid,
          N: tag(it, 'trading-name') || bName,
          A: tag(it, 'address'),
          B: iconId,
          BrandName: bName,
          P: '',
          Sub: titleCase(tag(it, 'location')),
          Pcode: '',
          Lat: Math.round(lat * 1e6) / 1e6,
          Lng: Math.round(lng * 1e6) / 1e6,
          State: 'WA',
        });
      }
      const dateStr = tag(it, 'date'); // YYYY-MM-DD
      SitePrices.push({
        SiteId: sid,
        FuelId: fuelId,
        Price: Math.round(priceC * 10), // tenths of cents
        TransactionDateUtc: dateStr ? `${dateStr}T00:00:00Z` : null,
        CollectionMethod: 'W',
      });
    }
  }

  return { sites: Array.from(sitesByKey.values()), prices: { SitePrices } };
}

let cache = { sites: null, prices: null, fetchedAt: 0, lastError: null };

function isEnabled() {
  return true; // no key required
}

async function refresh() {
  const built = await buildAll();
  if (!built.sites.length) throw new Error('FuelWatch returned no stations');
  cache = { sites: built.sites, prices: built.prices, fetchedAt: Date.now(), lastError: null };
  console.log(`[WA] refresh ok: ${built.sites.length} sites, ${built.prices.SitePrices.length} prices`);
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
      console.warn('[WA] upstream failed, serving stale cache:', e.message);
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
    enabled: true,
    sites: cache.sites ? cache.sites.length : 0,
    prices: cache.prices ? cache.prices.SitePrices.length : 0,
    updatedAt: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
    lastError: cache.lastError,
  };
}

module.exports = { isEnabled, refresh, getSites, getPrices, state };
