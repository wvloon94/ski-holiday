#!/usr/bin/env bash
# Reproducible setup for the Playwright MCP server used to scrape Booking.com/Airbnb.
#
# Why Docker: this sandbox has no passwordless sudo, so `playwright install-deps`
# (needed for system Chrome/Chromium shared libs like libnss3, libasound2, etc.)
# can't run. The official Microsoft Playwright image ships Node + browsers +
# all system deps preinstalled, so we run the MCP server (stdio transport)
# inside a throwaway container instead of installing anything on the host.
#
# Usage: ./setup-playwright-mcp.sh
# After running, restart the Claude Code session so the new MCP tools load.

set -euo pipefail

PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.56.0-noble"
# The image ships a prebuilt Chromium (not "Google Chrome"), and the MCP
# server's default --browser=chrome channel only looks for real Chrome.
# Point it at the bundled Chromium binary directly to skip channel resolution.
CHROME_PATH_IN_IMAGE="/ms-playwright/chromium-1194/chrome-linux/chrome"

claude mcp remove playwright 2>/dev/null || true

# Booking.com's bot detection (Akamai/PerimeterX-style) appears to fingerprint
# headless Chromium and serves a degraded static "city page" instead of real
# search results. Running headed (via Xvfb, which the image ships) avoids
# that fingerprint at the cost of a virtual display inside the container.
claude mcp add playwright -- docker run -i --rm --init \
  "$PLAYWRIGHT_IMAGE" \
  xvfb-run -a npx -y @playwright/mcp@latest --isolated --no-sandbox \
  --executable-path "$CHROME_PATH_IN_IMAGE"

echo "Done. Restart the Claude Code session to load the playwright MCP tools."
