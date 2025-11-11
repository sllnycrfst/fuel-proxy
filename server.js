const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ========================== QLD ==========================
const QLD_API_URL =
  "https://fppdirectapi-prod.fuelpricesqld.com.au/Price/GetSitesPrices?countryId=21&geoRegionLevel=3&geoRegionId=1";
const QLD_TOKEN = "90fb2504-6e01-4528-9640-b0f37265e749";

// ---------- QLD endpoint ----------
app.get("/prices", async (req, res) => {
  try {
    console.log("🟩 QLD endpoint hit");

    const response = await fetch(QLD_API_URL, {
      method: "GET",
      headers: {
        "Authorization": `FPDAPI SubscriberToken=${QLD_TOKEN}`,
        "Accept": "application/json"
      }
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("QLD API Error:", response.status, text);
      return res.status(response.status).json({
        error: `QLD API ${response.status}`,
        message: text
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
      details: err.message
    });
  }
});

// ---------- Root test page ----------
app.get("/", (req, res) => {
  res.send(`
    <h1>🚀 FuelDaddy Proxy is Live</h1>
    <p>This proxy currently supports <strong>Queensland fuel prices only</strong>.</p>
    <ul>
      <li><a href="/prices">/prices</a> — Live QLD fuel prices (JSON)</li>
    </ul>
    <p>Powered by <em>FuelDaddy</em> — ${new Date().toLocaleString("en-AU")}</p>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ FuelDaddy QLD Proxy running on port ${PORT}`));

app.post("/vin", async (req, res) => {
  try {
    const response = await fetch("https://algodriven.io/v1/vindataext", {
      method: "POST",
      headers: {
        "Authorization": "4PdxaDHXXmPE4b9O3v19fW0zrL8dXu+WxwzVJXO4sngB/9+b5qh/iDF04aMEZMABVy8oFYjBIKZLqTTbzLtXvOc/QBcONPJ40/Ma67AiWSQ=",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Proxy error", details: err.message });
  }
});
