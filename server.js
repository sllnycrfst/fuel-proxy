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
const QLD_API_URL =
  "https://fppdirectapi-prod.fuelpricesqld.com.au/Price/GetSitesPrices?countryId=21&geoRegionLevel=3&geoRegionId=1";
const QLD_TOKEN = "90fb2504-6e01-4528-9640-b0f37265e749";

app.get("/prices", async (req, res) => {
  try {
    console.log("🟩 QLD endpoint hit");

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
      return res.status(response.status).json({
        error: `QLD API ${response.status}`,
        message: text,
      });
    }

    const data = await response.json();
    console.log(`✅ QLD returned ${data?.SitePrices?.length || 0} prices`);
    res.set("Access-Control-Allow-Origin", "*");
    res.json(data);
  } catch (err) {
    console.error("❌ QLD fetch failed:", err.message);
    res.status(500).json({
      error: "QLD fetch failed",
      details: err.message,
    });
  }
});

// ========================== VIN LOOKUP (Eval Expert / AlgoDriven) ==========================
app.post("/vin", async (req, res) => {
  try {
    console.log("🚗 VIN lookup hit", req.body);

    const response = await fetch("https://algodriven.io/v1/vindataext", {
      method: "POST",
      headers: {
        "Authorization":
          "4PdxaDHXXmPE4b9O3v19fW0zrL8dXu+WxwzVJXO4sngB/9+b5qh/iDF04aMEZMABVy8oFYjBIKZLqTTbzLtXvOc/QBcONPJ40/Ma67AiWSQ=",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("VIN API error:", response.status, text);
      return res.status(response.status).json({
        error: `VIN API ${response.status}`,
        message: text,
      });
    }

    const data = await response.json();
    console.log("✅ VIN lookup success");
    res.json(data);
  } catch (err) {
    console.error("❌ VIN fetch failed:", err.message);
    res.status(500).json({ error: "Proxy error", details: err.message });
  }
});

// ========================== ROOT TEST PAGE ==========================
app.get("/", (req, res) => {
  res.send(`
    <h1>🚀 FuelDaddy Proxy is Live</h1>
    <p>This proxy currently supports:</p>
    <ul>
      <li>⛽ <a href="/prices">/prices</a> — Live QLD fuel prices (JSON)</li>
      <li>🚗 <strong>POST /vin</strong> — Eval Expert VIN lookup</li>
    </ul>
    <p>Powered by <em>FuelDaddy</em> — ${new Date().toLocaleString("en-AU")}</p>
  `);
});

// ========================== START SERVER ==========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ FuelDaddy + EvalExpert proxy running on port ${PORT}`)
);
