#!/usr/bin/env bash
# Extra coverage on top of run-all-searches.sh: Saturday-4-nights, Sunday-4-nights
# and Sunday-5-nights variants, so both common departure days (Sat/Sun) and both
# trip lengths (4/5 nights) are covered across the whole 2027-01-21..2027-03-02
# window. Saturday-5-nights was already covered by run-all-searches.sh.
#
# Usage: tools/run-all-searches-extra.sh [output_dir]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${1:-$SCRIPT_DIR/playwright/results}"
mkdir -p "$OUT_DIR"

ADULTS=12
MAX=12

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

# slug|checkin|checkout
WEEKS=(
  "w1-jan23-4n|2027-01-23|2027-01-27"
  "w2-jan30-4n|2027-01-30|2027-02-03"
  "w3-feb06-4n|2027-02-06|2027-02-10"
  "w4-feb13-krokus-zuid-4n|2027-02-13|2027-02-17"
  "w5-feb20-krokus-noord-4n|2027-02-20|2027-02-24"
  "w1-jan24-sun-4n|2027-01-24|2027-01-28"
  "w2-jan31-sun-4n|2027-01-31|2027-02-04"
  "w3-feb07-sun-4n|2027-02-07|2027-02-11"
  "w4-feb14-sun-krokus-zuid-4n|2027-02-14|2027-02-18"
  "w5-feb21-sun-krokus-noord-4n|2027-02-21|2027-02-25"
  "w1-jan24-sun-5n|2027-01-24|2027-01-29"
  "w2-jan31-sun-5n|2027-01-31|2027-02-05"
  "w3-feb07-sun-5n|2027-02-07|2027-02-12"
  "w4-feb14-sun-krokus-zuid-5n|2027-02-14|2027-02-19"
  "w5-feb21-sun-krokus-noord-5n|2027-02-21|2027-02-26"
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
    if "$SCRIPT_DIR/run-booking-search.sh" "$dest_term" "$checkin" "$checkout" "$ADULTS" price "$MAX" > "$out_file" 2>>"$OUT_DIR/run-extra.log"; then
      echo "  ok" >&2
    else
      echo "  FAILED, see $OUT_DIR/run-extra.log" >&2
      rm -f "$out_file"
    fi
  done
done

echo "Done. $total searches attempted, output in $OUT_DIR" >&2
