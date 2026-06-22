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
const vic = require('./vic'); // VIC self-caches; soft-enabled by VIC_CONSUMER_ID env
const vicEnabled = vic.isEnabled();
if (!vicEnabled) {
  console.warn('[combined-proxy] VIC disabled — set VIC_CONSUMER_ID on this service');
}

const sa = require('./sa'); // SA SAFPIS self-caches; soft-enabled by SA_SUBSCRIBER_TOKEN env
const saEnabled = sa.isEnabled();
if (!saEnabled) {
  console.warn('[combined-proxy] SA disabled — set SA_SUBSCRIBER_TOKEN on this service');
}

const wa = require('./wa'); // WA FuelWatch RSS — no key, always enabled, self-caches daily
const waEnabled = wa.isEnabled();

// NSW modules — wrap in try so missing env vars don't kill the whole service
let nswApi, transform;
let nswEnabled = false;
try {
  // Soft-enable NSW if any acceptable env var combination is set. nsw-api.js
  // does the actual resolution and will exit cleanly if it can't find creds.
  const hasKey    = process.env.NSW_API_KEY    || process.env.NSW_APIKEY;
  const hasSecret = process.env.NSW_API_SECRET || process.env.NSW_APISECRET || process.env.NSW_AUTH;
  const hasBasic  = process.env.NSW_BASIC_AUTH || (process.env.NSW_AUTH && /^\s*Basic\s+/i.test(process.env.NSW_AUTH));
  if (hasBasic || (hasKey && hasSecret)) {
    nswApi = require('./nsw-api');
    transform = require('./transform');
    nswEnabled = true;
  } else {
    console.warn('[combined-proxy] NSW disabled — set NSW_APIKEY + NSW_APISECRET (or NSW_API_KEY + NSW_API_SECRET, or NSW_AUTH) on this service');
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
      'VIC':                    ['/vic/prices', '/vic/sites', '/vic/refresh?token=...'],
      'SA':                     ['/sa/prices', '/sa/sites'],
      'WA':                     ['/wa/prices', '/wa/sites', '/wa/refresh?token=...'],
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
    vic: vic.state(),
    sa: sa.state(),
    wa: wa.state(),
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
    res.status(503).json({ error: 'NSW disabled — set NSW_APIKEY + NSW_APISECRET env vars on this Render service' });
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

// ─── VIC endpoints (Service Victoria Fair Fuel Open Data, ~24h delayed) ──
// vic.js self-caches for 24h, so these just read through it. Returns the
// same shapes as NSW: a sites array + a { SitePrices } object.
app.get('/vic/sites', async (req, res) => {
  if (!vicEnabled) return res.status(503).json({ error: 'VIC disabled — set VIC_CONSUMER_ID env var' });
  try {
    res.json(await vic.getSites());
  } catch (e) {
    console.error('[VIC] sites failed:', e.message);
    res.status(502).json({ error: 'VIC sites fetch failed', details: e.message });
  }
});

app.get('/vic/prices', async (req, res) => {
  if (!vicEnabled) return res.status(503).json({ error: 'VIC disabled — set VIC_CONSUMER_ID env var' });
  try {
    res.json(await vic.getPrices());
  } catch (e) {
    console.error('[VIC] prices failed:', e.message);
    res.status(502).json({ error: 'VIC prices fetch failed', details: e.message });
  }
});

app.get('/vic/refresh', async (req, res) => {
  if (!vicEnabled) return res.status(503).json({ error: 'VIC disabled' });
  const token = req.query.token;
  if (!process.env.REFRESH_TOKEN || token !== process.env.REFRESH_TOKEN) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const c = await vic.refresh();
    res.json({ ok: true, sites: c.sites.length, prices: c.prices.SitePrices.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── SA endpoints (SAFPIS, ~30 min fresh) ────────────────────────────
// sa.js self-caches, so these read through it. Same shapes as NSW/VIC.
app.get('/sa/sites', async (req, res) => {
  if (!saEnabled) return res.status(503).json({ error: 'SA disabled — set SA_SUBSCRIBER_TOKEN env var' });
  try {
    res.json(await sa.getSites());
  } catch (e) {
    console.error('[SA] sites failed:', e.message);
    res.status(502).json({ error: 'SA sites fetch failed', details: e.message });
  }
});

app.get('/sa/prices', async (req, res) => {
  if (!saEnabled) return res.status(503).json({ error: 'SA disabled — set SA_SUBSCRIBER_TOKEN env var' });
  try {
    res.json(await sa.getPrices());
  } catch (e) {
    console.error('[SA] prices failed:', e.message);
    res.status(502).json({ error: 'SA prices fetch failed', details: e.message });
  }
});

// ─── WA endpoints (FuelWatch RSS, daily 24h-rule prices, no key) ──────
app.get('/wa/sites', async (req, res) => {
  try {
    res.json(await wa.getSites());
  } catch (e) {
    console.error('[WA] sites failed:', e.message);
    res.status(502).json({ error: 'WA sites fetch failed', details: e.message });
  }
});

app.get('/wa/prices', async (req, res) => {
  try {
    res.json(await wa.getPrices());
  } catch (e) {
    console.error('[WA] prices failed:', e.message);
    res.status(502).json({ error: 'WA prices fetch failed', details: e.message });
  }
});

app.get('/wa/refresh', async (req, res) => {
  const token = req.query.token;
  if (!process.env.REFRESH_TOKEN || token !== process.env.REFRESH_TOKEN) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const c = await wa.refresh();
    res.json({ ok: true, sites: c.sites.length, prices: c.prices.SitePrices.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Combined endpoint — one HTTP call, all states ───────────────────
// Saves the page-costco-fuel-prices.php + dashboard a parallel fetch.
app.get('/all/prices', async (req, res) => {
  const out = {
    qld: null, nsw: null, vic: null, sa: null, wa: null,
    qldError: null, nswError: null, vicError: null, saError: null, waError: null,
  };
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
  if (vicEnabled) {
    try {
      out.vic = await vic.getPrices();
    } catch (e) {
      out.vicError = e.message;
    }
  } else {
    out.vicError = 'VIC disabled';
  }
  if (saEnabled) {
    try {
      out.sa = await sa.getPrices();
    } catch (e) {
      out.saError = e.message;
    }
  } else {
    out.saError = 'SA disabled';
  }
  try {
    out.wa = await wa.getPrices();
  } catch (e) {
    out.waError = e.message;
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

  console.log(`[combined-proxy] VIC ${vicEnabled ? 'enabled' : 'disabled'}`);
  if (vicEnabled) {
    // Warm the cache on boot, then self-refresh daily (the feed updates once/day).
    vic.refresh().catch(e => console.error('[VIC] boot refresh failed:', e.message));
    setInterval(() => {
      vic.refresh().catch(e => console.error('[VIC] daily refresh failed:', e.message));
    }, 24 * 60 * 60 * 1000);
  }

  // WA FuelWatch — no key, always on. Warm on boot + daily refresh (24h rule).
  console.log('[combined-proxy] WA enabled (FuelWatch, no key)');
  wa.refresh().catch(e => console.error('[WA] boot refresh failed:', e.message));
  setInterval(() => {
    wa.refresh().catch(e => console.error('[WA] daily refresh failed:', e.message));
  }, 24 * 60 * 60 * 1000);
});
