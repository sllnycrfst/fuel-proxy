const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ========== QLD Route ==========
const QLD_API_URL = "https://fppdirectapi-prod.fuelpricesqld.com.au/Price/GetSitesPrices";
const QLD_TOKEN = "90fb2504-6e01-4528-9640-b0f37265e749";

app.get("/prices", async (req, res) => {
  try {
    const response = await fetch(QLD_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `FPDAPI-SubscriberToken=${QLD_TOKEN}`, // ✅ fixed dash
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      console.error("QLD API Error:", response.status);
      return res.status(response.status).json({ error: `QLD API ${response.status}` });
    }

    const data = await response.json();
    res.set("Access-Control-Allow-Origin", "*");
    res.json(data);
  } catch (err) {
    console.error("❌ QLD fetch failed:", err.message);
    res.status(500).json({ error: "QLD fetch failed", details: err.message });
  }
});

// ========== NSW Route ==========
app.get("/nsw", async (req, res) => {
  try {
    const response = await fetch("https://api.onegov.nsw.gov.au/FuelPriceCheck/v1/fuel/prices", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": process.env.NSW_AUTH,
        "apikey": process.env.NSW_APIKEY,
        "transactionid": Date.now().toString(),
        "requesttimestamp": new Date().toISOString(),
        "User-Agent": "FuelDaddyProxy/1.0"
      },
    });

    if (!response.ok) {
      console.error("NSW API Error:", response.status);
      return res.status(response.status).json({ error: `NSW API ${response.status}` });
    }

    const data = await response.json();
    res.set("Access-Control-Allow-Origin", "*");
    res.json(data);
  } catch (err) {
    console.error("❌ NSW fetch failed:", err.message);
    res.status(500).json({ error: "NSW fetch failed", details: err.message });
  }
});

// ========== Root Route ==========
app.get("/", (req, res) => {
  res.send(`
    <h2>🚀 Fuel Proxy is live!</h2>
    <p>Available endpoints:</p>
    <ul>
      <li><a href="/prices">/prices</a> — QLD fuel prices</li>
      <li><a href="/nsw">/nsw</a> — NSW fuel prices</li>
    </ul>
  `);
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Fuel proxy running on port ${PORT}`));
