// Reusable Airbnb group-accommodation search scraper. Emits the exact same
// JSON shape as search-booking.js so build-html.js can merge both sources
// into one table; airbnb-specific gaps (meal plan, ski-lift distance) are
// emitted as null/false and the top-level `source` field marks the origin.
//
// Usage:
//   node search-airbnb.js --dest "Saalbach, Austria" --checkin 2027-01-30 \
//     --checkout 2027-02-04 --adults 12 [--max 18] [--executable-path ...]
//
// Run headed via Xvfb (same bot-detection story as Booking.com); see
// run-airbnb-search.sh.

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
  const max = parseInt(args.max || '18', 10);
  const executablePath = args['executable-path'] || process.env.CHROME_PATH;

  if (!dest || !checkin || !checkout) {
    console.error('Required: --dest "<place>" --checkin YYYY-MM-DD --checkout YYYY-MM-DD');
    process.exit(1);
  }

  const nights = nightsBetween(checkin, checkout);

  // Airbnb path style: /s/Saalbach--Austria/homes
  const destPath = dest.replace(/,\s*/g, '--').replace(/\s+/g, '-');
  const url = new URL(`https://www.airbnb.com/s/${encodeURIComponent(destPath)}/homes`);
  url.searchParams.set('checkin', checkin);
  url.searchParams.set('checkout', checkout);
  url.searchParams.set('adults', adults);
  url.searchParams.set('currency', 'EUR');

  const browser = await chromium.launch({
    headless: false,
    executablePath,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();

  try {
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('[itemprop="itemListElement"]', { timeout: 30000 });
    // Let lazy-rendered prices/ratings settle.
    await page.waitForTimeout(2500);

    // Coordinates live in the embedded deferred-state JSON, keyed by a
    // base64 DemandStayListing id that decodes to the numeric room id used
    // in the card's /rooms/<id> link.
    const geoByRoomId = await page.evaluate(() => {
      const out = {};
      const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
      for (const s of scripts) {
        if (!s.textContent.includes('DemandStayListing')) continue;
        let data;
        try {
          data = JSON.parse(s.textContent);
        } catch {
          continue;
        }
        (function walk(node) {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) { node.forEach(walk); return; }
          if (node.__typename === 'DemandStayListing' && node.id && node.location?.coordinate) {
            try {
              const decoded = atob(node.id); // "DemandStayListing:123456"
              const roomId = decoded.split(':')[1];
              if (roomId) {
                out[roomId] = {
                  lat: node.location.coordinate.latitude ?? null,
                  lng: node.location.coordinate.longitude ?? null,
                };
              }
            } catch {}
          }
          for (const k in node) walk(node[k]);
        })(data);
      }
      return out;
    });

    const cards = await page.evaluate(
      ({ maxResults, geoByRoomId }) => {
        const els = Array.from(document.querySelectorAll('[itemprop="itemListElement"]')).slice(0, maxResults);
        return els.map((c) => {
          const text = c.innerText || '';
          const name = c.querySelector('meta[itemprop="name"]')?.content?.trim() || null;

          const rawLink = c.querySelector('a')?.href || null;
          let link = rawLink;
          let roomId = null;
          if (rawLink) {
            const m = rawLink.match(/\/rooms\/(\d+)/);
            if (m) {
              roomId = m[1];
              // Keep the date/guest params so the link opens with the right stay.
              const u = new URL(rawLink);
              link = `https://www.airbnb.com/rooms/${roomId}?adults=${u.searchParams.get('adults') || ''}&check_in=${u.searchParams.get('check_in') || ''}&check_out=${u.searchParams.get('check_out') || ''}`;
            }
          }

          // First line reads like "Chalet in Saalfelden am Steinernen Meer, Austria"
          const locMatch = text.match(/^[^\n]*\bin\s+([^\n]+?),\s*Austria/m);
          const distance = locMatch ? locMatch[1].trim() : null;

          const priceMatch = text.match(/€\s?([\d.,]+)\s+total/);
          const priceText = priceMatch ? `€ ${priceMatch[1]}` : null;

          // e.g. "4.93 out of 5 average rating, 14 reviews"
          const ratingMatch = text.match(/([\d.]+)\s+out of 5 average rating,?\s*([\d,]+)\s+reviews?/i);
          const scoreText = ratingMatch ? `${ratingMatch[1]} out of 5 (${ratingMatch[2]} reviews)` : null;

          const freeCancellation = /free cancellation/i.test(text);
          const geo = roomId ? geoByRoomId[roomId] : null;

          return {
            name,
            priceText,
            link,
            distance,
            scoreText,
            freeCancellation,
            skiLift: false,
            skiLiftDistance: null,
            skiInOut: false,
            lat: geo?.lat ?? null,
            lng: geo?.lng ?? null,
            mealPlanText: null,
            freeParking: false,
          };
        });
      },
      { maxResults: max, geoByRoomId }
    );

    const results = cards.map((c) => {
      // Airbnb (EUR, en locale) also uses commas as thousands separators.
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

    console.log(
      JSON.stringify(
        { source: 'airbnb', dest, checkin, checkout, adults, nights, searchUrl: url.toString(), results },
        null,
        2
      )
    );
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
