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

# Check the files against the checksums written at backup time, when they are there.
SUMS="$(dirname "$DUMP")/sha256-$(basename "$DUMP" | sed -E 's/^db-([^.]+)\..*/\1/').txt"
if [ -f "$SUMS" ]; then
  ( cd "$(dirname "$DUMP")" && sha256sum --ignore-missing -c "$(basename "$SUMS")" ) || { echo "Checksum mismatch: not restoring." >&2; exit 1; }
fi
# Decrypt and decompress fully before touching the database, so a damaged file cannot half-restore it.
SQL="$(mktemp)"
trap 'rm -f "$DEFAULTS" "$SQL"' EXIT
open_backup "$DUMP" | gunzip -c > "$SQL"
mysql --defaults-extra-file="$DEFAULTS" "$DB_NAME" < "$SQL"
if [ -n "$FILES" ]; then
  mkdir -p "$STORAGE_PATH"
  open_backup "$FILES" | tar -C "$STORAGE_PATH" -xzf -
fi
echo "Restored $DB_NAME from $DUMP. Start the API and check /api/v1/health/ready."
