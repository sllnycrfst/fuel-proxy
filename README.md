# fuel-proxy

Combined QLD + NSW + ACT fuel price proxy for [fueldaddy.com.au](https://fueldaddy.com.au).
Single Render service replacing the two-service setup (`fuel-proxy` for QLD and `fuel-daddy-nsw-proxy` for NSW) that was tripping Render's 750h/month free tier cap.

## Endpoints

| Route | Returns | Notes |
|---|---|---|
| `/` | Service info + NSW cache status | Health-ish JSON dump |
| `/health` | `{ ok: true }` | Liveness probe |
| `/prices` | QLD `{ SitePrices: [...] }` | **Legacy** — same as v1, kept for back-compat |
| `/sites` | QLD station list | **Legacy** — cached 24h |
| `/qld/prices` | QLD `{ SitePrices: [...] }` | Explicit alias of `/prices` |
| `/qld/sites` | QLD station list | Explicit alias of `/sites` |
| `/nsw/prices` | NSW `{ SitePrices: [...] }` in QLD shape | Cached, deltas every 20 min |
| `/nsw/sites` | NSW station list in QLD shape | Refreshed daily |
| `/nsw/suburbs` | NSW suburb list `[{ suburb, state, postcode, lat, lng }]` | Built from station addresses |
| `/nsw/refresh?token=...` | Force NSW full refresh | Admin only — protected by `REFRESH_TOKEN` |
| `/all/prices` | `{ qld, nsw, qldError, nswError }` | Single round-trip when callers need both |
| `/mapkit-token` | `{ token }` for sellanycarfast.com.au | Reads `MAPKIT_TOKEN` env var |

## Local dev

```bash
cp .env.example .env   # fill in NSW_API_KEY / NSW_API_SECRET
npm install
npm run dev
curl http://localhost:3000/health
curl http://localhost:3000/prices | head -c 500
```

If `NSW_API_KEY` and `NSW_API_SECRET` are missing the service still starts — QLD endpoints work, NSW endpoints return 503 with a clear "NSW disabled" message.

## Deployment (Render)

This repo deploys to the Render service backing `https://fuel-proxy-1l9d.onrender.com`. Required env vars:

- `NSW_API_KEY` — copy from the old `fuel-daddy-nsw-proxy` service
- `NSW_API_SECRET` — same
- `REFRESH_TOKEN` — random string of your choice
- `MAPKIT_TOKEN` — (optional) only if `sellanycarfast.com.au` still uses this proxy
- `QLD_TOKEN` — (optional) defaults to the in-code prod token

After env vars are set + a deploy completes:
1. `curl https://fuel-proxy-1l9d.onrender.com/health` → `{ ok: true }`
2. `curl https://fuel-proxy-1l9d.onrender.com/nsw/prices | head -c 300` → JSON with `SitePrices`
3. Update site code so any reference to `fuel-daddy-nsw-proxy.onrender.com/prices` points to `fuel-proxy-1l9d.onrender.com/nsw/prices`
4. Suspend the old `fuel-daddy-nsw-proxy` service in Render

## NSW quota

Free NSW FuelCheck tier is 2,500 API calls/month. The proxy budget:

- Boot: 1 token + 1 full prices = 2 calls
- Delta tick every 20 min: ~2,160 calls/month
- Daily full refresh: ~30 calls/month
- Re-auth on 12h token expiry: ~60 calls/month
- **Total: ~2,250 calls/month** — comfortably under cap

## Files

- `server.js` — Express routing + NSW refresh loop
- `qld.js` — QLD API client (prices on-demand, sites cached 24h)
- `nsw-api.js` — NSW OAuth + authed GET helper
- `transform.js` — NSW → QLD shape converter (fuel codes, brand IDs, timestamps)
