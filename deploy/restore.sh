#!/usr/bin/env bash
# Restore one instance from a backup made by deploy/backup.sh. Stop the API first.
# Usage: deploy/restore.sh /srv/crm/client /var/backups/crm/client/db-<stamp>.sql.gz [files-<stamp>.tar.gz]
set -euo pipefail
DIR="${1:?instance directory}"
DUMP="${2:?database dump (.sql.gz)}"
FILES="${3:-}"
read -r -p "This replaces the database (and files) of $DIR. Type RESTORE to continue: " OK
[ "$OK" = "RESTORE" ] || { echo "Cancelled."; exit 1; }

DEFAULTS="$(mktemp)"
trap 'rm -f "$DEFAULTS"' EXIT
ENV_ARGS=()
[ -f "$DIR/.env" ] && ENV_ARGS=(--env-file="$DIR/.env")
IFS=$'\t' read -r DB_NAME STORAGE_PATH < <(node "${ENV_ARGS[@]}" "$(dirname "$0")/instance-env.mjs" "$DEFAULTS" "$DIR")

gunzip -c "$DUMP" | mysql --defaults-extra-file="$DEFAULTS" "$DB_NAME"
if [ -n "$FILES" ]; then
    mkdir -p "$STORAGE_PATH"
  tar -C "$STORAGE_PATH" -xzf "$FILES"
fi
echo "Restored $DB_NAME from $DUMP. Start the API and check /api/v1/health/ready."
