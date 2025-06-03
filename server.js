const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

const API_URL = "https://fppdirectapi-prod.fuelpricesqld.com.au/Price/GetSitesPrices?countryId=21&geoRegionLevel=3&geoRegionId=1";

app.get("/prices", async (req, res) => {
  try {
    const response = await fetch(API_URL, {
      method: "GET",
      headers: {
  "FPDAPI-SubscriberToken": "90fb2504-6e01-4528-9640-b0f37265e749",
  "Content-Type": "application/json"
}
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("❌ API fetch failed:", err.message);
    res.status(500).json({ error: "Failed to fetch prices from API" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
