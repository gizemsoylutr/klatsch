#!/bin/sh
# Runs on the server as the forced command of the deploy key (see docs/self-hosting.md):
#   command="/opt/klatsch/deploy/remote-deploy.sh",restrict ssh-ed25519 AAAA... klatsch-deploy
# Its only input is the image reference the workflow sends: exactly `<repository>@sha256:<64 hex>`,
# one line, nothing else. It points .env at that image, starts it and checks it is what runs.
set -eu

REPO=${KLATSCH_IMAGE_REPO:-ghcr.io/gizemsoylutr/klatsch}
ref=${SSH_ORIGINAL_COMMAND-}

refuse() {
  echo "Refused: $1" >&2
  exit 1
}

# The whole string, not line by line: one [0-9a-f] per digest character, so no newline, space or other
# character can get through, and the length must match exactly.
hex='[0-9a-f]'
digest_pattern=''
i=0
while [ $i -lt 64 ]; do
  digest_pattern="$digest_pattern$hex"
  i=$((i + 1))
done
[ ${#ref} -eq $((${#REPO} + 8 + 64)) ] || refuse 'expected <repository>@sha256:<64 hex digits>.'
# shellcheck disable=SC2254 # the digest pattern is meant to be a glob; the repository is quoted, so literal
case $ref in
  "$REPO@sha256:"$digest_pattern) ;;
  *) refuse 'expected <repository>@sha256:<64 hex digits>.' ;;
esac

cd "$(dirname "$0")"
[ -f .env ] || refuse 'no .env next to this script.'
grep -q '^KLATSCH_IMAGE=' .env || refuse 'no KLATSCH_IMAGE line in .env; add one (see .env.example).'

# Rewrite .env without interpolating the input into a sed program; mktemp makes the file 0600.
next=$(mktemp .env.XXXXXX)
trap 'rm -f "$next"' EXIT
grep -v '^KLATSCH_IMAGE=' .env > "$next" || true
printf 'KLATSCH_IMAGE=%s\n' "$ref" >> "$next"
chmod 600 "$next"
mv "$next" .env
trap - EXIT

docker compose pull --quiet
docker compose up -d --remove-orphans

# What runs must be the image asked for.
container=$(docker compose ps -q klatsch)
[ -n "$container" ] || refuse 'the klatsch container is not running.'
image=$(docker inspect --format '{{.Image}}' "$container")
if ! docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image" | grep -qxF "$ref"; then
  refuse "the running klatsch container is not $ref."
fi
docker image prune -f >/dev/null
echo "Deployed $ref"
