const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

const API_URL = "https://fppdirectapi-prod.fuelpricesqld.com.au/Price/GetSitesPrices?countryId=21";

app.get("/prices", async (req, res) => {
  try {
    const response = await fetch(API_URL, {
      method: "GET",
      headers: {
        "FPDAPI-SubscriberToken": "90fb2504-6e01-4528-9640-b0f37265e749",
        "Content-Type": "application/json"
      }
    });

    const text = await response.text();

    if (!response.ok) {
      console.error("❌ API response not OK:", text);
      return res.status(500).json({ error: "External API error", details: text });
    }

    res.type("json").send(text);
  } catch (err) {
    console.error("❌ Proxy failed:", err);
    res.status(500).json({ error: "Failed to fetch prices from API" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Proxy running on port ${PORT}`);
});
