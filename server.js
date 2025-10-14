const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ========================== QLD ==========================
const QLD_API_URL = "https://fppdirectapi-prod.fuelpricesqld.com.au/Price/GetSitesPrices?countryId=21&geoRegionLevel=3&geoRegionId=1";
const QLD_TOKEN = "90fb2504-6e01-4528-9640-b0f37265e749";

app.get("/prices", async (req, res) => {
  try {
    const response = await fetch(QLD_API_URL, {
      method: "GET", // ✅ Switched from POST to GET
      headers: {
        "Authorization": `FPDAPI SubscriberToken=${QLD_TOKEN}`, // ✅ keep the space
        "Accept": "application/json"
      }
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("QLD API Error:", response.status, text);
      return res.status(response.status).json({ error: `QLD API ${response.status}`, message: text });
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
    // Step 1: Get access token
    const tokenResponse = await fetch(
      "https://api.onegov.nsw.gov.au/oauth/client_credential/accesstoken?grant_type=client_credentials",
      {
        method: "POST",
        headers: {
          "Authorization": process.env.NSW_AUTH,
          "apikey": process.env.NSW_APIKEY,
          "Content-Type": "application/json",
          "Content-Length": "0"
        }
      }
    );

    const rawText = await tokenResponse.text();
    let tokenData = {};
    try {
      tokenData = JSON.parse(rawText);
    } catch {
      console.error("❌ NSW token not JSON:", rawText);
      return res.status(500).json({ error: "Invalid NSW token response", body: rawText });
    }

    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error("NSW Token Error:", tokenResponse.status, tokenData);
      return res.status(tokenResponse.status).json({ error: "NSW token fetch failed", message: tokenData });
    }

    const accessToken = tokenData.access_token;

    // Step 2: Get fuel prices
    const fuelResponse = await fetch("https://api.onegov.nsw.gov.au/FuelPriceCheck/v1/fuel/prices", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "apikey": process.env.NSW_APIKEY,
        "transactionid": Date.now().toString(),
        "requesttimestamp": new Date().toISOString(),
        "User-Agent": "FuelDaddyProxy/1.0",
        "Accept": "application/json"
      }
    });

    const fuelRaw = await fuelResponse.text();
    let fuelData = {};
    try {
      fuelData = JSON.parse(fuelRaw);
    } catch {
      console.error("❌ NSW fuel response not JSON:", fuelRaw);
      return res.status(500).json({ error: "Invalid NSW fuel response", body: fuelRaw });
    }

    if (!fuelResponse.ok) {
      console.error("NSW API Error:", fuelResponse.status, fuelData);
      return res.status(fuelResponse.status).json({ error: "NSW API fetch failed", message: fuelData });
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
    <h2>🚀 Fuel Proxy is Live</h2>
    <p>Available endpoints:</p>
    <ul>
      <li><a href="/prices">/prices</a> — QLD fuel prices</li>
      <li><a href="/nsw">/nsw</a> — NSW fuel prices</li>
    </ul>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Fuel Proxy running on port ${PORT}`));
