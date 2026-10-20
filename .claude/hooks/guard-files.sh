#!/usr/bin/env bash
# PreToolUse guard for Edit/Write/MultiEdit.
# Blocks: real .env files (secrets), and migration files already committed to git (fix forward instead).
set -euo pipefail

input="$(cat)"
file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"
[ -z "$file" ] && exit 0

base="$(basename "$file")"

case "$base" in
  .env.example) ;;
  .env|.env.*)
    echo "Blocked: $base holds secrets. Edit .env.example and document the variable in docs/env-reference.md instead." >&2
    exit 2
    ;;
esac

if [[ "$file" == */migrations/* ]] && [ -f "$file" ]; then
  root="$(git -C "$(dirname "$file")" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$root" ]; then
    rel="${file#"$root"/}"
    if git -C "$root" cat-file -e "HEAD:$rel" 2>/dev/null; then
      echo "Blocked: $rel is a committed migration and migrations are immutable. Create a new migration to fix forward." >&2
      exit 2
    fi
  fi
fi

exit 0
