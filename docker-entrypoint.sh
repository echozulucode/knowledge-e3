#!/bin/sh
set -e

# --- git auth from a RUNTIME secret (never baked into the image) ---
# GIT_HTTPS_TOKEN authenticates github.com over HTTPS so the git-of-record mirror
# can pull/push private repos. The token lands only in the node user's in-container
# gitconfig, not in any remote URL or image layer.
if [ -n "${GIT_HTTPS_TOKEN:-}" ]; then
  git config --global \
    url."https://x-access-token:${GIT_HTTPS_TOKEN}@github.com/".insteadOf \
    "https://github.com/"
fi
git config --global user.name "${GIT_AUTHOR_NAME:-Knowledge E3}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-knowledge-e3@users.noreply.github.com}"

# --- durable SQLite via Litestream (only when present AND configured) ---
# SQLite stays on the container's LOCAL disk (WAL works there). Litestream restores
# it from Azure Blob on boot, then continuously replicates while the app runs and
# shuts the app down cleanly on exit. Without the account key (e.g. local/self-host),
# the app just runs directly against the local file.
#
# The `command -v` check keeps this script shareable between the open-source
# image (which does not ship the litestream binary) and the cloud image (which
# does): same entrypoint, behaviour driven by what is actually installed and
# configured, rather than two copies that drift.
if [ -n "${LITESTREAM_AZURE_ACCOUNT_KEY:-}" ] && command -v litestream >/dev/null 2>&1; then
  mkdir -p "$(dirname "${DB_URL:-/data/kp.sqlite}")"
  # Restore the DB from the replica if one exists (no-op on a fresh install).
  litestream restore -if-replica-exists "${DB_URL:-/data/kp.sqlite}"
  # Replicate continuously and run the server as the supervised child process.
  exec litestream replicate -exec "node server/dist/main.js"
fi

exec node server/dist/main.js
