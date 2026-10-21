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
npm run db:migrate
# Re-applying the instance's blueprint is a no-op unless a newer version shipped; it never overwrites client edits.
if [ -n "${BLUEPRINT:-}" ]; then npm run blueprint:apply -- --blueprint="$BLUEPRINT"; fi
sudo systemctl restart "$UNIT"
sleep 2 && curl -fsS http://127.0.0.1:"${PORT:-4000}"/api/v1/health
echo "Released $(git rev-parse --short HEAD) to $DIR"
