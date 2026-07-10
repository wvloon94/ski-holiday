// Aggregates all tools/playwright/results/*.json search results plus
// region-info.json into a single self-contained HTML overview page.
//
// Usage (from tools/playwright/): node build-html.js > ../../index.html

const fs = require('fs');
const path = require('path');

const RESULTS_DIR = path.join(__dirname, 'results');
const regionInfo = JSON.parse(fs.readFileSync(path.join(__dirname, 'region-info.json'), 'utf8'));

function weekdayName(dateStr) {
  const days = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
  return days[new Date(dateStr + 'T12:00:00Z').getUTCDay()];
}

function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  const months = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]}`;
}

function parseLiftDistanceM(skiLiftDistance) {
  if (!skiLiftDistance) return null;
  const m = skiLiftDistance.match(/([\d.,]+)\s?(m|km)/i);
  if (!m) return null;
  const num = parseFloat(m[1].replace(',', '.'));
  return m[2].toLowerCase() === 'km' ? Math.round(num * 1000) : Math.round(num);
}

// ISO-8601 weeknummer (week met de eerste donderdag van het jaar is week 1).
function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7; // maandag = 0 .. zondag = 6
  d.setUTCDate(d.getUTCDate() - day + 3); // naar de donderdag van deze week
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  return 1 + Math.round((d - firstThursday) / (7 * 24 * 3600 * 1000));
}

// De groep heeft besloten de reis uiterlijk 4 februari 2027 te laten eindigen
// (i.p.v. de volledige 21 jan – 2 mrt scrape-periode) — opties die later
// eindigen worden hier weggelaten.
const LATEST_CHECKOUT = '2027-02-04';

const SLOPE_KM_RANGE = (() => {
  const vals = Object.values(regionInfo.regions).map((r) => r.slopeKm);
  return { min: Math.min(...vals), max: Math.max(...vals) };
})();

// Gemiddelde van min- en max-hoogte van het skigebied: een gebied dat zowel
// hoog begint als hoog eindigt is sneeuwzekerder dan een gebied met alleen
// een hoge top maar een laaggelegen dal.
const ALTITUDE_RANGE = (() => {
  const vals = Object.values(regionInfo.regions).map((r) => (r.minAltitude + r.maxAltitude) / 2);
  return { min: Math.min(...vals), max: Math.max(...vals) };
})();

// Booking.com's own "meal plan included" text tells us whether breakfast
// and/or dinner are baked into the room price. Priced at €15pp for breakfast
// and €30pp for dinner (per night) if you'd have to arrange it yourself —
// used both for the fair-comparison "effective price" in the relevance score
// and for the all-in total-cost-per-person column.
const BREAKFAST_COST = 15;
const DINNER_COST = 30;

function classifyMealPlan(text) {
  const t = (text || '').toLowerCase();
  const allInclusive = t.includes('all-inclusive') || t.includes('all inclusive');
  const breakfastIncluded = allInclusive || t.includes('breakfast');
  const dinnerIncluded = allInclusive || t.includes('dinner');
  const savingsPerNight = (breakfastIncluded ? BREAKFAST_COST : 0) + (dinnerIncluded ? DINNER_COST : 0);

  let code = 'none';
  let label = 'Geen maaltijden';
  if (allInclusive) { code = 'all-inclusive'; label = 'All-inclusive'; }
  else if (breakfastIncluded && dinnerIncluded) { code = 'half-board'; label = 'Ontbijt & diner'; }
  else if (breakfastIncluded) { code = 'breakfast'; label = 'Ontbijt'; }
  else if (text) { code = 'other'; label = text; }

  return { code, label, breakfastIncluded, dinnerIncluded, savingsPerNight };
}

// Relevantiescore (0-100), opgebouwd uit wat is aangegeven als prioriteiten:
// grootte skigebied + prijs wegen het zwaarst (20 + 25), gratis annuleren en
// afstand-tot-piste zijn de expliciete "eisen" (20 + 15), hoogte/sneeuwzekerheid
// telt mee (10, hoe hoger hoe beter), reviewscore is een kwaliteitssignaal (7),
// après-ski is nadrukkelijk de laagste prioriteit (3). Prijs wordt beoordeeld
// op het "effectieve" pp/nacht-bedrag: inbegrepen ontbijt/diner telt als korting.
function computeRelevance({ pppn, freeCancellation, skiInOut, skiLiftDistanceM, score, mealPlanSavings }, region) {
  const effectivePppn = pppn - (mealPlanSavings || 0);
  let priceScore;
  if (effectivePppn <= 100) priceScore = 25;
  else if (effectivePppn <= 150) priceScore = 25 - ((effectivePppn - 100) / 50) * 15; // 25 -> 10
  else if (effectivePppn <= 250) priceScore = 10 - ((effectivePppn - 150) / 100) * 10; // 10 -> 0
  else priceScore = 0;
  priceScore = Math.max(0, priceScore);

  const cancelScore = freeCancellation ? 20 : 0;

  let liftScore;
  if (skiInOut) liftScore = 15;
  else if (skiLiftDistanceM != null) {
    if (skiLiftDistanceM <= 200) liftScore = 14;
    else if (skiLiftDistanceM <= 500) liftScore = 12;
    else if (skiLiftDistanceM <= 1000) liftScore = 9;
    else if (skiLiftDistanceM <= 2000) liftScore = 5;
    else liftScore = 2;
  } else {
    liftScore = 7; // onbekend: neutraal, want Booking.com toont dit niet altijd
  }

  const reviewScore = score != null ? 0.7 * Math.min(10, score) : 4.2;

  const slopeRange = SLOPE_KM_RANGE.max - SLOPE_KM_RANGE.min || 1;
  const slopeScore = 20 * ((region.slopeKm - SLOPE_KM_RANGE.min) / slopeRange);

  const avgAltitude = (region.minAltitude + region.maxAltitude) / 2;
  const altitudeRange = ALTITUDE_RANGE.max - ALTITUDE_RANGE.min || 1;
  const altitudeScore = 10 * ((avgAltitude - ALTITUDE_RANGE.min) / altitudeRange);

  const apresScore = (region.apresSkiRank / 5) * 3;

  const total = priceScore + cancelScore + liftScore + reviewScore + slopeScore + altitudeScore + apresScore;
  return Math.round(total * 10) / 10;
}

function parseScore(scoreText) {
  if (!scoreText) return { score: null, word: null, reviews: null };

  // Airbnb rates out of 5 ("4.93 out of 5 (14 reviews)"); double it so it
  // lands on the same 0-10 scale as Booking.com review scores.
  const airbnbMatch = scoreText.match(/([\d.]+)\s+out of 5(?:.*?([\d,]+)\s+reviews?)?/i);
  if (airbnbMatch) {
    const score = Math.round(parseFloat(airbnbMatch[1]) * 2 * 10) / 10;
    const reviews = airbnbMatch[2] ? parseInt(airbnbMatch[2].replace(/,/g, ''), 10) : null;
    return { score, word: null, reviews };
  }

  const lines = scoreText.split('\n').filter(Boolean);
  const score = lines[1] ? parseFloat(lines[1]) : null;
  const word = lines[2] || null;
  const reviewsMatch = (lines[3] || '').match(/[\d,]+/);
  const reviews = reviewsMatch ? parseInt(reviewsMatch[0].replace(/,/g, ''), 10) : null;
  return { score, word, reviews };
}

function collectListings() {
  const files = fs.readdirSync(RESULTS_DIR).filter((f) => /^[a-z-]+_.*\.json$/.test(f) && !f.includes('log'));
  const listings = [];
  const errors = [];
  for (const file of files) {
    const destSlug = file.split('_')[0];
    const region = regionInfo.regions[destSlug];
    if (!region) {
      errors.push(`Unknown destination slug "${destSlug}" in ${file}`);
      continue;
    }
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, file), 'utf8'));
    } catch (e) {
      errors.push(`Failed to parse ${file}: ${e.message}`);
      continue;
    }
    if (data.checkout > LATEST_CHECKOUT) continue;
    const weekday = weekdayName(data.checkin);
    const weekNr = isoWeek(data.checkin);
    const source = data.source === 'airbnb' ? 'Airbnb' : 'Booking.com';
    for (const r of data.results) {
      if (!r.totalPrice) continue;
      const { score, word, reviews } = parseScore(r.scoreText);
      const skiLiftDistanceM = parseLiftDistanceM(r.skiLiftDistance);
      const mealPlan = classifyMealPlan(r.mealPlanText);
      const relevance = computeRelevance(
        {
          pppn: r.perPersonPerNight,
          freeCancellation: r.freeCancellation,
          skiInOut: !!r.skiInOut,
          skiLiftDistanceM,
          score,
          mealPlanSavings: mealPlan.savingsPerNight,
        },
        region
      );
      // Alles-in-1 prijs per persoon: overnachting + ontbijt/diner die je zelf
      // zou moeten regelen als het niet bij de kamer inbegrepen is
      // (€15pp ontbijt, €30pp diner per nacht) + 4-daagse skipas.
      const remainingMealCostPerNight =
        (mealPlan.breakfastIncluded ? 0 : BREAKFAST_COST) + (mealPlan.dinnerIncluded ? 0 : DINNER_COST);
      const totalPpAllIn = Math.round(
        r.perPersonPerNight * data.nights + remainingMealCostPerNight * data.nights + region.skiPass4Day
      );
      listings.push({
        regionSlug: destSlug,
        source,
        region: region.label,
        checkin: data.checkin,
        checkout: data.checkout,
        nights: data.nights,
        weekday,
        weekNr,
        name: r.name,
        totalPrice: r.totalPrice,
        pppn: r.perPersonPerNight,
        totalPpAllIn,
        minAltitude: region.minAltitude,
        maxAltitude: region.maxAltitude,
        distance: r.distance,
        skiLift: r.skiLift,
        skiLiftDistance: r.skiLiftDistance || null,
        skiLiftDistanceM,
        skiInOut: !!r.skiInOut,
        lat: r.lat ?? null,
        lng: r.lng ?? null,
        freeCancellation: r.freeCancellation,
        mealPlan: mealPlan.code,
        mealPlanLabel: mealPlan.label,
        freeParking: !!r.freeParking,
        score,
        scoreWord: word,
        reviews,
        relevance,
        link: r.link,
      });
    }
  }
  if (errors.length) console.error(errors.join('\n'));
  assignStableIds(listings);
  listings.sort((a, b) => b.relevance - a.relevance);
  return listings;
}

// Elke optie krijgt een stabiel volgnummer waarmee je 'm kunt aanwijzen in een
// WhatsApp-poll ("optie #42"). Nummers worden toegekend op een vaste
// alfabetische sorteervolgorde (regio/naam/bron/periode) in plaats van op de
// relevantiescore, zodat ze niet omgooien als de score-weging ooit verandert
// — alleen een nieuwe scrape-run (toevoegen/verwijderen van opties) schuift ze op.
function assignStableIds(listings) {
  const ordered = [...listings].sort(
    (a, b) =>
      a.regionSlug.localeCompare(b.regionSlug) ||
      a.name.localeCompare(b.name) ||
      a.source.localeCompare(b.source) ||
      a.checkin.localeCompare(b.checkin)
  );
  ordered.forEach((r, i) => {
    r.id = i + 1;
  });
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildRegionCards() {
  return Object.values(regionInfo.regions)
    .map(
      (r) => `
    <div class="region-card">
      <h3>${esc(r.label)}</h3>
      <div class="region-stats">
        <div><span class="stat-label">Skigebied</span>${r.slopeKm} km piste</div>
        <div><span class="stat-label">Hoogte</span>${r.minAltitude}&ndash;${r.maxAltitude} m</div>
        <div><span class="stat-label">Rijtijd v. Boxtel</span>${r.driveHours} (${r.driveKm} km)</div>
        <div><span class="stat-label">Skipas 4 dagen</span>~&euro;${r.skiPass4Day} pp</div>
      </div>
      <p class="apres"><strong>Apr&egrave;s-ski:</strong> ${esc(r.apresSki)}</p>
      <div class="pros-cons">
        <div class="pros"><strong>+</strong><ul>${r.pros.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>
        <div class="cons"><strong>&minus;</strong><ul>${r.cons.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>
      </div>
    </div>`
    )
    .join('\n');
}

function main() {
  const listings = collectListings();
  console.error(`Aggregated ${listings.length} listings.`);

  const html = `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ski Holiday 2027 &mdash; Opties</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
<style>
  :root {
    color-scheme: light dark;
    --blue: #1c6fd9;
    --ice: #eaf4ff;
    --good: #1a8a4a;
    --bad: #c23434;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: linear-gradient(180deg, var(--ice), #ffffff);
    color: #16324a;
  }
  header {
    padding: 3rem 1.5rem 2.5rem;
    text-align: center;
    background: linear-gradient(135deg, var(--blue), #0a3d7a);
    color: white;
  }
  header h1 { margin: 0 0 .5rem; font-size: clamp(1.7rem, 4.5vw, 2.6rem); }
  header p { margin: .25rem 0 0; opacity: .9; font-size: 1.05rem; }
  main { max-width: 98vw; margin: -2rem auto 0; padding: 0 1.5rem 3rem; }
  .card {
    background: white;
    border-radius: 16px;
    box-shadow: 0 10px 30px rgba(10, 61, 122, .12);
    padding: 1.75rem;
    margin-bottom: 1.5rem;
  }
  .card h2 { margin-top: 0; color: var(--blue); }
  .card > p.lead { font-size: .95rem; line-height: 1.5; }
  .region-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 1rem;
  }
  .region-card {
    background: var(--ice);
    border-radius: 12px;
    padding: 1.1rem 1.25rem;
  }
  .region-card h3 { margin: 0 0 .6rem; color: #0a3d7a; font-size: 1.05rem; }
  .region-stats { display: flex; flex-direction: column; gap: .25rem; font-size: .88rem; margin-bottom: .6rem; }
  .stat-label { display: inline-block; min-width: 8.5rem; font-weight: 600; color: #3a648c; }
  .apres { font-size: .85rem; margin: .4rem 0; }
  .pros-cons { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; font-size: .82rem; }
  .pros-cons ul { margin: .2rem 0 0; padding-left: 1.1rem; }
  .pros strong { color: var(--good); }
  .cons strong { color: var(--bad); }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: .75rem;
    align-items: center;
    margin-bottom: 1rem;
    font-size: .9rem;
  }
  .filters label { display: flex; flex-direction: column; gap: .25rem; font-weight: 600; color: #3a648c; }
  .filters input, .filters select {
    font: inherit;
    padding: .4rem .6rem;
    border-radius: 8px;
    border: 1px solid #b9d2ea;
    background: white;
    color: inherit;
  }
  .filters .checkbox { flex-direction: row; align-items: center; gap: .4rem; }
  details.ms { position: relative; }
  details.ms > summary {
    list-style: none;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    color: #3a648c;
    padding: .4rem .6rem;
    border-radius: 8px;
    border: 1px solid #b9d2ea;
    background: white;
    white-space: nowrap;
  }
  details.ms > summary::-webkit-details-marker { display: none; }
  details.ms > summary::after { content: ' \\25be'; }
  details.ms[open] > summary::after { content: ' \\25b4'; }
  details.ms > summary::marker { content: ''; }
  .ms-panel {
    position: absolute;
    /* Leaflet's own panes/controls go up to z-index 1000, so this needs to
       clear that comfortably to stay above the map below the filter row. */
    z-index: 5000;
    top: calc(100% + 4px);
    left: 0;
    background: white;
    border: 1px solid #b9d2ea;
    border-radius: 8px;
    padding: .5rem .6rem;
    max-height: 240px;
    overflow-y: auto;
    min-width: 200px;
    box-shadow: 0 8px 20px rgba(10, 61, 122, .18);
  }
  .ms-panel label {
    display: flex;
    align-items: center;
    gap: .45rem;
    font-weight: 400;
    color: inherit;
    padding: .2rem 0;
    white-space: nowrap;
    cursor: pointer;
  }
  .ms-actions {
    display: flex;
    gap: .6rem;
    margin-top: .3rem;
    padding-top: .4rem;
    border-top: 1px solid #e3edf6;
  }
  .ms-actions button {
    font: inherit;
    font-size: .74rem;
    font-weight: 600;
    background: none;
    border: none;
    color: var(--blue);
    cursor: pointer;
    padding: 0;
  }
  #result-count { font-size: .85rem; color: #3a648c; margin-bottom: .5rem; }
  #map { height: 420px; border-radius: 12px; margin-top: .75rem; background: #dde8f2; }
  .leaflet-popup-content { font-size: .85rem; }
  .leaflet-popup-content b { color: #0a3d7a; }
  .table-wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: .78rem; }
  thead th {
    position: sticky;
    top: 0;
    background: var(--blue);
    color: white;
    text-align: left;
    padding: .4rem .45rem;
    cursor: pointer;
    white-space: nowrap;
  }
  thead th:hover { background: #155ab5; }
  tbody td { padding: .35rem .45rem; border-bottom: 1px solid #e3edf6; white-space: nowrap; }
  tbody tr:hover { background: #f3f9ff; }
  .yes { color: var(--good); font-weight: 700; }
  .no { color: var(--bad); }
  .name-cell { white-space: normal; max-width: 180px; }
  .badge {
    display: inline-block;
    font-size: .72rem;
    padding: .1rem .45rem;
    border-radius: 999px;
    background: #dff0ff;
    color: #0a3d7a;
    margin-left: .3rem;
  }
  .price-good { color: var(--good); font-weight: 700; }
  .price-ok { color: #b8860b; font-weight: 700; }
  .price-bad { color: var(--bad); font-weight: 700; }
  .rel-wrap { display: flex; flex-direction: column; gap: .2rem; min-width: 3.5rem; }
  .rel-bar { height: 5px; border-radius: 3px; background: #e3edf6; overflow: hidden; }
  .rel-fill { height: 100%; }
  .price-good-bg { background: var(--good); }
  .price-ok-bg { background: #b8860b; }
  .price-bad-bg { background: var(--bad); }
  a.bk-link { color: var(--blue); text-decoration: none; font-weight: 600; }
  a.bk-link:hover { text-decoration: underline; }
  footer { text-align: center; padding: 2rem; font-size: .85rem; color: #6b859c; }
  .disclaimer { font-size: .78rem; color: #5c7a97; background: #f3f9ff; border-radius: 10px; padding: .8rem 1rem; margin-top: 1rem; }
  .pick { display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .pick-box { width: 1.05rem; height: 1.05rem; cursor: pointer; accent-color: var(--blue); }
  .btn {
    font: inherit;
    font-weight: 600;
    padding: .55rem 1.1rem;
    border-radius: 8px;
    border: none;
    background: var(--blue);
    color: white;
    cursor: pointer;
  }
  .btn:hover { background: #155ab5; }
  .btn.secondary { background: #dff0ff; color: #0a3d7a; }
  .btn.secondary:hover { background: #c8e4ff; }
  #shortlist-name {
    font: inherit;
    padding: .5rem .7rem;
    border-radius: 8px;
    border: 1px solid #b9d2ea;
    background: white;
    color: inherit;
  }
  .shortlist-item {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: .6rem;
    padding: .6rem 0;
    border-bottom: 1px solid #e3edf6;
    font-size: .85rem;
  }
  .shortlist-item:last-child { border-bottom: none; }
  .shortlist-item .sl-info { flex: 1 1 260px; min-width: 220px; }
  .shortlist-item .sl-info b { color: #0a3d7a; }
  .shortlist-comment {
    flex: 1 1 220px;
    font: inherit;
    padding: .4rem .6rem;
    border-radius: 8px;
    border: 1px solid #b9d2ea;
    background: white;
    color: inherit;
  }
  .shortlist-remove {
    background: none;
    border: none;
    color: var(--bad);
    font-size: 1.1rem;
    cursor: pointer;
    line-height: 1;
    padding: .2rem .4rem;
  }
  #shortlist-output {
    width: 100%;
    min-height: 9rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: .8rem;
    border-radius: 8px;
    border: 1px solid #b9d2ea;
    padding: .6rem .75rem;
    color: inherit;
    background: var(--ice);
  }
  #copy-feedback { font-size: .85rem; color: var(--good); font-weight: 600; }
  @media (prefers-color-scheme: dark) {
    body { background: linear-gradient(180deg, #0b1622, #0b1622); color: #dce7f2; }
    .card { background: #142334; box-shadow: none; border: 1px solid #22384f; }
    .region-card { background: #0f2032; }
    .region-card h3 { color: #8fc0f5; }
    .stat-label { color: #6ea3d6; }
    .filters input, .filters select { background: #0f2032; border-color: #22384f; color: #dce7f2; }
    details.ms > summary { background: #0f2032; border-color: #22384f; color: #8fc0f5; }
    .ms-panel { background: #0f2032; border-color: #22384f; box-shadow: none; }
    .ms-actions { border-top: 1px solid #22384f; }
    thead th { background: #0a3d7a; }
    thead th:hover { background: #0e4a94; }
    tbody td { border-bottom: 1px solid #22384f; }
    tbody tr:hover { background: #0f2032; }
    .badge { background: #16324a; color: #8fc0f5; }
    .disclaimer { background: #0f2032; color: #8aa8c4; }
    footer { color: #6b859c; }
    .btn.secondary { background: #16324a; color: #8fc0f5; }
    .btn.secondary:hover { background: #1c3f5e; }
    #shortlist-name, .shortlist-comment, #shortlist-output { background: #0f2032; border-color: #22384f; color: #dce7f2; }
    .shortlist-item { border-bottom: 1px solid #22384f; }
    .shortlist-item .sl-info b { color: #8fc0f5; }
  }
</style>
</head>
<body>
  <header>
    <h1>&#127956; Ski Holiday 2027 &mdash; Opties</h1>
    <p>21 januari &ndash; 4 februari 2027 &middot; 10-14 personen &middot; 4 skidagen &middot; Oostenrijk</p>
  </header>

  <main>
    <div class="card">
      <h2>Over dit overzicht</h2>
      <p class="lead">
        Automatisch verzameld van <strong>Booking.com &eacute;n Airbnb</strong> voor 8 grote Oostenrijkse skigebieden, voor <strong>elke</strong>
        woensdag/donderdag/vrijdag/zaterdag-vertrekweek binnen 21 jan &ndash; 4 feb 2027 (altijd 5 nachten, zo dat er
        minimaal een heel weekend in de reis zit), 12 personen, tot 12 opties per zoekopdracht, gesorteerd op
        relevantie. In totaal <strong id="total-count">&hellip;</strong> gescrapete opties. Gebruik de filters om
        te verkennen.
      </p>
      <div class="disclaimer">
        Let op: dit zijn actuele Booking.com-prijzen op zoekmoment, geen garantie voor later. &ldquo;Gratis
        annuleren&rdquo;, maaltijden (&ldquo;Breakfast included&rdquo; etc.), gratis parkeren en de kaart-locatie
        komen rechtstreeks uit Booking.com's eigen gegevens en zijn betrouwbaar. De kolom &ldquo;Afstand tot
        skilift&rdquo; is best-effort: Booking.com toont die exacte meterafstand alleen op sommige kaarten &mdash;
        een lege cel betekent dus niet per se &ldquo;ver van de piste&rdquo;. Skipas- en rijtijd-cijfers zijn
        schattingen (zie regio-overzicht) &mdash; check exacte route en actuele skipasprijs zelf voor je boekt.
        Sommige resultaten zijn losse kamers/appartementen bij dezelfde accommodatie die Booking.com combineert om
        de groep te huisvesten, niet per se &eacute;&eacute;n aaneengesloten unit.
        <br><br>
        <strong>&ldquo;Totaal pp (verblijf+eten+skipas)&rdquo;</strong> = overnachting + &euro;15pp ontbijt en/of
        &euro;30pp diner per nacht voor de maaltijden die &eacute;&eacute;n niet standaard inbegrepen zijn (wel
        inbegrepen = &euro;0 extra) + een 4-daagse skipas per regio. Dit maakt dure kamers mét halfpension eerlijk
        vergelijkbaar met goedkope kamers zonder eten. <strong>Nog niet meegerekend</strong> voor een echt
        volledige vergelijking: lunch/tussendoortjes op de piste, skimateriaal-huur, eigen vervoer/brandstof/tol,
        reis- en annuleringsverzekering, en toeristenbelasting (die staat soms wel/niet al in de Booking.com-prijs
        &mdash; check dat bij de listing zelf).
        <br><br>
        <strong>Airbnb-kanttekeningen:</strong> reviewscores zijn daar uit 5 en zijn verdubbeld naar dezelfde
        0-10-schaal; maaltijden zijn er nooit inbegrepen (zelf koken kan uiteraard wel, maar voor de eerlijke
        vergelijking rekenen we dezelfde &euro;15/&euro;30 pp); afstand tot de skilift toont Airbnb niet in
        zoekresultaten (telt neutraal mee in de score) en de plaatsnaam in de kolom &ldquo;Centrum&rdquo; is het
        dorp van de listing &mdash; Airbnb zoekt ruim en toont ook omliggende dorpen, check de kaart!
        <br><br>
        <strong>Relevantiescore (0-100)</strong> weegt: prijs 25pt + grootte skigebied 20pt (jullie twee
        hoofdprioriteiten), gratis annuleren 20pt + afstand tot lift 15pt (de harde eisen), hoogte van het
        skigebied 10pt (hoe hoger het gebied, hoe sneeuwzekerder &mdash; gemiddelde van dal- en tophoogte),
        reviewscore 7pt, en apr&egrave;s-ski 3pt (uitdrukkelijk laagste prioriteit).
      </div>
    </div>

    <div class="card">
      <h2>Skigebieden vergeleken</h2>
      <div class="region-grid">
        ${buildRegionCards()}
      </div>
    </div>

    <div class="card">
      <h2>Alle accommodatie-opties</h2>
      <div id="result-count"></div>
      <div class="filters">
        <label>Zoeken
          <input type="text" id="f-search" placeholder="naam accommodatie&hellip;">
        </label>
        <div id="mf-source" class="ms-wrap"></div>
        <div id="mf-region" class="ms-wrap"></div>
        <div id="mf-period" class="ms-wrap"></div>
        <div id="mf-nights" class="ms-wrap"></div>
        <label>Max pp/nacht (&euro;)
          <input type="number" id="f-maxprice" placeholder="bv. 100">
        </label>
        <label>Min. tophoogte (m)
          <input type="number" id="f-minaltitude" placeholder="bv. 2000">
        </label>
        <div id="mf-meal" class="ms-wrap"></div>
        <label>Max. afstand tot skilift (m)
          <input type="number" id="f-maxlift" placeholder="bv. 500">
        </label>
        <label class="checkbox" style="flex-direction:row;">
          <input type="checkbox" id="f-skiinout"> Alleen ski-in/out
        </label>
        <label class="checkbox" style="flex-direction:row;">
          <input type="checkbox" id="f-cancel"> Alleen gratis annuleren
        </label>
      </div>
      <div id="map"></div>
      <div id="map-note" class="disclaimer" style="margin-top:.5rem;">Kaart toont elke unieke accommodatie die voldoet aan de huidige filters (1 pin per pand, ongeacht hoeveel weken matchen). Klik een pin voor details.</div>
      <div class="table-wrap">
        <table id="tbl">
          <thead>
            <tr>
              <th>Kies</th>
              <th data-key="id">#</th>
              <th data-key="relevance">Relevantie</th>
              <th data-key="source">Bron</th>
              <th data-key="region">Regio</th>
              <th data-key="maxAltitude">Hoogte</th>
              <th data-key="checkin">Periode</th>
              <th data-key="weekNr">Week</th>
              <th data-key="nights">Nachten</th>
              <th data-key="name">Accommodatie</th>
              <th data-key="totalPrice">Totaal (groep)</th>
              <th data-key="pppn">Pp/nacht</th>
              <th data-key="totalPpAllIn">Totaal pp (verblijf+eten+skipas)</th>
              <th data-key="distance">Centrum</th>
              <th data-key="skiLiftDistanceM">Afstand tot skilift</th>
              <th data-key="freeCancellation">Gratis annuleren</th>
              <th data-key="mealPlan">Maaltijden</th>
              <th data-key="score">Score</th>
              <th>Link</th>
            </tr>
          </thead>
          <tbody id="tbl-body"></tbody>
        </table>
      </div>
    </div>

    <div class="card" id="shortlist-card">
      <h2>Mijn shortlist</h2>
      <p class="lead">
        Vink in de kolom &ldquo;Kies&rdquo; hierboven de opties aan die jij leuk vindt. Ze verschijnen dan
        hieronder, waar je per optie een opmerking kunt typen. Klik daarna op &ldquo;Genereer tekst&rdquo; om een
        kopieerbaar berichtje te maken voor de groepsapp &mdash; zo kan iedereen zijn eigen shortlist insturen en
        stellen we er samen een top-lijst van samen. Je selectie blijft bewaard in je browser (alleen op dit
        apparaat).
      </p>
      <div id="shortlist-empty" style="font-size:.9rem;color:#5c7a97;">Nog geen opties geselecteerd.</div>
      <div id="shortlist-list"></div>
      <div style="display:flex; gap:.75rem; margin-top:1rem; flex-wrap:wrap; align-items:center;">
        <input type="text" id="shortlist-name" placeholder="Jouw naam (optioneel)">
        <button class="btn" id="btn-generate">Genereer tekst</button>
        <button class="btn secondary" id="btn-copy" style="display:none;">Kopieer</button>
        <button class="btn secondary" id="btn-clear">Wis selectie</button>
        <span id="copy-feedback"></span>
      </div>
      <textarea id="shortlist-output" style="display:none; margin-top:.75rem;" readonly></textarea>
    </div>
  </main>

  <footer>ski-holiday &middot; automatisch verzameld van Booking.com &middot; gedeeld via GitHub Pages</footer>

  <script type="application/json" id="data">${JSON.stringify(listings)}</script>
  <script>
    const listings = JSON.parse(document.getElementById('data').textContent);
    document.getElementById('total-count').textContent = listings.length + ' opties';

    const els = {
      search: document.getElementById('f-search'),
      maxprice: document.getElementById('f-maxprice'),
      minaltitude: document.getElementById('f-minaltitude'),
      maxlift: document.getElementById('f-maxlift'),
      skiinout: document.getElementById('f-skiinout'),
      cancel: document.getElementById('f-cancel'),
      body: document.getElementById('tbl-body'),
      count: document.getElementById('result-count'),
    };

    // Generieke multi-select: een <details>-dropdown met een checkbox per
    // optie, zodat je makkelijk meerdere regio's/periodes/etc. tegelijk kunt
    // aanvinken (in plaats van een standaard <select> waar je ctrl-klik voor
    // nodig hebt). Sluit vanzelf als je ergens anders klikt.
    const openMultiSelects = [];
    function createMultiSelect(containerId, label, options) {
      const container = document.getElementById(containerId);
      const details = document.createElement('details');
      details.className = 'ms';
      const summary = document.createElement('summary');
      details.appendChild(summary);
      const panel = document.createElement('div');
      panel.className = 'ms-panel';
      const boxes = [];
      options.forEach((opt) => {
        const lab = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = opt.value;
        cb.addEventListener('change', () => { updateSummary(); render(); });
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(opt.label));
        panel.appendChild(lab);
        boxes.push(cb);
      });
      const actions = document.createElement('div');
      actions.className = 'ms-actions';
      const allBtn = document.createElement('button');
      allBtn.type = 'button';
      allBtn.textContent = 'Alles';
      allBtn.addEventListener('click', (e) => {
        e.preventDefault();
        boxes.forEach((cb) => { cb.checked = true; });
        updateSummary();
        render();
      });
      const noneBtn = document.createElement('button');
      noneBtn.type = 'button';
      noneBtn.textContent = 'Geen';
      noneBtn.addEventListener('click', (e) => {
        e.preventDefault();
        boxes.forEach((cb) => { cb.checked = false; });
        updateSummary();
        render();
      });
      actions.appendChild(allBtn);
      actions.appendChild(noneBtn);
      panel.appendChild(actions);
      details.appendChild(panel);
      container.appendChild(details);
      openMultiSelects.push(details);

      function updateSummary() {
        const n = boxes.filter((cb) => cb.checked).length;
        summary.textContent = label + (n ? ' (' + n + ')' : '');
      }
      updateSummary();

      return {
        getSelected: () => new Set(boxes.filter((cb) => cb.checked).map((cb) => cb.value)),
      };
    }

    document.addEventListener('click', (e) => {
      openMultiSelects.forEach((d) => {
        if (d.open && !d.contains(e.target)) d.removeAttribute('open');
      });
    });

    let msSource, msRegion, msPeriod, msNights, msMeal;

    // Shortlist: welke opties (per stabiel #id) iemand heeft aangevinkt, met
    // een optionele opmerking erbij. Puur client-side (localStorage) — elke
    // deelnemer maakt zo zijn eigen shortlist op zijn eigen apparaat en kan
    // die als tekst kopiëren om in de groepsapp te plakken.
    const LISTINGS_BY_ID = new Map(listings.map((r) => [r.id, r]));
    const SHORTLIST_KEY = 'ski-holiday-2027-shortlist';
    let shortlist = new Map(); // id -> comment
    try {
      const saved = JSON.parse(localStorage.getItem(SHORTLIST_KEY) || '[]');
      shortlist = new Map(saved.filter(([id]) => LISTINGS_BY_ID.has(id)));
    } catch {}

    function saveShortlist() {
      localStorage.setItem(SHORTLIST_KEY, JSON.stringify(Array.from(shortlist.entries())));
    }

    function renderShortlist() {
      const listEl = document.getElementById('shortlist-list');
      const emptyEl = document.getElementById('shortlist-empty');
      const ids = Array.from(shortlist.keys()).sort((a, b) => a - b);
      emptyEl.style.display = ids.length ? 'none' : '';
      listEl.innerHTML = '';
      const frag = document.createDocumentFragment();
      for (const id of ids) {
        const r = LISTINGS_BY_ID.get(id);
        if (!r) continue;
        const div = document.createElement('div');
        div.className = 'shortlist-item';
        div.innerHTML =
          '<div class="sl-info"><b>#' + id + '</b> ' + r.name + ' &middot; ' + r.region + ' &middot; ' +
          fmtDate(r.checkin) + '&ndash;' + fmtDate(r.checkout) + ' &middot; &euro;' + r.pppn.toFixed(2) + ' pp/nacht &middot; ' +
          '<a class="bk-link" href="' + r.link + '" target="_blank" rel="noopener">bekijk</a></div>' +
          '<input type="text" class="shortlist-comment" data-id="' + id + '" placeholder="opmerking (optioneel)" value="' +
          (shortlist.get(id) || '').replace(/"/g, '&quot;') + '">' +
          '<button class="shortlist-remove" data-id="' + id + '" title="Verwijderen">&times;</button>';
        frag.appendChild(div);
      }
      listEl.appendChild(frag);
      document.getElementById('btn-copy').style.display = 'none';
      document.getElementById('shortlist-output').style.display = 'none';
      document.getElementById('copy-feedback').textContent = '';
    }

    function toggleShortlist(id, on) {
      if (on) { if (!shortlist.has(id)) shortlist.set(id, ''); }
      else { shortlist.delete(id); }
      saveShortlist();
      renderShortlist();
    }

    document.getElementById('tbl-body').addEventListener('change', (e) => {
      if (e.target.classList.contains('pick-box')) {
        toggleShortlist(parseInt(e.target.dataset.id, 10), e.target.checked);
      }
    });

    document.getElementById('shortlist-list').addEventListener('input', (e) => {
      if (e.target.classList.contains('shortlist-comment')) {
        const id = parseInt(e.target.dataset.id, 10);
        if (shortlist.has(id)) { shortlist.set(id, e.target.value); saveShortlist(); }
      }
    });

    document.getElementById('shortlist-list').addEventListener('click', (e) => {
      if (e.target.classList.contains('shortlist-remove')) {
        const id = parseInt(e.target.dataset.id, 10);
        toggleShortlist(id, false);
        const box = document.querySelector('.pick-box[data-id="' + id + '"]');
        if (box) box.checked = false;
      }
    });

    document.getElementById('btn-clear').addEventListener('click', () => {
      if (!shortlist.size) return;
      if (!confirm('Weet je zeker dat je je hele shortlist wilt wissen?')) return;
      shortlist.clear();
      saveShortlist();
      renderShortlist();
      render();
    });

    document.getElementById('btn-generate').addEventListener('click', () => {
      const ids = Array.from(shortlist.keys()).sort((a, b) => a - b);
      const nameEl = document.getElementById('shortlist-name');
      const name = nameEl.value.trim();
      const lines = [];
      lines.push('Ski holiday shortlist' + (name ? ' — ' + name : '') + ' (' + ids.length + ' optie' + (ids.length === 1 ? '' : 's') + '):');
      lines.push('');
      for (const id of ids) {
        const r = LISTINGS_BY_ID.get(id);
        if (!r) continue;
        const comment = (shortlist.get(id) || '').trim();
        lines.push(
          '#' + id + ' ' + r.name + ' (' + r.region + ', ' + fmtDate(r.checkin) + '–' + fmtDate(r.checkout) +
          ', ' + r.nights + 'n, ' + r.source + ') — €' + r.pppn.toFixed(2) + ' pp/nacht'
        );
        if (comment) lines.push('   → ' + comment);
      }
      if (!ids.length) lines.push('(nog geen opties geselecteerd)');
      const output = document.getElementById('shortlist-output');
      output.value = lines.join('\\n');
      output.style.display = '';
      document.getElementById('btn-copy').style.display = '';
      document.getElementById('copy-feedback').textContent = '';
    });

    document.getElementById('btn-copy').addEventListener('click', async () => {
      const output = document.getElementById('shortlist-output');
      const feedback = document.getElementById('copy-feedback');
      try {
        await navigator.clipboard.writeText(output.value);
      } catch {
        output.select();
        document.execCommand('copy');
      }
      feedback.textContent = 'Gekopieerd!';
      setTimeout(() => { feedback.textContent = ''; }, 2500);
    });

    let sortKey = 'relevance';
    let sortDir = -1; // relevance: hoogste eerst

    const months = ['jan','feb','mrt','apr','mei','jun','jul','aug','sep','okt','nov','dec'];
    function fmtDate(d) {
      const [y, m, day] = d.split('-');
      return parseInt(day, 10) + ' ' + months[parseInt(m, 10) - 1];
    }

    function priceClass(pppn) {
      if (pppn <= 100) return 'price-good';
      if (pppn <= 130) return 'price-ok';
      return 'price-bad';
    }

    (function buildMultiSelects() {
      msSource = createMultiSelect('mf-source', 'Bron', [
        { value: 'Booking.com', label: 'Booking.com' },
        { value: 'Airbnb', label: 'Airbnb' },
      ]);

      const regionSeen = new Map();
      for (const r of listings) if (!regionSeen.has(r.regionSlug)) regionSeen.set(r.regionSlug, r.region);
      const regionOpts = Array.from(regionSeen.entries())
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([value, label]) => ({ value, label }));
      msRegion = createMultiSelect('mf-region', 'Regio', regionOpts);

      const weekdayAbbr = { zondag: 'zo', maandag: 'ma', dinsdag: 'di', woensdag: 'wo', donderdag: 'do', vrijdag: 'vr', zaterdag: 'za' };
      const periodSeen = new Map();
      for (const r of listings) if (!periodSeen.has(r.checkin)) periodSeen.set(r.checkin, r);
      const periodOpts = Array.from(periodSeen.values())
        .sort((a, b) => a.checkin.localeCompare(b.checkin))
        .map((r) => ({
          value: r.checkin,
          label: 'wk' + r.weekNr + ' ' + fmtDate(r.checkin) + '–' + fmtDate(r.checkout) + ' (' + weekdayAbbr[r.weekday] + ', ' + r.nights + 'n)',
        }));
      msPeriod = createMultiSelect('mf-period', 'Periode', periodOpts);

      const nightsOpts = Array.from(new Set(listings.map((r) => r.nights)))
        .sort((a, b) => a - b)
        .map((n) => ({ value: String(n), label: n + ' nachten' }));
      msNights = createMultiSelect('mf-nights', 'Nachten', nightsOpts);

      msMeal = createMultiSelect('mf-meal', 'Maaltijden', [
        { value: 'none', label: 'Geen' },
        { value: 'breakfast', label: 'Ontbijt' },
        { value: 'half-board', label: 'Ontbijt & diner' },
        { value: 'all-inclusive', label: 'All-inclusive' },
        { value: 'other', label: 'Anders' },
      ]);
    })();

    function relevanceCell(v) {
      const cls = v >= 70 ? 'price-good' : v >= 50 ? 'price-ok' : 'price-bad';
      return '<div class="rel-wrap"><span class="' + cls + '">' + v.toFixed(0) + '</span>' +
        '<div class="rel-bar"><div class="rel-fill ' + cls + '-bg" style="width:' + Math.min(100, v) + '%"></div></div></div>';
    }

    let map = null;
    let mapMarkers = [];
    if (window.L) {
      map = L.map('map').setView([47.3, 12.0], 8);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(map);
    } else {
      document.getElementById('map').innerHTML =
        '<div style="padding:1rem;font-size:.85rem;color:#5c7a97;">Kaart kon niet laden (geen internetverbinding tot de kaart-tegels).</div>';
    }

    function updateMap(rows) {
      if (!map) return;
      mapMarkers.forEach((m) => map.removeLayer(m));
      mapMarkers = [];
      const seen = new Map();
      for (const r of rows) {
        if (r.lat == null || r.lng == null) continue;
        const key = r.name + '|' + r.lat + '|' + r.lng;
        const existing = seen.get(key);
        if (!existing || r.pppn < existing.pppn) seen.set(key, r);
      }
      const pins = Array.from(seen.values());
      for (const r of pins) {
        const marker = L.marker([r.lat, r.lng]).addTo(map);
        marker.bindPopup(
          '<b>' + r.name + '</b><br>' + r.region + '<br>' +
          'vanaf &euro;' + r.pppn.toFixed(2) + ' pp/nacht<br>' +
          (r.skiLiftDistance ? r.skiLiftDistance + ' van skilift' + (r.skiInOut ? ' (ski-in/out)' : '') + '<br>' : '') +
          (r.freeCancellation ? '&#10003; gratis annuleren<br>' : '') +
          (r.mealPlan !== 'none' ? '&#10003; ' + r.mealPlanLabel + '<br>' : '') +
          '<a href="' + r.link + '" target="_blank" rel="noopener">Bekijk op ' + r.source + ' &rarr;</a>'
        );
        mapMarkers.push(marker);
      }
      if (pins.length) {
        map.fitBounds(pins.map((r) => [r.lat, r.lng]), { padding: [30, 30], maxZoom: 13 });
      }
      document.getElementById('map-note').textContent =
        pins.length + ' unieke accommodaties op de kaart (van ' + rows.length + ' getoonde opties in de tabel). Klik een pin voor details.';
    }

    function render() {
      const q = els.search.value.trim().toLowerCase();
      const sources = msSource.getSelected();
      const regions = msRegion.getSelected();
      const periods = msPeriod.getSelected();
      const nightsSel = msNights.getSelected();
      const meals = msMeal.getSelected();
      const maxprice = parseFloat(els.maxprice.value);
      const minaltitude = parseFloat(els.minaltitude.value);
      const maxlift = parseFloat(els.maxlift.value);
      const skiInOutOnly = els.skiinout.checked;
      const cancelOnly = els.cancel.checked;

      let rows = listings.filter((r) => {
        if (q && !r.name.toLowerCase().includes(q)) return false;
        if (sources.size && !sources.has(r.source)) return false;
        if (regions.size && !regions.has(r.regionSlug)) return false;
        if (periods.size && !periods.has(r.checkin)) return false;
        if (nightsSel.size && !nightsSel.has(String(r.nights))) return false;
        if (!isNaN(maxprice) && r.pppn > maxprice) return false;
        if (!isNaN(minaltitude) && r.maxAltitude < minaltitude) return false;
        if (meals.size && !meals.has(r.mealPlan)) return false;
        if (skiInOutOnly && !r.skiInOut) return false;
        if (!isNaN(maxlift) && !(r.skiInOut || (r.skiLiftDistanceM != null && r.skiLiftDistanceM <= maxlift))) return false;
        if (cancelOnly && !r.freeCancellation) return false;
        return true;
      });

      rows.sort((a, b) => {
        let av = a[sortKey], bv = b[sortKey];
        if (typeof av === 'string') { av = av || ''; bv = bv || ''; return sortDir * av.localeCompare(bv); }
        av = av == null ? -Infinity : av;
        bv = bv == null ? -Infinity : bv;
        return sortDir * (av - bv);
      });

      els.count.textContent = rows.length + ' van ' + listings.length + ' opties getoond';
      updateMap(rows);

      const frag = document.createDocumentFragment();
      for (const r of rows) {
        const tr = document.createElement('tr');
        const checked = shortlist.has(r.id) ? ' checked' : '';
        tr.innerHTML =
          '<td><label class="pick"><input type="checkbox" class="pick-box" data-id="' + r.id + '"' + checked + '></label></td>' +
          '<td>#' + r.id + '</td>' +
          '<td>' + relevanceCell(r.relevance) + '</td>' +
          '<td>' + r.source + '</td>' +
          '<td>' + r.region + '</td>' +
          '<td>' + r.minAltitude + '&ndash;' + r.maxAltitude + 'm</td>' +
          '<td>' + fmtDate(r.checkin) + '&ndash;' + fmtDate(r.checkout) + '<span class="badge">' + r.weekday.slice(0,2) + '</span></td>' +
          '<td>' + r.weekNr + '</td>' +
          '<td>' + r.nights + '</td>' +
          '<td class="name-cell">' + r.name + '</td>' +
          '<td>&euro;' + r.totalPrice.toLocaleString('nl-NL') + '</td>' +
          '<td class="' + priceClass(r.pppn) + '">&euro;' + r.pppn.toFixed(2) + '</td>' +
          '<td>&euro;' + r.totalPpAllIn.toLocaleString('nl-NL') + '</td>' +
          '<td>' + (r.distance || '&ndash;') + '</td>' +
          '<td>' + (r.skiLiftDistance ? r.skiLiftDistance + (r.skiInOut ? ' <span class="badge">ski-in/out</span>' : '') : '&ndash;') + '</td>' +
          '<td class="' + (r.freeCancellation ? 'yes">Ja' : 'no">Nee') + '</td>' +
          '<td>' + r.mealPlanLabel + (r.freeParking ? ' <span class="badge">parkeren</span>' : '') + '</td>' +
          '<td>' + (r.score ? r.score.toFixed(1) + (r.reviews ? ' (' + r.reviews + ')' : '') : '&ndash;') + '</td>' +
          '<td><a class="bk-link" href="' + r.link + '" target="_blank" rel="noopener">Bekijk &rarr;</a></td>';
        frag.appendChild(tr);
      }
      els.body.innerHTML = '';
      els.body.appendChild(frag);
    }

    document.querySelectorAll('#tbl thead th[data-key]').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.key;
        if (sortKey === key) sortDir *= -1; else { sortKey = key; sortDir = 1; }
        render();
      });
    });

    [els.search, els.maxprice, els.minaltitude, els.maxlift, els.skiinout, els.cancel].forEach((el) =>
      el.addEventListener('input', render)
    );

    renderShortlist();
    render();
  </script>
</body>
</html>
`;

  process.stdout.write(html);
}

main();
