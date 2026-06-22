// ─── TAS FuelCheck (Tasmania, CBOS) ──────────────────────────────────
// Tasmania runs a mandatory real-time scheme on the NSW FuelCheck platform.
// The NSW V2 data API *can* return TAS (with ?states=TAS) but only with a
// NSW OAuth key — and we must NOT touch the NSW pipeline. The FuelCheck TAS
// website exposes its own keyless AJAX endpoint that returns the same data:
//   GET https://www.fuelcheck.tas.gov.au/fuel/api/v1/fuel/prices/bylocation
//       ?brands=SelectAll&fuelType=<code>&radius=3&<TAS bounding box>
// One call per fuel type returns every TAS station selling it, each with a
// full Prices[] array (all fuels). We loop the fuel set and merge by station
// id, normalising to the same shapes the app uses for QLD/NSW/VIC/SA/NT:
//   getSites()  -> [ { S, N, A, B, BrandName, P, Sub, Pcode, Lat, Lng, State:'TAS' } ]
//   getPrices() -> { SitePrices: [ { SiteId, FuelId, Price, TransactionDateUtc, CollectionMethod:'T' } ] }
//
// No key, no registration → TAS is always enabled. Real-time (30-min rule),
// so we cache 15 min and serve stale up to 60 min on upstream failure.

const fetch = require('node-fetch');

const TAS_URL = 'https://www.fuelcheck.tas.gov.au/fuel/api/v1/fuel/prices/bylocation';

// Bounding box covering all of Tasmania (incl. King + Flinders Islands).
const TAS_BBOX = {
  bottomLeftLatitude: '-44.20',
  bottomLeftLongitude: '143.00',
  topRightLatitude: '-39.30',
  topRightLongitude: '149.70',
  radius: '3',
};

// Fuel types to loop. Each station's Prices[] carries all its fuels, but a
// station only appears in a query for a fuel it actually sells, so we loop
// the full set and merge by station id for complete coverage.
const FUEL_QUERY = ['U91', 'E10', 'P95', 'P98', 'DL', 'PDL', 'LPG', 'E85'];

// TAS FuelType -> QLD numeric FuelId.
const FUEL_TO_QLD_ID = {
  U91: 2, E10: 12, P95: 5, P98: 8,
  DL: 3, PDL: 14, LPG: 6, E85: 19,
};

const CACHE_MS   = 15 * 60 * 1000; // 15 min — feed is real-time
const STALE_MS   = 60 * 60 * 1000; // serve up to 60 min old on upstream failure
const TIMEOUT_MS = 30000;
const ATTEMPTS   = 3;
const SENTINEL   = 9000; // tenths-of-cents guard

// Brand NAME (normalised) -> icon id. Shared national chains reuse existing
// QLD/NSW/VIC PNGs; TAS-only brands fall back to Independent (12.png). All ids
// below resolve to a PNG that already ships in the iframe.
const SHARED_BRANDS = {
  bp: '5', caltex: '2', caltexwoolworths: '2',
  shell: '20', colesexpress: '20',
  ampol: '3421066', egampol: '3421073',
  ampolbennettspetroleum: '3421066', ampolmoodfood: '3421066',
  united: '23', liberty: '86', mobil: '16',
  reddyexpress: '3421193', shellreddyexpress: '3421193',
  shellotr: '20', otr: 'VIC_OnTheRun',
  astron: 'VIC_ASTRON', ugo: 'NSW_U-Go',
  lowespetroleumbp: 'VIC_Lowes', lowespetroleum: 'VIC_Lowes',
  taspetroleumcaltex: '2', taspetroleumshell: '20',
  taspetroleum: '12', bennettspetroleum: '12', independent: '12',
};

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function resolveBrand(name) {
  const n = norm(name);
  const clean = String(name || '').trim();
  if (!n) return ['12', 'Independent'];
  if (SHARED_BRANDS[n]) return [SHARED_BRANDS[n], clean];
  return ['12', clean]; // unknown TAS brand → generic independent icon, keep real name
}

