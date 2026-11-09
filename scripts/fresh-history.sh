#!/bin/sh
# Starts a fresh public history: a new orphan branch whose single commit is the current tree, signed and
# signed off (DCO) with the author identity from your git config. It changes nothing outside this
# repository: it does not push, and it prints the commands for that.
#
#   scripts/fresh-history.sh [branch]      (default branch name: public-main)
#
# Refuses to run with uncommitted or untracked changes, when the branch already exists, or without
# user.name, user.email and a signing key in your git config.
set -eu

branch="${1:-public-main}"

cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "Uncommitted or untracked changes; commit or remove them first:" >&2
  git status --short >&2
  exit 1
fi
if git show-ref --verify --quiet "refs/heads/$branch"; then
  echo "Branch $branch already exists; delete it or pass another name." >&2
  exit 1
fi
name="$(git config user.name || true)"
email="$(git config user.email || true)"
if [ -z "$name" ] || [ -z "$email" ]; then
  echo "Set user.name and user.email in your git config first." >&2
  exit 1
fi
if [ -z "$(git config user.signingkey || true)" ]; then
  echo "No signing key configured (user.signingkey); the commit must be signed." >&2
  exit 1
fi

from="$(git rev-parse --short HEAD)"
version="$(node -p 'require("./package.json").version')"

# The index still holds HEAD's tree, which is the working tree (checked clean above). If signing fails,
# go back to the branch we came from, so no half-made orphan branch stays checked out.
git checkout --quiet --orphan "$branch"
trap 'git checkout --quiet -f - 2>/dev/null || true' EXIT
git commit --quiet --gpg-sign --signoff -m "Klatsch $version

The first public commit: the tree of $from as one commit."
trap - EXIT

echo "Created $branch: $(git log --oneline -1)"
echo "Author: $name <$email>; signature:"
git log -1 --format='  %G? %GS' "$branch"
cat <<EOF

First keep the whole private history, outside the repository, before anything is replaced:

  git bundle create ../klatsch-private-history.bundle --all

Check the new branch, then replace the private repository's history (it is still private):

  git log --stat $branch | head -40
  git push --force origin $branch:main
  git push origin --delete \$(git ls-remote --heads origin | awk '{print \$2}' | sed 's#refs/heads/##' | grep -vx main)
  git push origin --delete \$(git ls-remote --tags origin | awk '{print \$2}' | sed 's#refs/tags/##' | grep -v '\\^{}\$')

Before making the repository public, on GitHub:

  - Old pull requests keep their commits reachable (refs/pull/*), and they cannot be deleted by a push.
    If the private repository has pull requests, create a new empty repository instead and push only
    $branch to it as main (git push <new remote> $branch:main).
  - Delete old releases and their tags, old workflow runs and their logs, and old packages or image
    versions that were built from the old history.
  - Then switch back: git checkout main && git reset --hard $branch (only after the push succeeded).
EOF
