#!/usr/bin/env bash
# Back up one instance: a consistent MySQL dump plus the uploaded files.
# Usage: deploy/backup.sh /srv/crm/client [/var/backups/crm/client]
# Schedule nightly (cron or a systemd timer) and copy BACKUP_DIR off the server.
# Set BACKUP_ENCRYPTION_KEY_FILE (a file holding a long random secret, mode 600) to encrypt
# backups (AES-256-CBC, PBKDF2 key derivation). Keep a copy of that key somewhere other than the server.
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
KEY_FILE="${BACKUP_ENCRYPTION_KEY_FILE:-}"
if [ -n "$KEY_FILE" ]; then
  # An empty or missing key would silently produce a backup nobody can (or everybody could) open.
  [ -s "$KEY_FILE" ] || { echo "BACKUP_ENCRYPTION_KEY_FILE is missing or empty: $KEY_FILE" >&2; exit 1; }
  case "$(stat -c %a "$KEY_FILE" 2>/dev/null || stat -f %Lp "$KEY_FILE")" in
    600|400) ;;
    *) echo "Warning: $KEY_FILE should be readable by its owner only (chmod 600)." >&2 ;;
  esac
fi
EXT=""
seal() {
  if [ -n "$KEY_FILE" ]; then
    openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass "file:$KEY_FILE"
  else
    cat
  fi
}
[ -n "$KEY_FILE" ] && EXT=".enc"

mysqldump --defaults-extra-file="$DEFAULTS" --single-transaction --routines --triggers --set-gtid-purged=OFF \
  "$DB_NAME" | gzip -9 | seal > "$BACKUP_DIR/.db-$STAMP.partial"
# Only a complete file gets a backup name (a failed run leaves a .partial to clean up).
mv "$BACKUP_DIR/.db-$STAMP.partial" "$BACKUP_DIR/db-$STAMP.sql.gz$EXT"

if [ -d "$STORAGE_PATH" ]; then
  tar -C "$STORAGE_PATH" -czf - . | seal > "$BACKUP_DIR/.files-$STAMP.partial"
  mv "$BACKUP_DIR/.files-$STAMP.partial" "$BACKUP_DIR/files-$STAMP.tar.gz$EXT"
fi

# Checksums detect a corrupted or truncated copy before you need it.
( cd "$BACKUP_DIR" && sha256sum "db-$STAMP.sql.gz$EXT" $( [ -f "files-$STAMP.tar.gz$EXT" ] && echo "files-$STAMP.tar.gz$EXT" ) > "sha256-$STAMP.txt" )

find "$BACKUP_DIR" \( -name 'db-*.sql.gz*' -o -name 'files-*.tar.gz*' -o -name 'sha256-*.txt' \) -mtime +"$KEEP_DAYS" -delete
echo "Backup written: $BACKUP_DIR/db-$STAMP.sql.gz$EXT"