// "418 Main Road, Glenorchy TAS 7010" -> [street, suburb(Title), postcode]
function parseAddr(addr) {
  addr = String(addr || '').trim();
  const parts = addr.split(',').map(p => p.trim()).filter(Boolean);
  let suburb = '', postcode = '', street = addr;
  if (parts.length) {
    const last = parts[parts.length - 1];
    const m = last.match(/^(.*?)\s+TAS\s+(\d{4})\s*$/i);
    if (m) {
      suburb = m[1].trim();
      postcode = m[2];
      street = parts.slice(0, -1).join(', ');
    } else {
      const pc = last.match(/(\d{4})\s*$/);
      if (pc) postcode = pc[1];
      suburb = last.replace(/\bTAS\b/i, '').replace(/\d{4}\s*$/, '').trim();
      street = parts.slice(0, -1).join(', ') || addr;
    }
  }
  suburb = suburb ? suburb.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : '';
  return [street.replace(/^[,\s]+|[,\s]+$/g, ''), suburb, postcode];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tasGet(fuelType, attempts = ATTEMPTS) {
  const params = new URLSearchParams({
    brands: 'SelectAll',
    fuelType,
    ...TAS_BBOX,
  });
  const url = `${TAS_URL}?${params.toString()}`;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        timeout: TIMEOUT_MS,
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'Mozilla/5.0 (FuelDaddy; +https://fueldaddy.com.au)',
          'Referer': 'https://www.fuelcheck.tas.gov.au/',
          'Connection': 'close',
        },
      });
      if (!res.ok) throw new Error(`TAS FuelCheck HTTP ${res.status} (${fuelType})`);
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(600 * (i + 1));
    }
  }
  throw lastErr;
}

// Build normalised { sites, prices } from the merged station set.
function build(stationsById) {
  const sites = [];
  const SitePrices = [];

  for (const st of stationsById.values()) {
    const lat = st.Lat, lng = st.Long;
    if (lat == null || lng == null) continue;

    const sid = 'TAS_' + st.ServiceStationID;
    const [iconId, brandName] = resolveBrand(st.Brand);
    const [street, suburb, postcode] = parseAddr(st.Address);
    const full = `${street}, ${suburb} TAS ${postcode}`.replace(/^[,\s]+|[,\s]+$/g, '');

    sites.push({
      S: sid, N: String(st.Name || '').trim(), A: full,
      B: iconId, BrandName: brandName,
      P: postcode, Sub: suburb, Pcode: postcode,
      Lat: Math.round(lat * 1e6) / 1e6, Lng: Math.round(lng * 1e6) / 1e6,
      State: 'TAS',
    });

    const seen = new Set();
    for (const p of st.Prices || []) {
      const fid = FUEL_TO_QLD_ID[p.FuelType];
      if (fid == null || p.Price == null) continue;
      if (seen.has(fid)) continue;
      const price = Math.round(parseFloat(p.Price) * 10); // cents -> tenths (QLD format)
      if (!(price > 0) || price >= SENTINEL) continue;
      seen.add(fid);
      SitePrices.push({
        SiteId: sid,
        FuelId: fid,
        Price: price,
        TransactionDateUtc: null, // bylocation doesn't expose a per-price timestamp
        CollectionMethod: 'T',
      });
    }
  }
  return { sites, prices: { SitePrices } };
}

let cache = { sites: null, prices: null, fetchedAt: 0, lastError: null };

function isEnabled() { return true; } // no key needed

async function refresh() {
  // Loop fuel types, merge by station id (first occurrence carries the full
  // Prices[] array, so a single hit per station is enough).
  const byId = new Map();
  let anyOk = false;
  for (const ft of FUEL_QUERY) {
    try {
      const rows = await tasGet(ft);
      anyOk = true;
      for (const st of rows) {
        const id = st.ServiceStationID;
        if (id == null) continue;
        if (!byId.has(id)) byId.set(id, st);
      }
    } catch (e) {
      console.warn(`[TAS] ${ft} query failed:`, e.message);
    }
  }
  if (!anyOk) throw new Error('TAS: all fuel queries failed');

  const built = build(byId);
  if (!built.sites.length) throw new Error('TAS: parsed 0 sites');
  cache = { sites: built.sites, prices: built.prices, fetchedAt: Date.now(), lastError: null };
  console.log(`[TAS] refresh ok: ${built.sites.length} sites, ${built.prices.SitePrices.length} prices`);
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
      console.warn('[TAS] upstream failed, serving stale cache:', e.message);
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
