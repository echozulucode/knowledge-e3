#!/bin/sh
set -e

# --- git identity only; credentials are NOT written here (issue 122) ---
# Git transport authenticates per source: a source names the environment
# variable holding its token (`host_token_env`) and the server hands that token
# to the git child process through GIT_ASKPASS, for that one call. GIT_HTTPS_TOKEN
# is still honoured as the instance-wide fallback, by the same path.
#
# This is why there is no `url.…insteadOf` rewrite here any more: it wrote a
# token into the node user's gitconfig for the life of the container (on disk,
# readable by anything running as that user), it covered github.com only, and it
# applied one identity to every source. The per-source path covers all of that,
# including the global token, so the rewrite is redundant as well as unsafe.
git config --global user.name "${GIT_AUTHOR_NAME:-Knowledge E3}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-knowledge-e3@users.noreply.github.com}"

# --- first-run admin bootstrap (turnkey self-host) ---
# A fresh container has no users and authentication cannot be turned off, so
# without this there is a login wall and no account behind it. When
# SEED_ADMIN_PASSWORD is set we idempotently create a single admin (admin only,
# no demo data) before the server starts; it is a no-op once the user exists.
# Non-fatal on error so a transient hiccup never stops the server from booting —
# the failure is visible in the log and the operator can seed by hand.
#
# The `-f` guard keeps this shareable between images: an image that does not
# COPY the script simply skips it, the same way the Litestream branch below
# degrades on its own.
if [ -f /app/scripts/seed-admin.mjs ]; then
  if [ -n "${SEED_ADMIN_PASSWORD:-}" ]; then
    node /app/scripts/seed-admin.mjs || echo "[entrypoint] admin bootstrap failed (continuing)"
  else
    echo "[entrypoint] SEED_ADMIN_PASSWORD is not set — no admin will be created."
    echo "[entrypoint] Set it and restart, or seed by hand:"
    echo "[entrypoint]   docker compose exec -e SEED_ADMIN_PASSWORD=... app node scripts/seed-admin.mjs"
  fi
fi

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
