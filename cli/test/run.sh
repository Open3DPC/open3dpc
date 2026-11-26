#!/usr/bin/env bash
# Runs the CLI's tests against this checkout's library: packs it, installs that package and sharp
# into cli/node_modules without touching package.json, then runs the tests.
set -euo pipefail
cli=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
(cd "$cli/.." && npm pack --silent --pack-destination "$work" >/dev/null)
cd "$cli"
npm install --silent --no-save --no-audit --no-fund "$work"/open3dpc-*.tgz "sharp@$(node -p "require('./package.json').dependencies.sharp")"
npm test
