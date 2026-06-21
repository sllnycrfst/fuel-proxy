// ─── NSW per-fuel outage detection (additive — does not touch existing routes) ──
//
// NSW FuelCheck has NO out-of-stock flag. A station signals "out of a fuel" by
// either dropping that fuel's row from the feed, or letting its price go stale
// while its other fuels keep updating. We detect both, server-side, and expose
// the result at GET /nsw/outages. Nothing here changes /prices, /nsw/prices,
// /sites or any other endpoint the iOS app depends on.
//
// Two signals, combined per (station, fuel):
//   1. DISAPPEARANCE (primary, precise): the station is actively reporting other
//      fuels in the latest FULL refresh, but this fuel — which it has sold within
//      the recent window — is absent from that refresh. Immune to "price hasn't
//      changed" noise, because a stable-price fuel still appears in every refresh.
//   2. STALENESS (fallback): the fuel's last report is older than OUT_DAYS while
//      the station itself is active. Catches the case where the feed keeps a stale
//      row instead of dropping it. Conservative threshold to limit false positives.
//
// Excludes LPG (6) and EV (333) — those are routinely delisted / unpriced and are
// not "out of fuel".

const fs = require('fs');
const path = require('path');

const EXCLUDE_FIDS = new Set([6, 333]); // LPG, EV
const REAL_PRICE_MIN = 100;             // NSW is x10; ignore junk/placeholder < 10 c/L

// Tunable via env (days)
const ACTIVE_DAYS = Number(process.env.NSW_OUT_ACTIVE_DAYS || 3);  // station counts as live
const OUT_DAYS    = Number(process.env.NSW_OUT_DAYS        || 21); // staleness fallback
const SEEN_DAYS   = Number(process.env.NSW_OUT_SEEN_DAYS   || 60); // "currently sells this fuel"
const FULL_FRESH_HRS = Number(process.env.NSW_OUT_FULL_FRESH_HRS || 36); // trust last full within this

const DAY = 86400000;
const STATE_FILE = path.join(__dirname, 'nsw-outage-state.json');

// everSeen[sid][fid] = lastFreshMs ; presentLastFull[sid] = [fid,...] ; lastFullMs
let everSeen = {};
let presentLastFull = {};
let lastFullMs = 0;

(function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    everSeen = raw.everSeen || {};
    presentLastFull = raw.presentLastFull || {};
    lastFullMs = raw.lastFullMs || 0;
    console.log(`[NSW-outage] state loaded: ${Object.keys(everSeen).length} stations`);
  } catch (e) { /* first boot — no state file */ }
})();

let saveTimer = null;
function persistSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({ everSeen, presentLastFull, lastFullMs }));
    } catch (e) { console.warn('[NSW-outage] persist failed:', e.message); }
  }, 2000);
}

function tsMs(iso) {
  const t = Date.parse(iso || '');
  return isNaN(t) ? 0 : t;
}

// Update everSeen lastFresh for a batch of converted SitePrices rows.
function touchEverSeen(rows) {
  for (const p of rows) {
    const fid = Number(p.FuelId);
    if (EXCLUDE_FIDS.has(fid)) continue;
    if (Number(p.Price) < REAL_PRICE_MIN) continue;
    const sid = String(p.SiteId);
    if (sid.indexOf('NSW_') !== 0 && sid.indexOf('ACT_') !== 0 && sid.indexOf('TAS_') !== 0) continue;
    const t = tsMs(p.TransactionDateUtc);
    if (!t) continue;
    if (!everSeen[sid]) everSeen[sid] = {};
    if (!everSeen[sid][fid] || t > everSeen[sid][fid]) everSeen[sid][fid] = t;
  }
}

// FULL refresh = the current complete availability set. Record what's present now.
function ingestFull(rows) {
  touchEverSeen(rows);
  const present = {};
  for (const p of rows) {
    const fid = Number(p.FuelId);
    if (EXCLUDE_FIDS.has(fid)) continue;
    if (Number(p.Price) < REAL_PRICE_MIN) continue;
    const sid = String(p.SiteId);
    (present[sid] || (present[sid] = [])).push(fid);
  }
  presentLastFull = present;
  lastFullMs = Date.now();
  persistSoon();
}

// DELTA refresh = only changed rows. Advance lastFresh; do NOT touch the present set.
function ingestDelta(rows) {
  touchEverSeen(rows);
  persistSoon();
}

function compute() {
  const now = Date.now();
  const fullTrusted = lastFullMs && (now - lastFullMs) <= FULL_FRESH_HRS * 3600000;
  const stations = [];
  let fuelRows = 0;

  for (const sid of Object.keys(everSeen)) {
    const fuels = everSeen[sid];
    const fids = Object.keys(fuels).map(Number);
    if (!fids.length) continue;

    // Station must be currently active (some fuel reported within ACTIVE_DAYS).
    const freshest = Math.max(...fids.map(f => fuels[f]));
    if (now - freshest > ACTIVE_DAYS * DAY) continue;

    const presentSet = fullTrusted && presentLastFull[sid] ? new Set(presentLastFull[sid]) : null;
    const out = [];
    const lastSeen = {};
    for (const fid of fids) {
      const age = now - fuels[fid];
      if (age > SEEN_DAYS * DAY) continue; // station no longer sells this fuel at all
      const disappeared = presentSet ? !presentSet.has(fid) : false;
      const stale = age > OUT_DAYS * DAY;
      if (disappeared || stale) {
        out.push(fid);
        lastSeen[fid] = new Date(fuels[fid]).toISOString();
      }
    }
    if (out.length) {
      out.sort((a, b) => a - b);
      stations.push({ SiteId: sid, fuels: out, lastSeen });
      fuelRows += out.length;
    }
  }

  stations.sort((a, b) => a.SiteId.localeCompare(b.SiteId));
  return {
    generatedAt: new Date(now).toISOString(),
    method: fullTrusted ? 'disappearance+staleness' : 'staleness-only',
    params: { activeDays: ACTIVE_DAYS, outDays: OUT_DAYS, seenDays: SEEN_DAYS },
    lastFullRefresh: lastFullMs ? new Date(lastFullMs).toISOString() : null,
    count: stations.length,
    fuelRowCount: fuelRows,
    stations,
  };
}

module.exports = { ingestFull, ingestDelta, compute };
