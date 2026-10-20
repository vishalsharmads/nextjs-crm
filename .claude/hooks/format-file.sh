#!/usr/bin/env bash
# PostToolUse: run Prettier on the file Claude just edited. No-op until Prettier is installed.
set -uo pipefail

input="$(cat)"
file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"
[ -z "$file" ] || [ ! -f "$file" ] && exit 0

case "$file" in
  *.ts|*.tsx|*.js|*.mjs|*.cjs|*.json|*.css|*.md|*.yml|*.yaml|*.html) ;;
  *) exit 0 ;;
esac

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
prettier="$root/node_modules/.bin/prettier"
[ -x "$prettier" ] || exit 0

"$prettier" --write --log-level=warn "$file" >/dev/null 2>&1 || true
exit 0
