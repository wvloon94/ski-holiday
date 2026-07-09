#!/usr/bin/env bash
# The definitive full scrape: all 8 ski regions x every valid 5-night departure
# (Wed/Thu/Fri/Sat, the only weekdays whose 6-day span still contains a full
# Sat+Sun weekend) within 2027-01-21..2027-03-02. 8 x 21 = 168 searches.
#
# Usage: tools/run-all-searches-final.sh [output_dir]

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

# slug|checkin|checkout (checkout = checkin + 5 nights)
WEEKS=(
  "wed-20270127|2027-01-27|2027-02-01"
  "wed-20270203|2027-02-03|2027-02-08"
  "wed-20270210|2027-02-10|2027-02-15"
  "wed-20270217|2027-02-17|2027-02-22"
  "wed-20270224|2027-02-24|2027-03-01"
  "thu-20270121|2027-01-21|2027-01-26"
  "thu-20270128|2027-01-28|2027-02-02"
  "thu-20270204|2027-02-04|2027-02-09"
  "thu-20270211|2027-02-11|2027-02-16"
  "thu-20270218|2027-02-18|2027-02-23"
  "thu-20270225|2027-02-25|2027-03-02"
  "fri-20270122|2027-01-22|2027-01-27"
  "fri-20270129|2027-01-29|2027-02-03"
  "fri-20270205|2027-02-05|2027-02-10"
  "fri-20270212|2027-02-12|2027-02-17"
  "fri-20270219|2027-02-19|2027-02-24"
  "sat-20270123|2027-01-23|2027-01-28"
  "sat-20270130|2027-01-30|2027-02-04"
  "sat-20270206|2027-02-06|2027-02-11"
  "sat-20270213|2027-02-13|2027-02-18"
  "sat-20270220|2027-02-20|2027-02-25"
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
    if "$SCRIPT_DIR/run-booking-search.sh" "$dest_term" "$checkin" "$checkout" "$ADULTS" price "$MAX" > "$out_file" 2>>"$OUT_DIR/run-final.log"; then
      echo "  ok" >&2
    else
      echo "  FAILED, see $OUT_DIR/run-final.log" >&2
      rm -f "$out_file"
    fi
  done
done

echo "Done. $total searches attempted, output in $OUT_DIR" >&2
