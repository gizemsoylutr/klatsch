#!/bin/sh
# Run on your own computer, once: copies your relay's server secret to the clipboard, for your password manager,
# without showing it. Without this secret, what people wrote cannot be read again after a restore.
#   sh deploy/save-secret.sh <user@server> [ssh options]
#   KLATSCH_REMOTE_DIR=/somewhere/deploy sh deploy/save-secret.sh ...   (default /opt/klatsch/deploy)
set -eu

fail() { printf '%s\n' "$1" >&2; exit 1; }

[ $# -ge 1 ] || fail 'Usage: sh deploy/save-secret.sh <user@server> [ssh options]'
target=$1
shift

dir=${KLATSCH_REMOTE_DIR:-/opt/klatsch/deploy}
printf '%s' "$dir" | grep -Eq '^/[A-Za-z0-9._/-]+$' || fail 'KLATSCH_REMOTE_DIR is a plain absolute path.'

if command -v pbcopy >/dev/null 2>&1; then copy='pbcopy'
elif command -v wl-copy >/dev/null 2>&1; then copy='wl-copy'
elif command -v xclip >/dev/null 2>&1; then copy='xclip -selection clipboard'
else fail 'No clipboard tool here (pbcopy, wl-copy or xclip). The secret was not fetched.'
fi

# Held in this shell only: on no command line, in no file, on no screen. ssh's own errors still reach the terminal.
secret=$(ssh "$@" "$target" "cd '$dir' && docker compose exec -T klatsch base64 /data/secret") \
  || fail 'Could not read the secret. Check the login above, and KLATSCH_REMOTE_DIR if the stack is elsewhere.'
secret=$(printf '%s' "$secret" | tr -d '\r\n')

# 32 random bytes, or it is not what we came for. Nothing about a wrong answer is printed.
size=$(printf '%s' "$secret" | base64 --decode 2>/dev/null | wc -c | tr -d ' ') || size=0
if [ "$size" != 32 ]; then
  secret=''
  fail 'That did not look like the server secret, so nothing was copied. Check the login above, and KLATSCH_REMOTE_DIR if the stack is elsewhere.'
fi

printf '%s' "$secret" | $copy
secret=''
printf 'The secret is on your clipboard. Paste it into your password manager, as a new item named "Klatsch server secret".\n'
printf 'Do not keep it next to your backups. Press Enter when it is saved, and the clipboard is cleared. '
IFS= read -r _ || true
printf '' | $copy
printf 'Clipboard cleared.\n'
