#!/bin/sh
# Local check of the deploy stack and the restore drill, with Docker only (nothing leaves this machine):
# build the image, start relay + Caddy + Litestream with MinIO as the object storage, create data, wait
# until it is replicated, delete the data volume, restore it with `litestream restore`, start again and
# check that the data (and a token made before, through Caddy) is back.
#   sh scripts/deploy-check.sh
set -eu

cd "$(dirname "$0")/.."
PROJECT=klatsch-check
PORT=${LOCAL_HTTPS_PORT:-8443}
export LOCAL_HTTPS_PORT="$PORT"
C="docker compose -p $PROJECT -f deploy/compose.yml -f deploy/compose.local.yml --env-file deploy/local.env"
WORK=$(mktemp -d)
trap '$C down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

step() { printf '\n== %s\n' "$1"; }
fail() { printf 'FAILED: %s\n' "$1" >&2; exit 1; }
relay() { curl -sk --resolve "klatsch.localhost:$PORT:127.0.0.1" "$@"; }
# Objects in the bucket: files under the bucket directory of the S3 stand-in's volume.
objects() {
  $C run --rm --no-deps -T --entrypoint /bin/sh bucket -c \
    'find "/data/$LITESTREAM_BUCKET" -type f | wc -l' | tr -d ' \r'
}
users() {
  $C exec -T klatsch node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/klatsch.db',{readOnly:true});process.stdout.write(String(db.prepare('SELECT count(*) AS n FROM users WHERE handle = ?').get('drill').n))"
}
mcp_status() {
  relay -o /dev/null -w '%{http_code}' -X POST "https://klatsch.localhost:$PORT/mcp" \
    -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2025-06-18' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
}

# `up --wait` would stop at the one-shot bucket container; wait for the relay through Caddy instead.
start() {
  $C up -d
  i=0
  until [ "$(relay -o /dev/null -w '%{http_code}' "https://klatsch.localhost:$PORT/")" = 200 ]; do
    i=$((i + 1)); [ $i -le 60 ] || fail 'relay not reachable through Caddy'
    sleep 2
  done
}

docker info >/dev/null 2>&1 || fail 'Docker is not running.'

step 'Build the image'
docker build -t klatsch:local .

step 'Start the stack'
$C down -v --remove-orphans >/dev/null 2>&1 || true
start
relay -D - -o /dev/null "https://klatsch.localhost:$PORT/" | grep -qi '^strict-transport-security: max-age=31536000' || fail 'no HSTS header'

step 'Create data'
before=$(objects)
$C exec -T klatsch klatsch init --user drill --name Drill --circle restore-drill
TOKEN=$($C exec -T klatsch klatsch token --user drill | sed -n 's/.*Bearer \(klt_[A-Za-z0-9_-]*\).*/\1/p')
[ -n "$TOKEN" ] || fail 'no token made'
[ "$(mcp_status "$TOKEN")" = 200 ] || fail 'token refused before the drill'
# The server secret is not in the database: keep it apart, as the operator does (docs/self-hosting.md).
$C exec -T klatsch cat /data/secret > "$WORK/secret"

step 'Wait for replication'
i=0
until [ "$(objects)" -gt "$before" ]; do
  i=$((i + 1)); [ $i -le 30 ] || fail 'nothing replicated within 60 seconds'
  sleep 2
done
sleep 5
echo "objects in the bucket: $(objects)"

step 'Lose the server: stop, delete the data volume'
$C stop klatsch litestream caddy
$C rm -f klatsch litestream caddy
docker volume rm "${PROJECT}_data"

step 'Restore'
# The relay image creates the volume, so /data belongs to the relay's user (1000) as on a first start.
$C run --rm --no-deps -T klatsch true
$C run --rm --no-deps -T litestream restore -config /etc/litestream.yml /data/klatsch.db
$C run --rm --no-deps -T klatsch sh -c 'umask 077 && cat > /data/secret' < "$WORK/secret"

step 'Start again and check'
start
[ "$(users)" = 1 ] || fail 'the user is not back'
[ "$(mcp_status "$TOKEN")" = 200 ] || fail 'the token made before the drill no longer works'
echo 'Restore drill passed: data and token are back.'
