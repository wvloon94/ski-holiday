// Reusable Booking.com group-accommodation search scraper.
//
// Usage:
//   node search-booking.js --dest "Flachau, Austria" --checkin 2027-01-30 \
//     --checkout 2027-02-04 --adults 12 [--sort price] [--max 25] [--out results.json]
//
// Must run in a *headed* browser (headless Chromium gets fingerprinted by
// Booking.com's bot detection and served a static fallback page instead of
// real results). Run this through Xvfb, e.g. via run-booking-search.sh.
//
// dest can be a plain place name ("Saalbach, Austria") — Booking.com resolves
// it server-side. No need to look up a dest_id first.

const { chromium } = require('playwright-core');

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

function nightsBetween(checkin, checkout) {
  const a = new Date(checkin);
  const b = new Date(checkout);
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dest = args.dest;
  const checkin = args.checkin;
  const checkout = args.checkout;
  const adults = args.adults || '12';
  const sort = args.sort; // e.g. "price"
  const max = parseInt(args.max || '25', 10);
  const currency = args.currency || 'EUR';
  const executablePath = args['executable-path'] || process.env.CHROME_PATH;

  if (!dest || !checkin || !checkout) {
    console.error('Required: --dest "<place>" --checkin YYYY-MM-DD --checkout YYYY-MM-DD');
    process.exit(1);
  }

  const nights = nightsBetween(checkin, checkout);

  const url = new URL('https://www.booking.com/searchresults.html');
  url.searchParams.set('ss', dest);
  url.searchParams.set('checkin', checkin);
  url.searchParams.set('checkout', checkout);
  url.searchParams.set('group_adults', adults);
  url.searchParams.set('no_rooms', '1');
  url.searchParams.set('group_children', '0');
  url.searchParams.set('selected_currency', currency);
  if (sort) url.searchParams.set('order', sort);

  const browser = await chromium.launch({
    headless: false,
    executablePath,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();

  try {
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Best-effort cookie banner dismissal; harmless no-op if absent.
    try {
      await page.getByRole('button', { name: 'Decline' }).click({ timeout: 3000 });
    } catch {}

    await page.waitForSelector('[data-testid="property-card"]', { timeout: 30000 });
    // Let lazy-loaded price/review widgets settle.
    await page.waitForTimeout(1500);

    // Booking.com embeds a full Apollo/GraphQL JSON cache (application/json
    // <script>) with per-property location + badge data that's far more
    // reliable than sniffing the rendered card text (e.g. the "ski lift"
    // distance badge only renders on some cards, but showSkiToDoor and
    // lat/lng are always present here, keyed by the hotel's URL slug).
    const geoByPageName = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
      const candidate = scripts.find((s) => s.textContent.includes('BasicPropertyData'));
      if (!candidate) return {};
      let data;
      try {
        data = JSON.parse(candidate.textContent);
      } catch {
        return {};
      }
      const out = {};
      function walk(node, parent) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach((n) => walk(n, parent));
          return;
        }
        if (node.__typename === 'BasicPropertyData' && node.pageName && parent) {
          const badges = parent.propertyUspBadges || [];
          out[node.pageName] = {
            lat: node.location?.latitude ?? null,
            lng: node.location?.longitude ?? null,
            skiToDoor: parent.customBadges?.showSkiToDoor ?? null,
            freeCancellation: parent.policies?.showFreeCancellation ?? null,
            mealPlanText: parent.mealPlanIncluded?.text ?? null,
            freeParking: badges.some((b) => b.name === 'parking'),
          };
        }
        for (const k in node) walk(node[k], node);
      }
      walk(data, null);
      return out;
    });

    const cards = await page.evaluate(
      ({ maxResults, geoByPageName }) => {
        const els = Array.from(document.querySelectorAll('[data-testid="property-card"]')).slice(0, maxResults);
        return els.map((c) => {
          const name = c.querySelector('[data-testid="title"]')?.innerText?.trim() || null;
          const priceText = c.querySelector('[data-testid="price-and-discounted-price"]')?.innerText?.trim() || null;
          const link = c.querySelector('a[data-testid="title-link"]')?.href || null;
          const distance = c.querySelector('[data-testid="distance"]')?.innerText?.trim() || null;
          const scoreText = c.querySelector('[data-testid="review-score"]')?.innerText?.trim() || null;
          const freeCancellationText = c.innerText.includes('Free cancellation');
          const liftMatch = c.innerText.match(/([\d.,]+\s?(?:m|km))\s+from ski lift/i);
          const skiLiftDistance = liftMatch ? liftMatch[1].replace(/\s+/g, ' ') : null;
          const skiLift = !!skiLiftDistance;
          const skiInOutText = /Ski-in,\s*ski-out access/i.test(c.innerText);

          let pageName = null;
          if (link) {
            const m = link.match(/\/hotel\/[a-z]{2}\/([^./?]+)/i);
            pageName = m ? m[1] : null;
          }
          const geo = pageName ? geoByPageName[pageName] : null;

          return {
            name,
            priceText,
            link,
            distance,
            scoreText,
            freeCancellation: geo?.freeCancellation ?? freeCancellationText,
            skiLift,
            skiLiftDistance,
            // showSkiToDoor (Booking.com's own reliable flag) takes priority;
            // fall back to the "Ski-in, ski-out access" text badge if absent.
            skiInOut: geo?.skiToDoor ?? skiInOutText,
            lat: geo?.lat ?? null,
            lng: geo?.lng ?? null,
            mealPlanText: geo?.mealPlanText ?? null,
            freeParking: geo?.freeParking ?? false,
          };
        });
      },
      { maxResults: max, geoByPageName }
    );

    const results = cards.map((c) => {
      // Booking.com (en-us locale) formats whole-euro prices as "€ 7,006" —
      // comma is a thousands separator here, not a decimal point.
      const priceNum = c.priceText ? parseInt(c.priceText.replace(/[^\d]/g, ''), 10) : null;
      const perPersonPerNight = priceNum ? Math.round((priceNum / nights / parseInt(adults, 10)) * 100) / 100 : null;
      return {
        ...c,
        totalPrice: priceNum,
        nights,
        adults: parseInt(adults, 10),
        perPersonPerNight,
      };
    });

    console.log(JSON.stringify({ dest, checkin, checkout, adults, nights, searchUrl: url.toString(), results }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
