#!/usr/bin/env bash
# db-query.sh — 1-shot Postgres query with auto-discovered creds.
# Usage:
#   scripts/db-query.sh "SELECT * FROM accounts LIMIT 1"
#   scripts/db-query.sh -d other_db "SELECT 1"           # override DB
#   scripts/db-query.sh -f path/to/file.sql              # run file
#   scripts/db-query.sh -t "SELECT ..."                  # tuples-only (no headers)
#   scripts/db-query.sh -r /path/to/project "SELECT 1"   # use creds from another project root
#
# Credentials resolved by db-creds.sh (from .env / application.yml). See that script for order.

set -u

ROOT="."
SQL=""
SQL_FILE=""
DB_OVERRIDE=""
PSQL_FLAGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    -d) DB_OVERRIDE="$2"; shift 2 ;;
    -f) SQL_FILE="$2"; shift 2 ;;
    -t) PSQL_FLAGS+=(-t); shift ;;
    -r) ROOT="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0" >&2
      exit 0
      ;;
    -*) PSQL_FLAGS+=("$1"); shift ;;
    *) SQL="$1"; shift ;;
  esac
done

if [ -z "$SQL" ] && [ -z "$SQL_FILE" ]; then
  echo "Error: pass SQL string or -f file" >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
eval "$("$HERE/db-creds.sh" "$ROOT")" || { echo "db-creds.sh failed" >&2; exit 2; }

DB="${DB_OVERRIDE:-$PG_DB}"

if [ -n "$SQL_FILE" ]; then
  PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$DB" \
    "${PSQL_FLAGS[@]+"${PSQL_FLAGS[@]}"}" -f "$SQL_FILE"
else
  PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$DB" \
    "${PSQL_FLAGS[@]+"${PSQL_FLAGS[@]}"}" -c "$SQL"
fi
