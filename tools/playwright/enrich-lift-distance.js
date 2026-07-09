// Fills in the (small) gap left by search-booking.js: Booking.com's search
// result cards only show a "X from ski lift" badge on *some* properties, even
// when the property itself lists nearby ski lifts. This script finds every
// result with a missing skiLiftDistance, visits that property's own page once
// per unique property (deduped), and pulls the nearest lift from the page's
// "Ski lifts" nearby-places section. Mutates the result JSON files in place.
//
// Usage: node enrich-lift-distance.js --executable-path /path/to/chrome

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const RESULTS_DIR = path.join(__dirname, 'results');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[key] = value;
    }
  }
  return args;
}

async function fetchNearestLift(page, link) {
  await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 45000 });
  try {
    await page.getByRole('button', { name: 'Decline' }).click({ timeout: 2000 });
  } catch {}
  await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const extract = () =>
    page.evaluate(() => {
      if (!document.body) return null;
      const text = document.body.innerText || '';
      const idx = text.indexOf('Ski lifts');
      if (idx === -1) return null;
      const chunk = text.slice(idx, idx + 200);
      const m = chunk.match(/Ski lifts\n[^\n]+\n([\d.,]+\s?(?:m|km))/i);
      return m ? m[1].replace(/\s+/g, ' ') : null;
    });

  let result = await extract();
  if (!result) {
    // "Ski lifts" nearby-places widget can be lazy-rendered; nudge it and retry.
    await page.mouse.wheel(0, 2000).catch(() => {});
    await page.waitForTimeout(2000);
    result = await extract();
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const executablePath = args['executable-path'] || process.env.CHROME_PATH;

  const files = fs.readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.json'));
  // pageName -> { distance, checked }
  const cache = new Map();
  // Collect all (file, resultIndex, pageName) needing enrichment
  const jobs = [];
  const fileData = new Map();

  for (const file of files) {
    const full = path.join(RESULTS_DIR, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      continue;
    }
    if (data.source === 'airbnb') continue; // Airbnb pages have no "Ski lifts" section
    fileData.set(file, data);
    data.results.forEach((r, idx) => {
      if (!r.skiLiftDistance && r.link) {
        const m = r.link.match(/\/hotel\/[a-z]{2}\/([^./?]+)/i);
        const pageName = m ? m[1] : null;
        if (pageName) jobs.push({ file, idx, pageName, link: r.link });
      }
    });
  }

  const uniquePageNames = [...new Set(jobs.map((j) => j.pageName))];
  console.error(`${jobs.length} results missing lift distance, ${uniquePageNames.length} unique properties to visit.`);

  const browser = await chromium.launch({ headless: false, executablePath, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  let done = 0;
  for (const pageName of uniquePageNames) {
    const job = jobs.find((j) => j.pageName === pageName);
    try {
      const distance = await fetchNearestLift(page, job.link);
      cache.set(pageName, distance);
      done++;
      console.error(`[${done}/${uniquePageNames.length}] ${pageName} -> ${distance || 'geen "Ski lifts" sectie gevonden'}`);
    } catch (e) {
      cache.set(pageName, null);
      console.error(`[${done}/${uniquePageNames.length}] ${pageName} -> FOUT: ${e.message}`);
    }
  }
  await browser.close();

  // Apply results back to in-memory file data and write out.
  let updated = 0;
  for (const job of jobs) {
    const distance = cache.get(job.pageName);
    if (distance) {
      fileData.get(job.file).results[job.idx].skiLiftDistance = distance;
      fileData.get(job.file).results[job.idx].skiLiftDistanceSource = 'property-page';
      updated++;
    }
  }
  for (const [file, data] of fileData) {
    fs.writeFileSync(path.join(RESULTS_DIR, file), JSON.stringify(data, null, 2));
  }
  console.error(`Done. Filled in ${updated}/${jobs.length} missing lift distances.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
