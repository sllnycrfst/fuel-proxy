// api/prices.js
import express from 'express';
import axios from 'axios';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const response = await axios.get(
      'https://fppdirectapi-prod.fuelpricesqld.com.au/Price/GetSitesPrices?countryId=21&geoRegionLevel=3&geoRegionId=1',
      {
        headers: {
          'FPDAPI-SubscriberToken': '90fb2504-6e01-4528-9640-b0f37265e749',
        },
      }
    );
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json(response.data);
  } catch (err) {
    console.error('❌ Fuel API error:', err.message);
    res.status(500).json({ error: 'Failed to fetch fuel prices' });
  }
});

export default router;
