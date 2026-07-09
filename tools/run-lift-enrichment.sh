#!/usr/bin/env bash
# Fill in missing ski-lift distances (tools/playwright/enrich-lift-distance.js)
# by visiting each affected property's own Booking.com page once. Run this
# AFTER a batch of run-booking-search.sh / run-all-searches*.sh calls.
#
# Usage: tools/run-lift-enrichment.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.56.0-noble"
CHROME_PATH_IN_IMAGE="/ms-playwright/chromium-1194/chrome-linux/chrome"

docker run --rm --init \
  -v "$SCRIPT_DIR/playwright:/work" \
  -w /work \
  "$PLAYWRIGHT_IMAGE" \
  bash -c "npm install --no-audit --no-fund --silent >&2 && xvfb-run -a node enrich-lift-distance.js --executable-path '$CHROME_PATH_IN_IMAGE'"
