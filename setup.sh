#!/usr/bin/env sh
set -eu
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js is missing. Install Node.js LTS with npm, then run setup again. See README.md.' >&2
  exit 1
fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$script_dir/scripts/setup.mjs"
