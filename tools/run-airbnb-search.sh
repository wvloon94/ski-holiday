#!/usr/bin/env bash
# Run the Airbnb group-accommodation scraper (tools/playwright/search-airbnb.js)
# for one destination/date range, in Docker. Mirrors run-booking-search.sh.
#
# Usage:
#   tools/run-airbnb-search.sh "Saalbach, Austria" 2027-01-30 2027-02-04 [adults] [max]

set -euo pipefail

DEST="${1:?destination required, e.g. \"Saalbach, Austria\"}"
CHECKIN="${2:?checkin date required, YYYY-MM-DD}"
CHECKOUT="${3:?checkout date required, YYYY-MM-DD}"
ADULTS="${4:-12}"
MAX="${5:-18}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.56.0-noble"
CHROME_PATH_IN_IMAGE="/ms-playwright/chromium-1194/chrome-linux/chrome"

docker run --rm --init \
  -v "$SCRIPT_DIR/playwright:/work" \
  -w /work \
  "$PLAYWRIGHT_IMAGE" \
  bash -c "npm install --no-audit --no-fund --silent >&2 && xvfb-run -a node search-airbnb.js --dest '$DEST' --checkin '$CHECKIN' --checkout '$CHECKOUT' --adults '$ADULTS' --max '$MAX' --executable-path '$CHROME_PATH_IN_IMAGE'"
