#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
: "${ISSUE111_SOURCE_ZIP:?Set ISSUE111_SOURCE_ZIP to the authorized original v2 source ZIP}"
: "${ISSUE111_REAL_1930:?Set ISSUE111_REAL_1930 to the first authorized JSON}"
: "${ISSUE111_REAL_2000:?Set ISSUE111_REAL_2000 to the second authorized JSON}"
check_hash() { local actual; actual="$(sha256sum "$1" | cut -d' ' -f1)"; [[ "$actual" == "$2" ]] || { echo "SHA-256 mismatch: $1" >&2; exit 1; }; }
check_hash "$ISSUE111_SOURCE_ZIP" 573149412b240c56245bce2435f2c3bacbccb2fff930193f3b271ba97e6042c3
check_hash "$ISSUE111_REAL_1930" 4df7d24ef20fb3209d48263c1d8e29d5bf3b51ea2c982939b43f2fdb8d2e2799
check_hash "$ISSUE111_REAL_2000" 05e7fce93791ae867271faa876607aaba4d2287809bdb91aedc3e156d6f8b601
check_hash apps/web/test/fixtures/stats-program.json b7fa6b71e917e073eeb01c98f99c9ae66ea7d699245a4911451fb802deeff741
check_hash tests/fixtures/rivalhub-provider-stats-v1-extended.json 72fd89eae31080f16e0ecbd50f0c0ea7b53e7db9377e029f2f59ec1286446e3d
for path in apps/web/__issue111_review* apps/companion/test/issue111-review-*.test.ts; do
  [[ ! -e "$path" ]] || { echo "Refusing to overwrite: $path" >&2; exit 1; }
done
read -r ISSUE111_SOURCE_PORT ISSUE111_WEB_PORT < <(python3 - <<'PY'
import socket
sockets=[socket.socket(),socket.socket()]
for s in sockets: s.bind(('127.0.0.1',0))
print(*(s.getsockname()[1] for s in sockets))
for s in sockets: s.close()
PY
)
export ISSUE111_SOURCE_PORT ISSUE111_WEB_PORT
export ISSUE111_ROOT="$root" ISSUE111_TEMP="$(mktemp -d -t issue111-review-XXXXXXXX)"
export ISSUE111_OUTPUT="${ISSUE111_OUTPUT:-$(mktemp -d -t issue111-output-XXXXXXXX)}"
[[ ! -e "$ISSUE111_OUTPUT/synthetic" && ! -e "$ISSUE111_OUTPUT/real" ]] || { echo "Output already contains review folders: $ISSUE111_OUTPUT" >&2; exit 1; }
mkdir -p "$ISSUE111_OUTPUT"
export ISSUE111_CHROMIUM="${ISSUE111_CHROMIUM:-$(command -v chromium || true)}"
[[ -n "$ISSUE111_CHROMIUM" && -x "$ISSUE111_CHROMIUM" ]] || { echo 'Chromium executable not found' >&2; exit 1; }
if [[ -z "${ISSUE111_PLAYWRIGHT:-}" ]]; then
  ISSUE111_PLAYWRIGHT="$(find "$root/node_modules/.pnpm" -path '*/node_modules/playwright/package.json' -print -quit | xargs -r dirname)"
  export ISSUE111_PLAYWRIGHT
fi
[[ -n "${ISSUE111_PLAYWRIGHT:-}" && -f "$ISSUE111_PLAYWRIGHT/package.json" ]] || { echo 'Playwright package not found; install project dependencies first' >&2; exit 1; }
export PW_TEST_SCREENSHOT_NO_FONTS_READY=1
source_pid='' web_pid=''
cleanup() {
  [[ -z "$source_pid" ]] || kill "$source_pid" 2>/dev/null || true
  [[ -z "$web_pid" ]] || kill "$web_pid" 2>/dev/null || true
  rm -rf "$ISSUE111_TEMP" "$root/apps/web/__issue111_review_assets"
  rm -f "$root"/apps/web/__issue111_review* "$root"/apps/companion/test/issue111-review-*.test.ts
}
trap cleanup EXIT
unzip -q "$ISSUE111_SOURCE_ZIP" -d "$ISSUE111_TEMP/source"
[[ -f "$ISSUE111_TEMP/source/original-site/dist/renderers.mjs" ]] || { echo 'Original renderer missing' >&2; exit 1; }
cp review/issue111/harness.html apps/web/__issue111_review.html
cp review/issue111/harness.tsx apps/web/__issue111_review.tsx
cp review/issue111/project-real.ts apps/companion/test/issue111-review-real.test.ts
cp review/issue111/project-phases.ts apps/companion/test/issue111-review-phases.test.ts
node_modules/.bin/vitest run apps/companion/test/issue111-review-real.test.ts apps/companion/test/issue111-review-phases.test.ts --reporter=dot
python3 review/issue111/cache-assets.py
python3 -m http.server "$ISSUE111_SOURCE_PORT" --bind 127.0.0.1 --directory "$ISSUE111_TEMP/source/original-site/dist" >"$ISSUE111_TEMP/source.log" 2>&1 & source_pid=$!
(cd apps/web && ../../node_modules/.bin/vite --host 127.0.0.1 --port "$ISSUE111_WEB_PORT" --strictPort) >"$ISSUE111_TEMP/web.log" 2>&1 & web_pid=$!
for port in "$ISSUE111_SOURCE_PORT" "$ISSUE111_WEB_PORT"; do
  ready=''
  for attempt in $(seq 1 30); do
    if curl --silent --fail "http://127.0.0.1:$port/" -o /dev/null; then ready=1; break; fi
    sleep 1
  done
  [[ -n "$ready" ]] || { echo "Local server on port $port did not start" >&2; exit 1; }
done
node review/issue111/compare.cjs
node review/issue111/phases.cjs
node review/issue111/real.cjs
python3 - <<'PY'
import json, os, struct
from pathlib import Path
root=Path(os.environ['ISSUE111_OUTPUT'])
for sub, expected in [('synthetic',58),('real',24)]:
    files=list((root/sub).glob('*.png'))
    if len(files)!=expected: raise SystemExit(f'{sub}: expected {expected} screenshots, got {len(files)}')
    for path in files:
        with path.open('rb') as f: header=f.read(24)
        if header[:8]!=b'\x89PNG\r\n\x1a\n' or struct.unpack('>II',header[16:24])!=(1920,1080): raise SystemExit(f'Invalid dimensions: {path}')
    print(f'{sub}: {len(files)} images at 1920×1080')
for name in ['synthetic/results.json','synthetic/phases.json','real/results.json']:
    result=json.loads((root/name).read_text())
    if result.get('errors'): raise SystemExit(f'{name}: browser errors: {result["errors"]}')
real=json.loads((root/'real/results.json').read_text())['result']
print('Real screenshots with unloaded images:',sum(x['loaded']<x['images'] for x in real))
print('Real screenshots with horizontal overflow:',sum(x['bodyWidth']>1920 for x in real))
print('Review output:', root)
PY
