#!/usr/bin/env bash
# Batch-run tools/run-booking-search.sh across a set of ski destinations and
# candidate week windows, saving each result set as its own JSON file.
#
# Usage: tools/run-all-searches.sh [output_dir]
# Edit the DESTINATIONS / WEEKS arrays below to change what gets searched.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${1:-$SCRIPT_DIR/playwright/results}"
mkdir -p "$OUT_DIR"

ADULTS=12
MAX=12

# slug|search term
DESTINATIONS=(
  "saalbach|Saalbach, Austria"
  "soll|Soll, Austria"
  "serfaus|Serfaus, Austria"
  "zell-am-see|Zell am See, Austria"
  "ischgl|Ischgl, Austria"
  "st-anton|St. Anton am Arlberg, Austria"
  "soelden|Solden, Austria"
  "mayrhofen|Mayrhofen, Austria"
)

# slug|checkin|checkout  (all 5-night Sat->Thu windows fitting in 2027-01-21..2027-03-02)
WEEKS=(
  "w1-jan23|2027-01-23|2027-01-28"
  "w2-jan30|2027-01-30|2027-02-04"
  "w3-feb06|2027-02-06|2027-02-11"
  "w4-feb13-krokus-zuid|2027-02-13|2027-02-18"
  "w5-feb20-krokus-noord|2027-02-20|2027-02-25"
)

total=$((${#DESTINATIONS[@]} * ${#WEEKS[@]}))
i=0

for dest_entry in "${DESTINATIONS[@]}"; do
  dest_slug="${dest_entry%%|*}"
  dest_term="${dest_entry#*|}"
  for week_entry in "${WEEKS[@]}"; do
    week_slug="${week_entry%%|*}"
    rest="${week_entry#*|}"
    checkin="${rest%%|*}"
    checkout="${rest#*|}"
    i=$((i + 1))
    out_file="$OUT_DIR/${dest_slug}_${week_slug}.json"
    echo "[$i/$total] $dest_term  $checkin -> $checkout  => $out_file" >&2
    if "$SCRIPT_DIR/run-booking-search.sh" "$dest_term" "$checkin" "$checkout" "$ADULTS" price "$MAX" > "$out_file" 2>>"$OUT_DIR/run.log"; then
      echo "  ok ($(python3 -c "import json;print(len(json.load(open('$out_file'))['results']))" 2>/dev/null || echo '?') results)" >&2
    else
      echo "  FAILED, see $OUT_DIR/run.log" >&2
      rm -f "$out_file"
    fi
  done
done

echo "Done. $total searches attempted, output in $OUT_DIR" >&2
