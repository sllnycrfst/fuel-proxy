const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();
app.use(cors());

const TOKEN = "FPDAPI SubscriberToken=90fb2504-6e01-4528-9640-b0f37265e749";
const API_URL = "https://fppdirectapi-prod.fuelpricesqld.com.au/Price/GetSitesPrices";

app.get("/prices", async (req, res) => {
  try {
    const response = await fetch(API_URL, {
      method: "GET",
      headers: {
        Authorization: TOKEN,
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      return res.status(500).json({ error: "Failed to fetch prices from API" });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Backend error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy server listening on port ${PORT}`);
});
