#!/usr/bin/env bash
# Packs the npm package, installs it into an empty project and type-checks two files against it:
# usage.ts must compile, and every line of mistakes.ts must be an error. Needs Node and npx (TypeScript 5).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
(cd "$root" && npm pack --silent --pack-destination "$work" >/dev/null)
mkdir "$work/app" && cd "$work/app"
npm init -y >/dev/null && npm pkg set type=module
npm install --silent --no-audit --no-fund "$work"/open3dpc-*.tgz
cp "$here/usage.ts" "$here/mistakes.ts" .
tsc() { npx -y -p typescript@5 tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 --lib es2022,dom "$@"; }
tsc usage.ts
expected=$(grep -c '^[a-z].*//' mistakes.ts)
found=$(tsc mistakes.ts | grep -c 'error TS' || true)
[ "$found" = "$expected" ] || { echo "mistakes.ts: $found errors, expected $expected"; tsc mistakes.ts || true; exit 1; }
echo "types: usage.ts compiles, all $expected mistakes are caught"
