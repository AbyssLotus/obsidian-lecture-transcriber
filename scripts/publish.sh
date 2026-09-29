#!/bin/bash
# Rewrites this repo's commits to a GitHub noreply author, then creates the
# public repo and pushes. Requires `gh auth login` to have been run first.
set -euo pipefail
cd "$(dirname "$0")/.."

gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' first."; exit 1; }

LOGIN=$(gh api user --jq .login)
UID_=$(gh api user --jq .id)
NOREPLY="${UID_}+${LOGIN}@users.noreply.github.com"
echo "Publishing as ${LOGIN} <${NOREPLY}>"

git config user.name  "$LOGIN"
git config user.email "$NOREPLY"

# Rewrite author and committer on every commit so the real address never ships.
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --env-filter "
export GIT_AUTHOR_NAME='$LOGIN'
export GIT_AUTHOR_EMAIL='$NOREPLY'
export GIT_COMMITTER_NAME='$LOGIN'
export GIT_COMMITTER_EMAIL='$NOREPLY'
" -- --all >/dev/null
rm -rf .git/refs/original

echo "--- authors now ---"
git log --format='%an <%ae>' | sort -u

REPO="obsidian-lecture-transcriber"
if gh repo view "$LOGIN/$REPO" >/dev/null 2>&1; then
  echo "Repo already exists; pushing to it."
  git remote remove origin 2>/dev/null || true
  git remote add origin "https://github.com/$LOGIN/$REPO.git"
  git branch -M main
  git push -u origin main --force-with-lease 2>/dev/null || git push -u origin main
else
  git branch -M main
  gh repo create "$REPO" --public --source=. --remote=origin \
    --description "Transcribe and summarise lecture recordings locally in Obsidian. Offline, no API keys." \
    --push
fi

# Point the README's BRAT line at the real account.
if grep -q 'tripphinch/obsidian-lecture-transcriber' README.md && [ "$LOGIN" != "tripphinch" ]; then
  sed -i '' "s|tripphinch/obsidian-lecture-transcriber|$LOGIN/$REPO|g" README.md
  git add README.md && git commit -q -m "Point BRAT instructions at $LOGIN/$REPO" && git push
fi

echo
echo "Pushed: https://github.com/$LOGIN/$REPO"
echo "Next, to make BRAT installs work, tag a release:"
echo "  git tag 2.0.0 && git push origin 2.0.0"
