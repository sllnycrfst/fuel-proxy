// ─── Fuel Daddy combined QLD + NSW proxy ─────────────────────────────────
// One Render service that serves both feeds. Replaces the previous
// fuel-daddy-nsw-proxy service (which was suspended for hitting the
// Render free 750-hour cap when running alongside this QLD proxy).
//
// Backwards compatibility:
//   - /prices and /sites still return QLD data (unchanged), so any caller
//     that hasn't migrated still works.
// New endpoints:
//   - /qld/prices, /qld/sites        explicit QLD routes
//   - /nsw/prices, /nsw/sites,
//     /nsw/suburbs, /nsw/refresh     NSW routes (mirror old NSW proxy)
//   - /all/prices                    { qld, nsw } — saves a round-trip
// Other preserved:
//   - /mapkit-token                  used by sellanycarfast.com.au
//
// NSW env vars (NSW_API_KEY, NSW_API_SECRET, REFRESH_TOKEN) need to be
// set on Render before the NSW endpoints can serve data. If missing,
// QLD endpoints still work and NSW endpoints return 503.
//
// 2026-05-29 — merged from fuel-daddy-nsw-proxy@main.

const express = require('express');
const cors = require('cors');

const qld = require('./qld');

// NSW modules — wrap in try so missing env vars don't kill the whole service
let nswApi, transform;
let nswEnabled = false;
try {
  if (process.env.NSW_API_KEY && process.env.NSW_API_SECRET) {
    nswApi = require('./nsw-api');
    transform = require('./transform');
    nswEnabled = true;
  } else {
    console.warn('[combined-proxy] NSW disabled — NSW_API_KEY / NSW_API_SECRET not set');
  }
} catch (e) {
  console.error('[combined-proxy] NSW init failed:', e.message);
}

const app = express();
app.use(express.json());

