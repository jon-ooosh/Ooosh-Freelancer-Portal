#!/usr/bin/env bash
# Copy Traccar's H2 database into PostgreSQL (docs/TRACCAR-POSTGRES.md).
#
# The target database must already hold Traccar's own schema — start Traccar
# once against the empty database and stop it again — and must be the SAME
# Traccar version as the H2 copy (same Liquibase changesets). This script then
# empties every tc_* table, streams each H2 table straight into it (through a
# named pipe, so a multi-GB positions table never lands on disk as a CSV),
# resets the id sequences and checks every row count matches.
#
# The H2 database is opened READ-ONLY and is never changed.
#
# Usage (as root on the server):
#   H2_DIR=/root/traccar-data-final IMAGE=ooosh/traccar:6.11.1 \
#     deploy/traccar/h2-to-postgres.sh
#
# Env:
#   H2_DIR    folder holding database.mv.db (a stopped copy)       — required
#   IMAGE     the Traccar image H2's tools are run from             — default ooosh/traccar:6.11.1
#   WORK      scratch folder for the pipes (must be readable by postgres, so NOT under /root)
#   PSQL      how to reach the target as a superuser                — default: sudo -u postgres psql -d traccar
#   LOCAL_LIB testing only: run H2's tools with this Java classpath instead of Docker

set -euo pipefail

H2_DIR=${H2_DIR:?set H2_DIR to the folder holding database.mv.db}
IMAGE=${IMAGE:-ooosh/traccar:6.11.1}
WORK=${WORK:-/var/tmp/traccar-migrate}
PSQL=${PSQL:-sudo -u postgres psql -d traccar}
LOCAL_LIB=${LOCAL_LIB:-}

H2_DIR=$(cd "$H2_DIR" && pwd)
[ -f "$H2_DIR/database.mv.db" ] || { echo "No database.mv.db in $H2_DIR" >&2; exit 1; }

log() { echo "[$(date +%H:%M:%S)] $*"; }

# Run one SQL statement against the H2 copy, read-only.
h2() {
  # LAZY_QUERY_EXECUTION streams rows rather than buffering a whole table to disk.
  local url="jdbc:h2:$H2_DIR/database;ACCESS_MODE_DATA=r;LAZY_QUERY_EXECUTION=TRUE"
  if [ -n "$LOCAL_LIB" ]; then
    java -cp "$LOCAL_LIB/*" org.h2.tools.Shell -url "$url" -user sa -password "" -sql "$1"
  else
    # The image's entrypoint is its own java; H2's tools ship in /opt/traccar/lib.
    docker run --rm -v "$H2_DIR:$H2_DIR" -v "$WORK:$WORK" "$IMAGE" \
      -cp '/opt/traccar/lib/*' org.h2.tools.Shell -url "$url" -user sa -password "" -sql "$1"
  fi
}

psql_q() { $PSQL -v ON_ERROR_STOP=1 -Atq "$@"; }

rm -rf "$WORK"
mkdir -p "$WORK"
chmod 777 "$WORK"

