#!/usr/bin/env bash
# Build and roll out a release for one instance. Usage: deploy/release.sh /srv/crm/client crm-client
set -euo pipefail
DIR="${1:?instance directory}"
UNIT="${2:?systemd unit name}"
cd "$DIR"
git fetch --tags && git checkout --detach "${RELEASE_REF:-origin/main}"
npm ci
npm run build
npm run doctor
# Always take a backup before changing the schema.
"$(dirname "$0")/backup.sh" "$DIR"
npm run db:migrate
# Re-applying the instance's blueprint is a no-op unless a newer version shipped; it never overwrites client edits.
if [ -n "${BLUEPRINT:-}" ]; then npm run blueprint:apply -- --blueprint="$BLUEPRINT"; fi
sudo systemctl restart "$UNIT"
# Wait until the API and its database answer (up to 30 s).
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:"${PORT:-4000}"/api/v1/health/ready >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:"${PORT:-4000}"/api/v1/health/ready
echo "Released $(git rev-parse --short HEAD) to $DIR"
