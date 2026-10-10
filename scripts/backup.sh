#!/usr/bin/env bash
# Logical backup of the MVW database. Usage: DATABASE_URL=postgres://... scripts/backup.sh [outfile]
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"
out="${1:-backups/mvw-$(date -u +%Y%m%dT%H%M%SZ).dump}"
mkdir -p "$(dirname "$out")"
pg_dump --format=custom --no-owner --file="$out" "$DATABASE_URL"
echo "backup written: $out"
