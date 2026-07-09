#!/usr/bin/env bash
# Run the Booking.com group-accommodation scraper (tools/playwright/search-booking.js)
# for one destination/date range, in Docker (no host install needed).
#
# Usage:
#   tools/run-booking-search.sh "Flachau, Austria" 2027-01-30 2027-02-04 [adults] [sort] [max]
#
# Examples:
#   tools/run-booking-search.sh "Flachau, Austria" 2027-01-30 2027-02-04
#   tools/run-booking-search.sh "Saalbach, Austria" 2027-02-13 2027-02-18 12 price
#
# Results are printed as JSON on stdout; redirect to a file to save:
#   tools/run-booking-search.sh "Soll, Austria" 2027-01-30 2027-02-04 > /tmp/soll.json
#
# Why Docker + Xvfb: see tools/setup-playwright-mcp.sh. Headless Chromium gets
# fingerprinted and blocked by Booking.com's bot detection; this mirrors the
# same headed-via-Xvfb setup used for the interactive MCP browser.

set -euo pipefail

DEST="${1:?destination required, e.g. \"Flachau, Austria\"}"
CHECKIN="${2:?checkin date required, YYYY-MM-DD}"
CHECKOUT="${3:?checkout date required, YYYY-MM-DD}"
ADULTS="${4:-12}"
SORT="${5:-}"
MAX="${6:-25}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.56.0-noble"
CHROME_PATH_IN_IMAGE="/ms-playwright/chromium-1194/chrome-linux/chrome"

SORT_ARGS=()
if [[ -n "$SORT" ]]; then
  SORT_ARGS=(--sort "$SORT")
fi

docker run --rm --init \
  -v "$SCRIPT_DIR/playwright:/work" \
  -w /work \
  "$PLAYWRIGHT_IMAGE" \
  bash -c "npm install --no-audit --no-fund --silent >&2 && xvfb-run -a node search-booking.js --dest '$DEST' --checkin '$CHECKIN' --checkout '$CHECKOUT' --adults '$ADULTS' --max '$MAX' --executable-path '$CHROME_PATH_IN_IMAGE' ${SORT_ARGS[*]}"
