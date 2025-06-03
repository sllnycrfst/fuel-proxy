import express from 'express';
import axios from 'axios';

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/prices', async (req, res) => {
  try {
    const response = await axios.get(
      'https://fppdirectapi-prod.fuelpricesqld.com.au/Price/GetSitesPrices?countryId=21&geoRegionLevel=3&geoRegionId=1',
      {
        headers: {
          token: '90fb2504-6e01-4528-9640-b0f37265e749'
        }
      }
    );
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(response.data);
  } catch (err) {
    console.error('❌ Proxy API error:', err.message);
    res.status(500).json({ error: 'Failed to fetch fuel prices' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Proxy running on port ${PORT}`);
});
