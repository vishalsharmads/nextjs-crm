#!/usr/bin/env bash
# Restore one instance from a backup made by deploy/backup.sh. Stop the API first.
# Usage: deploy/restore.sh /srv/crm/client /var/backups/crm/client/db-<stamp>.sql.gz[.enc] [files-<stamp>.tar.gz[.enc]]
# Encrypted backups (.enc) need BACKUP_ENCRYPTION_KEY_FILE pointing at the key they were made with.
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

open_backup() {
  case "$1" in
    *.enc)
      : "${BACKUP_ENCRYPTION_KEY_FILE:?set BACKUP_ENCRYPTION_KEY_FILE to restore an encrypted backup}"
      openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass "file:$BACKUP_ENCRYPTION_KEY_FILE" -in "$1"
      ;;
    *) cat "$1" ;;
  esac
}

open_backup "$DUMP" | gunzip -c | mysql --defaults-extra-file="$DEFAULTS" "$DB_NAME"
if [ -n "$FILES" ]; then
  mkdir -p "$STORAGE_PATH"
  open_backup "$FILES" | tar -C "$STORAGE_PATH" -xzf -
fi
echo "Restored $DB_NAME from $DUMP. Start the API and check /api/v1/health/ready."
