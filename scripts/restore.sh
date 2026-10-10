#!/usr/bin/env bash
# Restore a backup into an EMPTY database and verify ledger integrity.
# Usage: scripts/restore.sh backups/file.dump postgres://user:pw@host/empty_db
set -euo pipefail
dump="${1:?dump file}"; target="${2:?target database url}"
pg_restore --no-owner --exit-on-error --dbname="$target" "$dump"
psql "$target" -v ON_ERROR_STOP=1 -At <<'SQL'
SELECT 'accounts='||count(*) FROM accounts;
SELECT 'ledger_balance_sum='||COALESCE(SUM(balance),0) FROM ledger_accounts;
SELECT 'drifted_accounts='||count(*) FROM ledger_accounts a LEFT JOIN (SELECT account_id, SUM(delta) s FROM ledger_entries GROUP BY account_id) e ON e.account_id=a.id WHERE a.balance <> COALESCE(e.s,0);
SQL