// ─── CORS — both fueldaddy + sellanycarfast use this proxy ───────────
const ALLOWED_ORIGINS = new Set([
  'https://fueldaddy.com.au',
  'https://www.fueldaddy.com.au',
  'https://sell-any-car-fast-form.webflow.io',
  'https://www.sellanycarfast.com.au',
  'https://sellanycarfast.com.au',
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    // Public data — allow all for the fuel API endpoints
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── NSW cache state ─────────────────────────────────────────────────
const nswState = {
  sites: { data: [], updatedAt: 0 },
  prices: { data: [], updatedAt: 0, byKey: new Map() },
  suburbs: { data: [], updatedAt: 0 },
  lastError: null,
  firstFetchDone: false,
};

function buildSuburbsFromStations(qldShapeStations) {
  const map = new Map();
  for (const s of qldShapeStations) {
    if (!s.A || !s.Lat || !s.Lng) continue;
    const m = s.A.match(/,\s*([A-Z][A-Z\s'-]*?)\s+(NSW|ACT)\s+(\d{4})\s*$/);
    if (!m) continue;
    const suburb = m[1].trim().replace(/\s+/g, ' ');
    const postcode = m[3];
    const key = `${suburb.toLowerCase()}_${postcode}`;
    if (map.has(key)) continue;
    map.set(key, {
      suburb: suburb.split(' ').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' '),
      state: m[2],
      postcode,
      lat: s.Lat,
      lng: s.Lng,
    });
  }
  return Array.from(map.values()).sort((a, b) => a.suburb.localeCompare(b.suburb));
}

async function nswRefreshFull() {
  if (!nswEnabled) return;
  console.log('[NSW] Full refresh start');
  const raw = await nswApi.getAllPrices();
  const stations = raw.stations || [];
  const prices = raw.prices || [];

  const convertedSites = transform.nswStationsToQLD(stations);
  nswState.sites = { data: convertedSites, updatedAt: Date.now() };
  nswState.suburbs = { data: buildSuburbsFromStations(convertedSites), updatedAt: Date.now() };

  const converted = transform.nswPricesToQLD(prices);
  nswState.prices.byKey.clear();
  for (const p of converted) nswState.prices.byKey.set(`${p.SiteId}_${p.FuelId}`, p);
  nswState.prices.data = converted;
  nswState.prices.updatedAt = Date.now();

  nswState.firstFetchDone = true;
  nswState.lastError = null;
  console.log(`[NSW] Full refresh ok: ${nswState.sites.data.length} sites, ${nswState.prices.data.length} prices`);
}

async function nswRefreshDelta() {
  if (!nswEnabled) return;
  try {
    const raw = await nswApi.getNewPrices();
    const prices = raw.prices || [];
    const converted = transform.nswPricesToQLD(prices);
    for (const p of converted) nswState.prices.byKey.set(`${p.SiteId}_${p.FuelId}`, p);
    nswState.prices.data = Array.from(nswState.prices.byKey.values());
    nswState.prices.updatedAt = Date.now();
    nswState.lastError = null;
    console.log(`[NSW] Delta ok: +${converted.length}, total ${nswState.prices.data.length}`);
  } catch (e) {
    nswState.lastError = e.message;
    console.error('[NSW] Delta failed:', e.message);
    nswState.firstFetchDone = false; // force full on next tick
  }
}

async function nswTick() {
  if (!nswEnabled) return;
  try {
    if (!nswState.firstFetchDone) await nswRefreshFull();
    else await nswRefreshDelta();
  } catch (e) {
    nswState.lastError = e.message;
    console.error('[NSW] Tick failed:', e.message);
  }
}

// ─── Health / root ───────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service: 'fuel-daddy-combined-proxy',
    endpoints: {
      'legacy QLD (unchanged)': ['/prices', '/sites'],
      'explicit QLD':           ['/qld/prices', '/qld/sites'],
      'NSW':                    ['/nsw/prices', '/nsw/sites', '/nsw/suburbs', '/nsw/refresh?token=...'],
      combined:                 ['/all/prices'],
      other:                    ['/mapkit-token', '/health'],
    },
    nsw: {
      enabled: nswEnabled,
      sites: nswState.sites.data.length,
      prices: nswState.prices.data.length,
      sitesUpdated: nswState.sites.updatedAt ? new Date(nswState.sites.updatedAt).toISOString() : null,
      pricesUpdated: nswState.prices.updatedAt ? new Date(nswState.prices.updatedAt).toISOString() : null,
      lastError: nswState.lastError,
    },
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ─── MapKit token (sellanycarfast) ───────────────────────────────────
app.get('/mapkit-token', (req, res) => {
  res.json({ token: process.env.MAPKIT_TOKEN || null });
});

// ─── QLD endpoints (legacy + explicit) ───────────────────────────────
async function qldPricesHandler(req, res) {
  try {
    const data = await qld.getPrices();
    res.json(data);
  } catch (e) {
    console.error('[QLD] prices fetch failed:', e.message);
    res.status(502).json({ error: 'QLD fetch failed', details: e.message });
  }
}

async function qldSitesHandler(req, res) {
  try {
    const result = await qld.getSites();
    res.json(result.data);
  } catch (e) {
    console.error('[QLD] sites fetch failed:', e.message);
    const stale = qld.getSitesCacheStale();
    if (stale) {
      console.warn('[QLD] serving stale sites cache');
      return res.json(stale);
    }
    res.status(502).json({ error: 'QLD sites fetch failed', details: e.message });
  }
}

app.get('/prices', qldPricesHandler);     // legacy
app.get('/sites',  qldSitesHandler);      // legacy
app.get('/qld/prices', qldPricesHandler); // explicit
app.get('/qld/sites',  qldSitesHandler);  // explicit

// ─── NSW endpoints (mirror old NSW proxy shape) ──────────────────────
function require503IfNotReady(res) {
  if (!nswEnabled) {
    res.status(503).json({ error: 'NSW disabled — NSW_API_KEY / NSW_API_SECRET not set on this Render service' });
    return true;
  }
  if (!nswState.firstFetchDone) {
    res.status(503).json({ error: 'NSW cache warming up', lastError: nswState.lastError });
    return true;
  }
  return false;
}

app.get('/nsw/prices', (req, res) => {
  if (require503IfNotReady(res)) return;
  res.json({ SitePrices: nswState.prices.data });
});

app.get('/nsw/sites', (req, res) => {
  if (require503IfNotReady(res)) return;
  res.json(nswState.sites.data);
});

app.get('/nsw/suburbs', (req, res) => {
  if (require503IfNotReady(res)) return;
  res.json(nswState.suburbs.data);
});

app.get('/nsw/refresh', async (req, res) => {
  if (!nswEnabled) return res.status(503).json({ error: 'NSW disabled' });
  const token = req.query.token;
  if (!process.env.REFRESH_TOKEN || token !== process.env.REFRESH_TOKEN) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    await nswRefreshFull();
    res.json({ ok: true, sites: nswState.sites.data.length, prices: nswState.prices.data.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Combined endpoint — one HTTP call, both states ──────────────────
// Saves the page-costco-fuel-prices.php + dashboard a parallel fetch.
app.get('/all/prices', async (req, res) => {
  const out = { qld: null, nsw: null, qldError: null, nswError: null };
  try {
    out.qld = await qld.getPrices();
  } catch (e) {
    out.qldError = e.message;
  }
  if (nswEnabled && nswState.firstFetchDone) {
    out.nsw = { SitePrices: nswState.prices.data };
  } else if (nswEnabled) {
    out.nswError = 'NSW cache warming up';
  } else {
    out.nswError = 'NSW disabled';
  }
  res.json(out);
});

// ─── Boot ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[combined-proxy] listening on ${PORT}`);
  console.log(`[combined-proxy] NSW ${nswEnabled ? 'enabled' : 'disabled'}`);

  if (nswEnabled) {
    nswTick();
    // Delta every 20 min
    setInterval(nswTick, 20 * 60 * 1000);
    // Full refresh once a day (resync station list + safety net)
    setInterval(() => {
      nswRefreshFull().catch(e => console.error('[NSW] daily full failed:', e.message));
    }, 24 * 60 * 60 * 1000);
  }
});
