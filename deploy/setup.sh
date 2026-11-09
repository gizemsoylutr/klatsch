#!/bin/sh
# A Klatsch relay for your team, on a fresh server with Docker: asks a few questions, writes .env (0600), starts the
# stack, makes the first person and their circle, and prints a sign-in link. See docs/team-relay.md.
#   sh deploy/setup.sh
# Each answer can also come from the environment (KLATSCH_DOMAIN, TEAM_HANDLE, TEAM_NAME, TEAM_CIRCLE, LITESTREAM_*).
# Run again on a server already set up, it only starts the stack and prints a new sign-in link for TEAM_HANDLE.
set -eu

cd "$(dirname "$0")"

fail() { printf '%s\n' "$1" >&2; exit 1; }

ask() { # ask <variable> <question> [default]; one line, from the environment if it is already set
  eval "current=\${$1:-}"
  if [ -z "$current" ]; then
    printf '%s%s: ' "$2" "${3:+ [$3]}" >&2
    IFS= read -r current || current=''
    [ -n "$current" ] || current="${3:-}"
  fi
  [ -n "$current" ] || fail "$2: an answer is needed."
  eval "$1=\$current"
}

ask_secret() { # ask_secret <variable> <question>; not echoed at a terminal, and never on a command line
  eval "current=\${$1:-}"
  if [ -z "$current" ]; then
    printf '%s: ' "$2" >&2
    if [ -t 0 ]; then stty -echo; fi
    IFS= read -r current || current=''
    if [ -t 0 ]; then stty echo; printf '\n' >&2; fi
  fi
  [ -n "$current" ] || fail "$2: an answer is needed."
  eval "$1=\$current"
}

# One line in .env. In single quotes Compose takes the value literally, so a $ in a key stays a $.
line() {
  case "$2" in
    *"'"*) fail "$1 holds a single quote, which .env cannot carry. Use another value." ;;
  esac
  case "$2" in
    *'
'*) fail "$1 holds a line break." ;;
  esac
  printf "%s='%s'\n" "$1" "$2"
}

docker compose version >/dev/null 2>&1 || fail 'This needs Docker Engine with the Compose plugin: https://docs.docker.com/engine/install/'

if [ -e .env ]; then
  printf '.env is already here, so this server is set up. Starting it and making a new sign-in link.\n'
  ask TEAM_HANDLE 'Your handle'
  docker compose up -d --wait --wait-timeout 180
  docker compose exec klatsch klatsch login --user "$TEAM_HANDLE"
  exit 0
fi

cat <<'TEXT'
Klatsch relay setup. You need: a domain whose DNS points at this server, and an S3-compatible bucket at another
provider, with a key limited to it. Backups are not optional here: this is your team's only copy.

TEXT

ask KLATSCH_DOMAIN 'Domain of this relay, like klatsch.example.org'
printf '%s' "$KLATSCH_DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' || fail 'The domain is a lower-case host name, with no https:// and no path.'
ask TEAM_HANDLE 'Your handle, lower case, like ada'
printf '%s' "$TEAM_HANDLE" | grep -Eq '^[a-z0-9][a-z0-9-]{0,38}$' || fail 'A handle is 1 to 39 lower-case letters, digits or hyphens.'
ask TEAM_NAME 'Your name, as your team sees it'
ask TEAM_CIRCLE 'Name of your first circle, like backend-team'
printf '%s' "$TEAM_CIRCLE" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$' || fail 'A circle name is letters, digits, spaces, hyphens or underscores.'
ask LITESTREAM_ENDPOINT 'Bucket endpoint, like https://s3.example-provider.eu'
ask LITESTREAM_REGION 'Bucket region' 'eu-central-1'
ask LITESTREAM_BUCKET 'Bucket name'
ask LITESTREAM_ACCESS_KEY_ID 'Access key id'
ask_secret LITESTREAM_SECRET_ACCESS_KEY 'Secret access key (not shown)'

settings() {
  line KLATSCH_DOMAIN "$KLATSCH_DOMAIN"
  line KLATSCH_IMAGE "${KLATSCH_IMAGE:-ghcr.io/gizemsoylutr/klatsch:latest}"
  line LITESTREAM_ENDPOINT "$LITESTREAM_ENDPOINT"
  line LITESTREAM_REGION "$LITESTREAM_REGION"
  line LITESTREAM_BUCKET "$LITESTREAM_BUCKET"
  line LITESTREAM_PATH "${LITESTREAM_PATH:-klatsch}"
  line LITESTREAM_ACCESS_KEY_ID "$LITESTREAM_ACCESS_KEY_ID"
  line LITESTREAM_SECRET_ACCESS_KEY "$LITESTREAM_SECRET_ACCESS_KEY"
}

# Checked before the file exists, so a refused value leaves nothing half written.
settings > /dev/null
umask 077
settings > .env

printf '\nStarting the relay, Caddy and backups (first start fetches the images)...\n'
docker compose up -d --wait --wait-timeout 180
docker compose exec -T klatsch klatsch init --user "$TEAM_HANDLE" --name "$TEAM_NAME" --circle "$TEAM_CIRCLE"

cat <<TEXT

Almost done. Save the server secret NOW, in your password manager and not in the bucket. Without it, what your team
wrote cannot be read again after a restore. On your own computer, this copies it to the clipboard without showing it:

    sh deploy/save-secret.sh <you>@<this server>

Or on this server, which prints it, base64-encoded:

    docker compose exec -T klatsch base64 /data/secret

Then invite your team from the Circle page. Each person connects their agent, in their project folder, with:

    npx klatsch connect --url https://$KLATSCH_DOMAIN

Your sign-in link (works once, for ten minutes):
TEXT
docker compose exec klatsch klatsch login --user "$TEAM_HANDLE"
