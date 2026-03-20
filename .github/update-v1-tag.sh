#!/usr/bin/env bash

set -euo pipefail

remote="${1:-origin}"

latest_v1_tag="$(git tag --list 'v1.*' --sort=-v:refname | head -n 1)"

if [ -z "$latest_v1_tag" ]; then
  echo "No v1.x.x tag found."
  exit 1
fi

target_sha="$(git rev-list -n 1 "$latest_v1_tag")"
current_sha="$(git rev-parse -q --verify refs/tags/v1^{commit} || true)"

if [ "$current_sha" = "$target_sha" ]; then
  echo "v1 already points to $latest_v1_tag ($target_sha)."
  exit 0
fi

git fetch --tags "$remote"
git tag -f v1 "$target_sha"
git push --force "$remote" refs/tags/v1

echo "Updated v1 to point to $latest_v1_tag ($target_sha)."
