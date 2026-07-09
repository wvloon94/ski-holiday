#!/usr/bin/env bash
# Airbnb counterpart of run-all-searches-parallel.sh: the same 8 regions x 21
# valid Wed/Thu/Fri/Sat 5-night departures (168 searches), run N at a time.
# Output files get an `_airbnb` suffix; the JSON itself carries source:"airbnb"
# so build-html.js can tag rows. Resumable: existing non-empty files are skipped.
#
# Usage: tools/run-all-airbnb-parallel.sh [concurrency] [output_dir]

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONCURRENCY="${1:-5}"
OUT_DIR="${2:-$SCRIPT_DIR/playwright/results}"
mkdir -p "$OUT_DIR"

ADULTS=12
MAX=18

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
STATUS_DIR="$(mktemp -d)"
trap 'rm -rf "$STATUS_DIR"' EXIT
i=0

run_one() {
  local dest="$1" checkin="$2" checkout="$3" out_file="$4" id="$5"
  if "$SCRIPT_DIR/run-airbnb-search.sh" "$dest" "$checkin" "$checkout" "$ADULTS" "$MAX" > "$out_file" 2>>"$OUT_DIR/run-airbnb.log"; then
    touch "$STATUS_DIR/$id.ok"
  else
    rm -f "$out_file"
    touch "$STATUS_DIR/$id.fail"
  fi
}

for dest_entry in "${DESTINATIONS[@]}"; do
  dest_slug="${dest_entry%%|*}"
  dest_term="${dest_entry#*|}"
  for week_entry in "${WEEKS[@]}"; do
    week_slug="${week_entry%%|*}"
    rest="${week_entry#*|}"
    checkin="${rest%%|*}"
    checkout="${rest#*|}"
    i=$((i + 1))
    out_file="$OUT_DIR/${dest_slug}_${week_slug}_airbnb.json"

    if [ -s "$out_file" ]; then
      touch "$STATUS_DIR/$i.ok"
      echo "[skip $i/$total, already done] airbnb $dest_term $checkin -> $checkout" >&2
      continue
    fi

    while [ "$(jobs -rp | wc -l)" -ge "$CONCURRENCY" ]; do
      wait -n
    done

    run_one "$dest_term" "$checkin" "$checkout" "$out_file" "$i" &

    done_count=$(find "$STATUS_DIR" -name '*.ok' -o -name '*.fail' 2>/dev/null | wc -l)
    echo "[started $i/$total, $done_count finished] airbnb $dest_term $checkin -> $checkout" >&2
  done
done

wait

ok_count=$(find "$STATUS_DIR" -name '*.ok' | wc -l)
fail_count=$(find "$STATUS_DIR" -name '*.fail' | wc -l)
echo "Done. $ok_count/$total ok, $fail_count failed. Output in $OUT_DIR (see run-airbnb.log for failures)." >&2
