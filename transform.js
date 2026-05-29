// ─── NSW → QLD format conversion ─────────────────────────
// Converts NSW FuelCheck API responses to match the existing
// QLD fuel proxy shape so the app code stays unchanged.

// NSW fuel codes → QLD numeric fuel IDs
// QLD: { E10: 12, 91: 2, 95: 5, 98: 8, Diesel: 3, PremiumDiesel: 14, LPG: 6, E85: 19, EV: 333 }
const NSW_FUEL_TO_QLD_ID = {
  'E10': 12,
  'U91': 2,
  'P95': 5,
  'P98': 8,
  'DL':  3,
  'PDL': 14,
  'LPG': 6,
  'E85': 19,
  'E94': 12,   // Ethanol 94 — closest to E10 in QLD's set
  'EV':  333,
  'B20': 14,   // Biodiesel 20 → use Premium Diesel slot
  'CNG': 6,    // CNG → LPG slot (closest gas equivalent)
};

// NSW brand string → QLD brand ID (existing brand IDs from app)
// Falls back to a stable hash-based ID for unknown brands.
const NSW_BRAND_TO_QLD_ID = {
  'BP':            '5',
  'Shell':         '20',
  'Caltex':        '2',
  '7-Eleven':      '113',
  'Coles Express': '111',
  'Costco':        '2031031',
  'Liberty':       '86',
  'United':        '23',
  'Ampol':         '3421066',
  'Ampol Foodary': '3421066', // share Ampol logo
  'Ampol Breeze':  '3421066',
  'EBM Ampol':     '3421066',
  'Reddy Express': '3421193',
  'EG Ampol':      '3421073',
  'Pearl Energy':  '3421139',
  // NSW-specific brands assigned numeric IDs so they pick up png logos:
  'Metro Fuel':    '57',
  'Mobil':         '16',
  'U-Go':          'NSW_U-Go',
  'NRMA':          'NSW_NRMA',
  'Tesla':         'NSW_Tesla',
};

// For NSW-only brands the app doesn't know yet — assign stable string IDs.
// The app will display these as the brand name directly when not in BRAND_NAMES.
function brandToId(nswBrand) {
  if (!nswBrand) return '0';
  // Direct match
  if (NSW_BRAND_TO_QLD_ID[nswBrand]) return NSW_BRAND_TO_QLD_ID[nswBrand];
  // Case/space-insensitive match
  const normalised = nswBrand.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [name, id] of Object.entries(NSW_BRAND_TO_QLD_ID)) {
    if (name.toLowerCase().replace(/[^a-z0-9]/g, '') === normalised) return id;
  }
  // Unknown brand — use the brand string as the ID, prefixed
  return 'NSW_' + nswBrand.replace(/[^A-Za-z0-9]/g, '');
}

// QLD station IDs are numeric like 61290151. NSW station codes are 4-5 digits.
// Prefix with state to avoid collision and make origin obvious in logs/UI.
// Falls back to NSW_ if state unknown (v1 API doesn't return state).
function siteId(code, state) {
  const stateUpper = (state || 'NSW').toUpperCase();
  return `${stateUpper}_${String(code)}`;
}

// NSW returns 189.9 (cents/L decimal). QLD returns 1899 (tenths of cents).
// Multiply by 10 and round to match QLD format.
function priceToQLD(nswPrice) {
  return Math.round(parseFloat(nswPrice) * 10);
}

// NSW timestamps come in two formats: 'dd/MM/yyyy HH:mm:ss' or 'yyyy-MM-dd HH:mm:ss'.
// Output ISO 8601 to match QLD's TransactionDateUtc.
function parseDate(ts) {
  if (!ts) return new Date().toISOString();
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}T/.test(ts)) return ts;
  // dd/MM/yyyy HH:mm:ss
  const m = ts.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (m) {
    const [, dd, MM, yyyy, hh, mm, ss] = m;
    return new Date(`${yyyy}-${MM}-${dd}T${hh}:${mm}:${ss}Z`).toISOString();
  }
  // yyyy-MM-dd HH:mm:ss
  const m2 = ts.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})$/);
  if (m2) return new Date(`${m2[1]}T${m2[2]}Z`).toISOString();
  // Fallback
  return new Date().toISOString();
}

// Build a station-code → state lookup so we can prefix prices correctly.
// v2 returns state on the station, so we use that.
let stationStateLookup = {};

function getStationState(addr, fallback) {
  // Address regex: "..., SUBURB STATE 1234". Also matches "NEW SOUTH WALES".
  const m = (addr || '').match(/\b(NSW|VIC|TAS|QLD|SA|WA|ACT|NT)\b|NEW SOUTH WALES/i);
  if (m) {
    const v = m[1] || 'NSW';
    return v.toUpperCase();
  }
  return fallback;
}

// ─── Convert station list → QLD sites array ──────────────
// QLD shape: { S, A, N, B, P, Lat, Lng, M, ... }
function nswStationsToQLD(stations) {
  stationStateLookup = {}; // reset
  return stations.map(s => {
    const code = s.code ?? s.stationid ?? s.stationcode;
    const name = s.name || '';
    const address = s.address || '';
    const brand = s.brand || '';
    const lat = s.location?.latitude ?? s.latitude ?? 0;
    const lng = s.location?.longitude ?? s.longitude ?? 0;
    // The v2 API's `state` field mislabels ACT stations as NSW.
    // Address parsing is more reliable. Fall back to API field only if no match.
    const addrState = getStationState(address, null);
    const state = (addrState || s.state || 'NSW').toUpperCase();

    let postcode = s.postcode || '';
    if (!postcode) {
      const pcMatch = address.match(/\b(\d{4})\b/);
      if (pcMatch) postcode = pcMatch[1];
    }

    // Cache state for this station code so we can prefix prices later
    stationStateLookup[String(code)] = state;

    return {
      S: siteId(code, state),
      A: address,
      N: name,
      B: brandToId(brand),
      P: postcode,
      Lat: lat,
      Lng: lng,
      M: new Date().toISOString(),
      G1: 0, G2: 0, G3: 1, G4: 0, G5: 0,
      GPI: '',
      MO: '', MC: '', TO: '', TC: '', WO: '', WC: '',
      THO: '', THC: '', FO: '', FC: '', SO: '', SC: '', SUO: '', SUC: '',
      State: state,
      BrandName: brand,
    };
  });
}

// ─── Convert prices → QLD SitePrices array ───────────────
// QLD shape: { SiteId, FuelId, CollectionMethod, TransactionDateUtc, Price }
// Uses stationStateLookup populated by nswStationsToQLD() for correct prefixing.
function nswPricesToQLD(prices) {
  const out = [];
  for (const p of prices) {
    const fuelId = NSW_FUEL_TO_QLD_ID[p.fueltype];
    if (!fuelId) continue;

    const state = stationStateLookup[String(p.stationcode)] || 'NSW';
    out.push({
      SiteId: siteId(p.stationcode, state),
      FuelId: fuelId,
      CollectionMethod: state.charAt(0), // N/T/A for NSW/TAS/ACT
      TransactionDateUtc: parseDate(p.lastupdated),
      Price: priceToQLD(p.price),
    });
  }
  return out;
}

module.exports = {
  nswStationsToQLD,
  nswPricesToQLD,
  brandToId,
  siteId,
  NSW_FUEL_TO_QLD_ID,
};
