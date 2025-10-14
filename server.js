const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();
app.use(cors()); // ✅ Enables CORS globally
app.use(express.json());

// ========== QLD Route ==========
const API_URL = "https://fppdirectapi-prod.fuelpricesqld.com.au/Price/GetSitesPrices";
const TOKEN = "90fb2504-6e01-4528-9640-b0f37265e749";

app.get("/prices", async (req, res) => {
  try {
    const response = await fetch(API_URL, {
      method: "POST", // ✅ QLD API requires POST, not GET
      headers: {
        Authorization: `FPDAPI SubscriberToken=${TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({})
    });

    const data = await response.json();
    res.set("Access-Control-Allow-Origin", "*");
    res.json(data);
  } catch (err) {
    console.error("❌ External API error:", err.message);
    res.status(500).json({ error: "External API error", details: err.message });
  }
});

// ========== NSW Route ==========
app.get("/nsw", async (req, res) => {
  try {
    const response = await fetch("https://api.onegov.nsw.gov.au/FuelPriceCheck/v1/fuel/prices", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Basic dXU0WjIzU1pxa3M2aExGV0ZoWUpVSXliVDhvQWtIV1I6d3JFY2tKWG5aazB5TmJXSA==",
        "apikey": "uu4Z23SZqks6hLFWFhYJUIybT8oAkHWR"
      }
    });

    if (!response.ok) {
      console.error("NSW API Error:", response.status);
      return res.status(response.status).json({ error: `NSW API ${response.status}` });
    }

    const data = await response.json();
    res.set("Access-Control-Allow-Origin", "*");
    res.json(data);
  } catch (err) {
    console.error("NSW fetch failed:", err);
    res.status(500).json({ error: "NSW fetch failed" });
  }
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Fuel proxy running on port ${PORT}`));
