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
    const weekday = weekdayName(data.checkin);
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
  listings.sort((a, b) => b.relevance - a.relevance);
  return listings;
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

function buildRegionOptions() {
  return Object.entries(regionInfo.regions)
    .map(([slug, r]) => `<option value="${esc(slug)}">${esc(r.label)}</option>`)
    .join('');
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
  @media (prefers-color-scheme: dark) {
    body { background: linear-gradient(180deg, #0b1622, #0b1622); color: #dce7f2; }
    .card { background: #142334; box-shadow: none; border: 1px solid #22384f; }
    .region-card { background: #0f2032; }
    .region-card h3 { color: #8fc0f5; }
    .stat-label { color: #6ea3d6; }
    .filters input, .filters select { background: #0f2032; border-color: #22384f; color: #dce7f2; }
    thead th { background: #0a3d7a; }
    thead th:hover { background: #0e4a94; }
    tbody td { border-bottom: 1px solid #22384f; }
    tbody tr:hover { background: #0f2032; }
    .badge { background: #16324a; color: #8fc0f5; }
    .disclaimer { background: #0f2032; color: #8aa8c4; }
    footer { color: #6b859c; }
  }
</style>
</head>
<body>
  <header>
    <h1>&#127956; Ski Holiday 2027 &mdash; Opties</h1>
    <p>21 januari &ndash; 2 maart 2027 &middot; 10-14 personen &middot; 4 skidagen &middot; Oostenrijk</p>
  </header>

  <main>
    <div class="card">
      <h2>Over dit overzicht</h2>
      <p class="lead">
        Automatisch verzameld van <strong>Booking.com &eacute;n Airbnb</strong> voor 8 grote Oostenrijkse skigebieden, voor <strong>elke</strong>
        woensdag/donderdag/vrijdag/zaterdag-vertrekweek binnen 21 jan &ndash; 2 mrt 2027 (altijd 5 nachten, zo dat er
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
        <label>Bron
          <select id="f-source">
            <option value="">Alle</option>
            <option value="Booking.com">Booking.com</option>
            <option value="Airbnb">Airbnb</option>
          </select>
        </label>
        <label>Regio
          <select id="f-region"><option value="">Alle regio's</option>${buildRegionOptions()}</select>
        </label>
        <label>Periode
          <select id="f-period"><option value="">Alle periodes</option></select>
        </label>
        <label>Nachten
          <select id="f-nights"><option value="">Alle</option><option value="4">4</option><option value="5">5</option></select>
        </label>
        <label>Max pp/nacht (&euro;)
          <input type="number" id="f-maxprice" placeholder="bv. 100">
        </label>
        <label>Min. tophoogte (m)
          <input type="number" id="f-minaltitude" placeholder="bv. 2000">
        </label>
        <label>Maaltijden
          <select id="f-meal">
            <option value="">Alle</option>
            <option value="none">Geen</option>
            <option value="breakfast">Ontbijt</option>
            <option value="half-board">Ontbijt &amp; diner</option>
            <option value="all-inclusive">All-inclusive</option>
          </select>
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
              <th data-key="relevance">Relevantie</th>
              <th data-key="source">Bron</th>
              <th data-key="region">Regio</th>
              <th data-key="maxAltitude">Hoogte</th>
              <th data-key="checkin">Periode</th>
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
  </main>

  <footer>ski-holiday &middot; automatisch verzameld van Booking.com &middot; gedeeld via GitHub Pages</footer>

  <script type="application/json" id="data">${JSON.stringify(listings)}</script>
  <script>
    const listings = JSON.parse(document.getElementById('data').textContent);
    document.getElementById('total-count').textContent = listings.length + ' opties';

    const els = {
      search: document.getElementById('f-search'),
      source: document.getElementById('f-source'),
      region: document.getElementById('f-region'),
      period: document.getElementById('f-period'),
      nights: document.getElementById('f-nights'),
      maxprice: document.getElementById('f-maxprice'),
      minaltitude: document.getElementById('f-minaltitude'),
      meal: document.getElementById('f-meal'),
      cancel: document.getElementById('f-cancel'),
      body: document.getElementById('tbl-body'),
      count: document.getElementById('result-count'),
    };

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

    (function populatePeriodFilter() {
      const weekdayAbbr = { zondag: 'zo', maandag: 'ma', dinsdag: 'di', woensdag: 'wo', donderdag: 'do', vrijdag: 'vr', zaterdag: 'za' };
      const seen = new Map();
      for (const r of listings) {
        if (!seen.has(r.checkin)) seen.set(r.checkin, r);
      }
      const periods = Array.from(seen.values()).sort((a, b) => a.checkin.localeCompare(b.checkin));
      for (const r of periods) {
        const opt = document.createElement('option');
        opt.value = r.checkin;
        opt.textContent = fmtDate(r.checkin) + '–' + fmtDate(r.checkout) + ' (' + weekdayAbbr[r.weekday] + ', ' + r.nights + 'n)';
        els.period.appendChild(opt);
      }
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
      const source = els.source.value;
      const region = els.region.value;
      const period = els.period.value;
      const nights = els.nights.value;
      const maxprice = parseFloat(els.maxprice.value);
      const minaltitude = parseFloat(els.minaltitude.value);
      const meal = els.meal.value;
      const cancelOnly = els.cancel.checked;

      let rows = listings.filter((r) => {
        if (q && !r.name.toLowerCase().includes(q)) return false;
        if (source && r.source !== source) return false;
        if (region && r.regionSlug !== region) return false;
        if (period && r.checkin !== period) return false;
        if (nights && String(r.nights) !== nights) return false;
        if (!isNaN(maxprice) && r.pppn > maxprice) return false;
        if (!isNaN(minaltitude) && r.maxAltitude < minaltitude) return false;
        if (meal && r.mealPlan !== meal) return false;
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
        tr.innerHTML =
          '<td>' + relevanceCell(r.relevance) + '</td>' +
          '<td>' + r.source + '</td>' +
          '<td>' + r.region + '</td>' +
          '<td>' + r.minAltitude + '&ndash;' + r.maxAltitude + 'm</td>' +
          '<td>' + fmtDate(r.checkin) + '&ndash;' + fmtDate(r.checkout) + '<span class="badge">' + r.weekday.slice(0,2) + '</span></td>' +
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

    [els.search, els.source, els.region, els.period, els.nights, els.maxprice, els.minaltitude, els.meal, els.cancel].forEach((el) =>
      el.addEventListener('input', render)
    );

    render();
  </script>
</body>
</html>
`;

  process.stdout.write(html);
}

main();
