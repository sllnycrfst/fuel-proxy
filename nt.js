// ─── NT MyFuelNT (NT Consumer Affairs) ───────────────────────────────
// MyFuelNT has no public JSON API, but its server-rendered results page
// embeds the ENTIRE NT dataset as an HTML-entity-encoded JSON model. One
// GET returns all ~214 NT sites, each with an AvailableFuels[] list of
// live per-fuel prices. We decode the entities, pull the "FuelOutlet"
// array, and normalise to the same shapes the app uses for QLD/NSW/VIC/SA:
//   getSites()  -> [ { S, N, A, B, BrandName, P, Sub, Pcode, Lat, Lng, State:'NT' } ]
//   getPrices() -> { SitePrices: [ { SiteId, FuelId, Price, TransactionDateUtc, CollectionMethod:'N' } ] }
//
// NT mandates real-time reporting (price changes reported within 30 min),
// so this is genuinely live. We cache 15 min and serve stale up to 60 min
// on upstream failure. No key/registration needed → NT is always enabled.
//
// Source URL returns ALL NT sites regardless of the suburb/fuelCode params
// (they only drive the page's own default selection, which we ignore).

const fetch = require('node-fetch');

const NT_URL = 'https://myfuelnt.nt.gov.au/Home/Results?suburb=Darwin&fuelCode=1';

const CACHE_MS   = 15 * 60 * 1000; // 15 min — feed is real-time
const STALE_MS   = 60 * 60 * 1000; // serve up to 60 min old on upstream failure
const TIMEOUT_MS = 30000;
const ATTEMPTS   = 3;
const SENTINEL   = 9000; // tenths-of-cents guard for "unpriced" rows

// MyFuelNT FuelCode -> QLD numeric FuelId (matches transform.js / QLD scheme).
// LAF (Low Aromatic Fuel) is the remote-community ULP-91 substitute → map to U91.
const FUEL_TO_QLD_ID = {
  DL: 3, U91: 2, P95: 5, E10: 12, P98: 8,
  PD: 14, LPG: 6, B20: 14, E85: 19, LAF: 2,
};

// MyFuelNT 2-letter brand code -> [ icon id, display name ]. Shared national
// chains reuse existing QLD numeric PNGs; NT-only brands reuse an existing
// VIC_/WA_ placeholder where one fits, else fall back to Independent (12.png).
// All ids below resolve to a PNG that already ships in the iframe.
const NT_BRANDS = {
  AF: ['12', 'Ausfuel'],
  AM: ['3421066', 'Ampol'],
  AS: ['VIC_ASTRON', 'Astron'],
  BP: ['5', 'BP'],
  C2: ['20', 'Shell Coles Express'],
  C3: ['3421193', 'Shell Reddy Express'],
  CA: ['2', 'Caltex'],
  CO: ['20', 'Coles Express'],
  CW: ['2', 'Caltex Woolworths'],
  EA: ['3421073', 'EG Ampol'],
  FX: ['12', 'FuelXpress'],
  IN: ['12', 'Independent'],
  IV: ['12', 'Indervon'],
  Li: ['86', 'Liberty'],
  MB: ['16', 'Mobil'],
  MO: ['VIC_Mogas', 'Mogas'],
  OR: ['VIC_OnTheRun', 'On The Run'],
  PM: ['WA_Puma', 'Puma Energy'],
  SH: ['20', 'Shell'],
  SO: ['VIC_Solo', 'Solo'],
  UN: ['23', 'United'],
};

function resolveBrand(code) {
  return NT_BRANDS[code] || ['12', 'Independent'];
}

const titleCase = s =>
  String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).trim();

// Decode the HTML entities the Razor view used to encode the JSON model.
function decodeEntities(s) {
  return String(s || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&'); // decode &amp; LAST so we don't double-decode
}

// String-aware bracket match: extract the JSON array that follows `"<key>":`.
function extractArray(text, key) {
  const at = text.indexOf('"' + key + '"');
  if (at < 0) return null;
  let i = text.indexOf('[', at);
  if (i < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return text.slice(i, j + 1);
    }
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ntFetch(attempts = ATTEMPTS) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(NT_URL, {
        method: 'GET',
        timeout: TIMEOUT_MS,
        headers: {
          'Accept': 'text/html',
          'User-Agent': 'FuelDaddy/1.0 (+https://fueldaddy.com.au)',
          'Connection': 'close',
        },
      });
      if (!res.ok) throw new Error(`NT MyFuelNT HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(600 * (i + 1));
    }
  }
  throw lastErr;
}

// Build normalised { sites, prices } from the page HTML.
function build(rawHtml) {
  const dec = decodeEntities(rawHtml);
  const arrStr = extractArray(dec, 'FuelOutlet');
  if (!arrStr) throw new Error('NT: FuelOutlet array not found (page shape changed?)');
  const outlets = JSON.parse(arrStr);

  const sites = [];
  const SitePrices = [];
  const seen = new Set(); // dedupe SiteId_FuelId, keep the lowest price

  for (const o of outlets) {
    const lat = o.Latitude, lng = o.Longitude;
    if (lat == null || lng == null) continue;
    if (o.IsActive === false) continue;

    const sid = 'NT_' + (o.FuelOutletIdentifier || o.FuelOutletId);
    const [iconId, brandName] = resolveBrand(o.OutletBrandIdentifier);
    const suburb = titleCase(o.Suburb);
    const postcode = o.Postcode || '';
    const street = String(o.Address || '').trim();
    const full = `${street}, ${suburb} NT ${postcode}`.replace(/^[,\s]+|[,\s]+$/g, '');

    sites.push({
      S: sid, N: String(o.OutletName || '').trim(), A: full,
      B: iconId, BrandName: brandName,
      P: postcode, Sub: suburb, Pcode: postcode,
      Lat: Math.round(lat * 1e6) / 1e6, Lng: Math.round(lng * 1e6) / 1e6,
      State: 'NT',
    });

    for (const f of o.AvailableFuels || []) {
      if (f.isAvailable === false) continue; // outage / not stocked
      const fid = FUEL_TO_QLD_ID[f.FuelCode];
      const cents = f.Price;
      if (fid == null || cents == null) continue;
      const price = Math.round(parseFloat(cents) * 10); // cents -> tenths (QLD format)
      if (!(price > 0) || price >= SENTINEL) continue;
      const key = sid + '_' + fid;
      if (seen.has(key)) {
        // keep the cheaper of duplicate FuelIds (e.g. U91 vs LAF on one site)
        const prev = SitePrices.find(p => p.SiteId === sid && p.FuelId === fid);
        if (prev && price < prev.Price) prev.Price = price;
        continue;
      }
      seen.add(key);
      SitePrices.push({
        SiteId: sid,
        FuelId: fid,
        Price: price,
        TransactionDateUtc: null, // MyFuelNT doesn't expose a per-price timestamp
        CollectionMethod: 'N',
      });
    }
  }
  return { sites, prices: { SitePrices } };
}

let cache = { sites: null, prices: null, fetchedAt: 0, lastError: null };

function isEnabled() { return true; } // no key needed

async function refresh() {
  const html = await ntFetch();
  const built = build(html);
  if (!built.sites.length) throw new Error('NT: parsed 0 sites');
  cache = { sites: built.sites, prices: built.prices, fetchedAt: Date.now(), lastError: null };
  console.log(`[NT] refresh ok: ${built.sites.length} sites, ${built.prices.SitePrices.length} prices`);
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
      console.warn('[NT] upstream failed, serving stale cache:', e.message);
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
