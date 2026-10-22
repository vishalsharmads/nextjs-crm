#!/usr/bin/env bash
# Back up one instance: a consistent MySQL dump plus the uploaded files.
# Usage: deploy/backup.sh /srv/crm/client [/var/backups/crm/client]
# Schedule nightly (cron or a systemd timer) and copy BACKUP_DIR off the server.
set -euo pipefail
DIR="${1:?instance directory}"
BACKUP_DIR="${2:-/var/backups/crm/$(basename "$DIR")}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# Read DATABASE_URL and STORAGE_DIR from the instance .env without printing them.
DEFAULTS="$(mktemp)"
trap 'rm -f "$DEFAULTS"' EXIT
ENV_ARGS=()
[ -f "$DIR/.env" ] && ENV_ARGS=(--env-file="$DIR/.env")
IFS=$'\t' read -r DB_NAME STORAGE_PATH < <(node "${ENV_ARGS[@]}" "$(dirname "$0")/instance-env.mjs" "$DEFAULTS" "$DIR")

# --single-transaction: consistent snapshot without locking InnoDB tables. Triggers keep the audit log append-only on restore.
mysqldump --defaults-extra-file="$DEFAULTS" --single-transaction --routines --triggers --set-gtid-purged=OFF \
  "$DB_NAME" | gzip -9 > "$BACKUP_DIR/db-$STAMP.sql.gz"

if [ -d "$STORAGE_PATH" ]; then tar -C "$STORAGE_PATH" -czf "$BACKUP_DIR/files-$STAMP.tar.gz" .; fi

find "$BACKUP_DIR" -name 'db-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name 'files-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
echo "Backup written: $BACKUP_DIR/db-$STAMP.sql.gz"
