#!/usr/bin/env bash
# Switch an instance back to its previous release (or a named one) and restart it.
# Usage: deploy/rollback.sh /srv/crm/client crm-client [release-folder-name]
# Migrations run by the newer release stay applied. Releases only add tables and columns
# (migrations are additive), so the older code keeps working; if a migration broke data,
# restore the backup taken before the release instead (deploy/restore.sh).
set -euo pipefail
DIR="${1:?instance directory}"
UNIT="${2:?systemd unit name}"
PORT="${PORT:-4000}"
CURRENT="$(basename "$(readlink "$DIR/current")")"
if [ -n "${3:-}" ]; then
  TARGET="$3"
else
  TARGET="$(ls -1 "$DIR/releases" | sort -r | awk -v cur="$CURRENT" 'found { print; exit } $0 == cur { found = 1 }')"
fi
[ -n "$TARGET" ] && [ -d "$DIR/releases/$TARGET" ] || { echo "No earlier release to switch to." >&2; exit 1; }
echo "Switching $DIR from $CURRENT to $TARGET"
ln -sfn "$DIR/releases/$TARGET" "$DIR/current.next"
mv -T "$DIR/current.next" "$DIR/current" 2>/dev/null || { rm -f "$DIR/current.next"; ln -sfn "$DIR/releases/$TARGET" "$DIR/current"; }
sudo systemctl restart "$UNIT"
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/api/v1/health/ready" >/dev/null 2>&1 && { echo "Running $TARGET"; exit 0; }
  sleep 1
done
echo "$TARGET did not become healthy: check journalctl -u $UNIT" >&2
exit 1
