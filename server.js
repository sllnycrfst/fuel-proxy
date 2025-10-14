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

// ========================== NSW ROUTE ==========================
app.get("/nsw", async (req, res) => {
  try {
    const statesParam = req.query.states || "NSW"; // allows NSW or NSW,TAS
    const mode = req.query.mode || "new"; // default "new" endpoint

    // 1️⃣ Fetch Access Token
    const tokenResponse = await fetch(
      "https://api.onegov.nsw.gov.au/oauth/client_credential/accesstoken?grant_type=client_credentials",
      {
        method: "GET",
        headers: {
          Authorization: NSW_AUTH,
          Accept: "application/json",
        },
      }
    );

    const rawToken = await tokenResponse.text();
    let tokenData = {};
    try {
      tokenData = JSON.parse(rawToken);
    } catch {}

    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error("NSW Token Error:", tokenResponse.status, rawToken);
      return res
        .status(tokenResponse.status)
        .json({ error: "NSW token fetch failed", message: rawToken });
    }

    const accessToken = tokenData.access_token;
    const requesttimestamp = new Date().toISOString();
    const transactionId = Date.now().toString();

    // 2️⃣ Fetch Fuel Prices (v2)
    const apiUrl = `https://api.onegov.nsw.gov.au/FuelPriceCheck/v2/fuel/prices/${mode}?states=${statesParam}`;
    const fuelResponse = await fetch(apiUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=utf-8",
        apikey: NSW_APIKEY,
        transactionid: transactionId,
        requesttimestamp,
        Accept: "application/json",
        "User-Agent": "FuelDaddyProxy/1.0",
      },
    });

    const rawFuel = await fuelResponse.text();
    let fuelData = {};
    try {
      fuelData = JSON.parse(rawFuel);
    } catch {}

    if (!fuelResponse.ok) {
      console.error("NSW API Error:", fuelResponse.status, rawFuel);
      return res
        .status(fuelResponse.status)
        .json({ error: "NSW API fetch failed", message: rawFuel });
    }

    res.set("Access-Control-Allow-Origin", "*");
    res.json(fuelData);
  } catch (err) {
    console.error("❌ NSW fetch failed:", err.message);
    res.status(500).json({ error: "NSW fetch failed", details: err.message });
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
      <li><a href="/nsw?states=NSW,TAS">/nsw?states=NSW,TAS</a> — NSW + TAS</li>
    </ul>
  `);
});

// ========================== SERVER START ==========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ FuelDaddy Proxy running on port ${PORT}`)
);
