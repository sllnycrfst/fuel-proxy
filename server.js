const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();

// ================== CORS & PREFLIGHT HANDLER ==================
app.use(express.json());

// 🔧 Always send OK to browser preflights
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://sell-any-car-fast-form.webflow.io");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Origin", "https://www.sellanycarfast.com.au");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});
// MapKit token route
app.get("/mapkit-token", (req, res) => {
  res.json({
    token: process.env.MAPKIT_TOKEN
  });
});

// ========================== FUEL DADDY (QLD) ==========================
const QLD_BASE = "https://fppdirectapi-prod.fuelpricesqld.com.au";
const QLD_PRICES_URL = `${QLD_BASE}/Price/GetSitesPrices?countryId=21&geoRegionLevel=3&geoRegionId=1`;
const QLD_SITES_URL = `${QLD_BASE}/Subscriber/GetFullSiteDetails?countryId=21&geoRegionLevel=3&geoRegionId=1`;
const QLD_TOKEN = "90fb2504-6e01-4528-9640-b0f37265e749";

const SITES_CACHE_MS = 24 * 60 * 60 * 1000; // 24 hours
let sitesCache = { data: null, fetchedAt: 0 };

async function qldGet(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `FPDAPI SubscriberToken=${QLD_TOKEN}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`QLD API ${response.status}: ${text}`);
  }
  return response.json();
}

app.get("/prices", async (req, res) => {
  try {
    console.log("🟩 QLD prices endpoint hit");
    const data = await qldGet(QLD_PRICES_URL);
    console.log(`✅ QLD returned ${data?.SitePrices?.length || 0} prices`);
    res.set("Access-Control-Allow-Origin", "*");
    res.json(data);
  } catch (err) {
    console.error("❌ QLD prices fetch failed:", err.message);
    res.status(500).json({ error: "QLD fetch failed", details: err.message });
  }
});

// /sites — full QLD station list, cached 24 hours.
// Returns the array directly (matches what the app already expects from sites.json).
app.get("/sites", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const now = Date.now();
    if (sitesCache.data && now - sitesCache.fetchedAt < SITES_CACHE_MS) {
      console.log(`🟦 QLD sites served from cache (${sitesCache.data.length} stations, ${Math.round((now - sitesCache.fetchedAt) / 60000)}m old)`);
      return res.json(sitesCache.data);
    }

    console.log("🟦 QLD sites cache miss — fetching fresh");
    const data = await qldGet(QLD_SITES_URL);
    const sites = Array.isArray(data) ? data : data.S || [];
    sitesCache = { data: sites, fetchedAt: now };
    console.log(`✅ QLD sites refreshed: ${sites.length} stations`);
    res.json(sites);
  } catch (err) {
    console.error("❌ QLD sites fetch failed:", err.message);
    // If we have stale cache, serve it rather than erroring out
    if (sitesCache.data) {
      console.warn("⚠️  Serving stale cache");
      return res.json(sitesCache.data);
    }
    res.status(500).json({ error: "QLD sites fetch failed", details: err.message });
  }
});



// ========================== ROOT TEST PAGE ==========================
app.get("/", (req, res) => {
  res.send(`
    <h1>🚀 FuelDaddy Proxy is Live</h1>
    <p>This proxy currently supports:</p>
    <ul>
      <li>⛽ <a href="/prices">/prices</a> — Live QLD fuel prices (JSON)</li>
      <li>📍 <a href="/sites">/sites</a> — Full QLD station list (cached 24h)</li>
    </ul>
    <p>Powered by <em>FuelDaddy</em> — ${new Date().toLocaleString("en-AU")}</p>
  `);
});

// ========================== START SERVER ==========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ FuelDaddy + EvalExpert proxy running on port ${PORT}`)
);
