#!/usr/bin/env bash
# Build and roll out a release for one instance into its own folder, then switch to it.
# Usage: deploy/release.sh /srv/crm/client crm-client
#
# Layout (created by the first run):
#   $DIR/repo/           git clone the releases are taken from
#   $DIR/releases/<utc>-<sha>/   one built release per folder
#   $DIR/current         symlink to the release that runs (systemd WorkingDirectory=$DIR/current/apps/api)
#   $DIR/.env, $DIR/storage      shared by every release
#
# The new release is built and checked before the switch; if it does not become healthy, the
# previous release is put back automatically. deploy/rollback.sh switches back by hand.
# Database migrations are not undone by a switch back: restore the backup taken here if a
# migration itself was the problem (deploy/restore.sh).
set -euo pipefail
DIR="${1:?instance directory}"
UNIT="${2:?systemd unit name}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
PORT="${PORT:-4000}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$DIR/repo"

if [ ! -d "$REPO/.git" ]; then
  if [ -d "$DIR/.git" ]; then
    echo "This instance still uses the in-place layout. Move it once as described in docs/deployment.md (Release folders)." >&2
    exit 1
  fi
  git clone "${REPO_URL:?set REPO_URL for the first release}" "$REPO"
fi

git -C "$REPO" fetch --tags --prune origin
SHA="$(git -C "$REPO" rev-parse "${RELEASE_REF:-origin/main}^{commit}")"
REL="$DIR/releases/$(date -u +%Y%m%dT%H%M%SZ)-${SHA:0:10}"
mkdir -p "$DIR/releases"
mkdir "$REL"
git -C "$REPO" archive "$SHA" | tar -x -C "$REL"
ln -s "$DIR/.env" "$REL/.env"

cd "$REL"
npm ci
npm run build
npm run doctor

# Always take a backup before changing the schema.
"$HERE/backup.sh" "$DIR"
npm run db:migrate
# Re-applying the instance's blueprint is a no-op unless a newer version shipped; it never overwrites client edits.
if [ -n "${BLUEPRINT:-}" ]; then npm run blueprint:apply -- --blueprint="$BLUEPRINT"; fi

PREV="$(readlink "$DIR/current" 2>/dev/null || true)"
switch_to() {
  # Atomic on Linux (GNU mv -T renames the link over the old one); plain ln -sfn elsewhere.
  ln -sfn "$1" "$DIR/current.next"
  mv -T "$DIR/current.next" "$DIR/current" 2>/dev/null || { rm -f "$DIR/current.next"; ln -sfn "$1" "$DIR/current"; }
  sudo systemctl restart "$UNIT"
}
healthy() {
  for _ in $(seq 1 30); do
    curl -fsS "http://127.0.0.1:$PORT/api/v1/health/ready" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

switch_to "$REL"
if ! healthy; then
  echo "Release $SHA did not become healthy." >&2
  if [ -n "$PREV" ]; then
    echo "Switching back to $(basename "$PREV")." >&2
    switch_to "$PREV"
    healthy || echo "The previous release is not healthy either: check journalctl -u $UNIT" >&2
  fi
  exit 1
fi
echo "$SHA" >"$REL/RELEASE"
echo "Released ${SHA:0:10} to $DIR ($(basename "$REL"))"

# Keep the newest releases (and always the running one).
ls -1d "$DIR"/releases/*/ | sort -r | tail -n +"$((KEEP_RELEASES + 1))" | while read -r old; do
  [ "$(cd "$old" && pwd)" = "$(cd "$DIR/current" && pwd -P)" ] || rm -rf "$old"
done
