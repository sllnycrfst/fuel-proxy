// ========================== FuelDaddy Proxy ==========================
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ========================== QLD CONFIG ==========================
const QLD_API_URL =
  "https://fppdirectapi-prod.fuelpricesqld.com.au/Price/GetSitesPrices?countryId=21&geoRegionLevel=3&geoRegionId=1";
const QLD_TOKEN = "90fb2504-6e01-4528-9640-b0f37265e749";

// ========================== NSW CONFIG ==========================
// (Set these in Render’s Environment Variables for security)
const NSW_AUTH = process.env.NSW_AUTH; // "Basic base64(client_id:client_secret)"
const NSW_APIKEY = process.env.NSW_APIKEY; // from your NSW API dashboard

// ========================== QLD ROUTE ==========================
app.get("/prices", async (req, res) => {
  try {
    const response = await fetch(QLD_API_URL, {
      method: "GET",
      headers: {
        Authorization: `FPDAPI SubscriberToken=${QLD_TOKEN}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("QLD API Error:", response.status, text);
      return res
        .status(response.status)
        .json({ error: `QLD API ${response.status}`, message: text });
    }

    const data = await response.json();
    res.set("Access-Control-Allow-Origin", "*");
    res.json(data);
  } catch (err) {
    console.error("❌ QLD fetch failed:", err.message);
    res.status(500).json({ error: "QLD fetch failed", details: err.message });
  }
});

// ========================== NSW ==========================
app.get("/nsw", async (req, res) => {
  try {
    console.log("🟦 NSW endpoint hit");

    // Step 1: Get a fresh access token
    const tokenRes = await fetch(
      "https://api.onegov.nsw.gov.au/oauth/client_credential/accesstoken?grant_type=client_credentials",
      {
        method: "GET",
        headers: {
          "Authorization": process.env.NSW_AUTH, // Basic base64(clientId:secret)
          "Accept": "application/json"
        }
      }
    );

    const tokenText = await tokenRes.text();
    let tokenJson = {};
    try { tokenJson = JSON.parse(tokenText); } catch {}
    console.log("🔑 NSW token acquired:", !!tokenJson.access_token);

    if (!tokenJson.access_token) {
      return res.status(500).json({ error: "No NSW access token", details: tokenText });
    }

    // Step 2: Request NSW prices
    const now = new Date().toISOString();
    const fuelRes = await fetch(
      "https://api.onegov.nsw.gov.au/FuelPriceCheck/v2/fuel/prices/new?states=NSW",
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${tokenJson.access_token}`,
          "apikey": process.env.NSW_APIKEY,
          "transactionid": Date.now().toString(),
          "requesttimestamp": now,
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Origin": "https://fuel-proxy-119d.onrender.com"
        }
      }
    );

    const raw = await fuelRes.text();
    let data = {};
    try { data = JSON.parse(raw); } catch {}

    if (!fuelRes.ok) {
      console.error("❌ NSW API Error:", fuelRes.status, raw);
      return res.status(fuelRes.status).json({ error: "NSW fetch failed", details: raw });
    }

    console.log(`✅ NSW returned ${data.stations?.length || 0} stations and ${data.prices?.length || 0} prices`);
    res.set("Access-Control-Allow-Origin", "*");
    res.json(data);

  } catch (err) {
    console.error("❌ NSW fetch failed:", err);
    res.status(500).json({ error: "NSW fetch failed", details: err.message });
  }
});


// ========================== TAS ==========================
app.get("/tas", async (req, res) => {
  try {
    console.log("🟪 TAS endpoint hit");

    // Step 1: Get a fresh access token
    const tokenRes = await fetch(
      "https://api.onegov.nsw.gov.au/oauth/client_credential/accesstoken?grant_type=client_credentials",
      {
        method: "GET",
        headers: {
          "Authorization": process.env.NSW_AUTH, // same creds used for TAS
          "Accept": "application/json"
        }
      }
    );

    const tokenText = await tokenRes.text();
    let tokenJson = {};
    try { tokenJson = JSON.parse(tokenText); } catch {}
    console.log("🔑 TAS token acquired:", !!tokenJson.access_token);

    if (!tokenJson.access_token) {
      return res.status(500).json({ error: "No TAS access token", details: tokenText });
    }

    // Step 2: Request TAS prices
    const now = new Date().toISOString();
    const fuelRes = await fetch(
      "https://api.onegov.nsw.gov.au/FuelPriceCheck/v2/fuel/prices/new?states=TAS",
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${tokenJson.access_token}`,
          "apikey": process.env.NSW_APIKEY,
          "transactionid": Date.now().toString(),
          "requesttimestamp": now,
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Origin": "https://fuel-proxy-119d.onrender.com"
        }
      }
    );

    const raw = await fuelRes.text();
    let data = {};
    try { data = JSON.parse(raw); } catch {}

    if (!fuelRes.ok) {
      console.error("❌ TAS API Error:", fuelRes.status, raw);
      return res.status(fuelRes.status).json({ error: "TAS fetch failed", details: raw });
    }

    console.log(`✅ TAS returned ${data.stations?.length || 0} stations and ${data.prices?.length || 0} prices`);
    res.set("Access-Control-Allow-Origin", "*");
    res.json(data);

  } catch (err) {
    console.error("❌ TAS fetch failed:", err);
    res.status(500).json({ error: "TAS fetch failed", details: err.message });
  }
});





// ========================== ROOT TEST ==========================
app.get("/", (req, res) => {
  res.send(`
    <h2>🚀 FuelDaddy Proxy is Live</h2>
    <p>Available endpoints:</p>
    <ul>
      <li><a href="/prices">/prices</a> — QLD fuel prices</li>
      <li><a href="/nsw">/nsw</a> — NSW fuel prices</li>
      <li><a href="/tas">/tas</a> — TAS fuel prices</li>
    </ul>
  `);
});

// ========================== SERVER START ==========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ FuelDaddy Proxy running on port ${PORT}`)
);