# ── 1. What we are copying ────────────────────────────────────────────────
log "Reading the PostgreSQL schema"
mapfile -t TABLES < <(psql_q -c "SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name LIKE 'tc\_%'
  ORDER BY table_name")
[ "${#TABLES[@]}" -gt 0 ] || { echo "No tc_* tables in the target — start Traccar against it once first" >&2; exit 1; }
log "${#TABLES[@]} tables"

log "Reading the H2 schema"
h2 "CALL CSVWRITE('$WORK/h2cols.csv', 'SELECT LOWER(TABLE_NAME), LOWER(COLUMN_NAME), COLUMN_NAME, DATA_TYPE, TABLE_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ''PUBLIC''', 'writeColumnHeader=false')" >/dev/null

# ── 2. Empty the target (Traccar's first start seeds a row or two) ────────
log "Emptying the target tables"
psql_q -c "TRUNCATE $(IFS=,; echo "${TABLES[*]}") RESTART IDENTITY CASCADE"

# ── 3. Copy table by table ────────────────────────────────────────────────
declare -A COPIED
for t in "${TABLES[@]}"; do
  # Target columns in order, and the matching H2 select list.
  mapfile -t PGCOLS < <(psql_q -c "SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = '$t' ORDER BY ordinal_position")
  select_list=""
  for c in "${PGCOLS[@]}"; do
    line=$(grep -i "^\"$t\",\"$c\"," "$WORK/h2cols.csv" || true)
    if [ -z "$line" ]; then
      echo "Column $t.$c exists in PostgreSQL but not in H2 — different Traccar versions?" >&2
      exit 1
    fi
    h2name=$(echo "$line" | cut -d, -f3 | tr -d '"')
    h2type=$(echo "$line" | cut -d, -f4 | tr -d '"')
    case "$h2type" in
      # PostgreSQL reads bytea as \x + hex.
      *BINARY*|*BLOB*) expr="CASE WHEN \"$h2name\" IS NULL THEN NULL ELSE CONCAT(''\\x'', RAWTOHEX(\"$h2name\")) END" ;;
      *) expr="\"$h2name\"" ;;
    esac
    select_list+="${select_list:+, }$expr"
  done
  cols=$(IFS=,; echo "${PGCOLS[*]}")
  h2table=$(grep -i "^\"$t\"," "$WORK/h2cols.csv" | head -1 | cut -d, -f5 | tr -d '"')

  fifo="$WORK/$t.pipe"
  mkfifo "$fifo"
  chmod 666 "$fifo"

  # Reader: COPY from the pipe. Foreign-key triggers are off for this session
  # (session_replication_role — set inside the session, as sudo drops env vars),
  # so tables can arrive in any order.
  $PSQL -v ON_ERROR_STOP=1 -Atq -c "SET session_replication_role = replica" \
    -c "\\copy $t ($cols) FROM '$fifo' WITH (FORMAT csv)" >"$WORK/$t.copy.log" 2>&1 &
  reader=$!

  # Writer: H2 streams the table into the pipe. NULL is written as an empty
  # unquoted field and every value is quoted, which is exactly PostgreSQL's CSV.
  if ! h2 "CALL CSVWRITE('$fifo', 'SELECT $select_list FROM \"$h2table\"', 'writeColumnHeader=false charset=UTF-8')" >"$WORK/$t.h2.log" 2>&1; then
    # If H2 failed before opening the pipe, the reader is still waiting: let it see end-of-file.
    : >"$fifo" 2>/dev/null || true
    wait "$reader" || true
    echo "H2 export of $t failed:" >&2
    grep -v JAVA_TOOL "$WORK/$t.h2.log" >&2
    exit 1
  fi
  if ! wait "$reader"; then
    echo "PostgreSQL import of $t failed:" >&2
    cat "$WORK/$t.copy.log" >&2
    exit 1
  fi
  rm -f "$fifo"
  COPIED[$t]=1
  log "copied $t"
done

# ── 4. Ids carry on from the highest copied id ────────────────────────────
log "Resetting id sequences"
psql_q <<'SQL'
DO $$
DECLARE r record; seq text; mx bigint;
BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns
            WHERE table_schema = 'public' AND column_name = 'id' AND table_name LIKE 'tc\_%' LOOP
    seq := pg_get_serial_sequence(r.table_name, 'id');
    IF seq IS NOT NULL THEN
      EXECUTE format('SELECT MAX(id) FROM %I', r.table_name) INTO mx;
      IF mx IS NULL THEN
        PERFORM setval(seq, 1, false);
      ELSE
        PERFORM setval(seq, mx, true);
      END IF;
    END IF;
  END LOOP;
END $$;
SQL

# ── 5. Every row count must match ─────────────────────────────────────────
log "Checking row counts"
count_sql=""
for t in "${TABLES[@]}"; do
  h2table=$(grep -i "^\"$t\"," "$WORK/h2cols.csv" | head -1 | cut -d, -f5 | tr -d '"')
  count_sql+="${count_sql:+ UNION ALL }SELECT ''$t'', COUNT(*) FROM \"$h2table\""
done
h2 "CALL CSVWRITE('$WORK/h2counts.csv', '$count_sql', 'writeColumnHeader=false')" >/dev/null

bad=0
while IFS=, read -r t n; do
  t=$(echo "$t" | tr -d '"'); n=$(echo "$n" | tr -d '"')
  pg=$(psql_q -c "SELECT COUNT(*) FROM $t")
  if [ "$pg" != "$n" ]; then
    echo "MISMATCH $t: H2 $n, PostgreSQL $pg" >&2
    bad=1
  elif [ "$n" != "0" ]; then
    printf '  %-26s %s\n' "$t" "$n"
  fi
done <"$WORK/h2counts.csv"

if [ "$bad" = 1 ]; then
  echo "Row counts do NOT match — do not switch Traccar over." >&2
  exit 1
fi
log "All ${#TABLES[@]} tables copied; every row count matches."
