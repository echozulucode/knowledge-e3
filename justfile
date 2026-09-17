# Knowledge E3 — task runner.
#
# `just` is a convenience over the pnpm scripts, not a replacement for them:
# every recipe here shells out to the same script CI and the docs already name,
# so there is one definition of each task and nothing to keep in step.
#
# What earns this file its place is the handful of recipes that encode operational
# knowledge which is otherwise only in someone's head or in our lessons log —
# the order the gate runs in, the cache that has to be cleared before the e2e
# suite, and the fact that a backup and a drill are two commands. Those are
# commented with WHY, because the next person to read this file will be deciding
# whether they can skip a step.
#
# Install: https://github.com/casey/just  ·  `winget install --id Casey.Just`

# On Linux and macOS, `sh`. On Windows, PowerShell — NOT bash, because `bash` on a
# machine with WSL installed resolves to WSL's bash, which runs the Windows npm
# shim under Linux and fails with `exec: node: not found`. Every recipe below is
# therefore written to run identically under both: no shell builtins, no `rm -rf`,
# no pipelines. Anything needing real logic lives in a script file.
set shell := ["sh", "-uc"]
set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

# Show the available recipes.
default:
    @just --list --unsorted

# ---------------------------------------------------------------- setup

# Install workspace dependencies exactly as the lockfile says (what CI does).
install:
    pnpm install --frozen-lockfile

# Install the Playwright browser. Needed once per machine before `just e2e`.
e2e-install:
    pnpm --filter @echozedlabs/web test:e2e:install

# ---------------------------------------------------------------- develop

# Both dev servers at once: API on :3000, web on :5173 proxying to it.
#
# `pnpm --parallel` rather than backgrounding two shells, because pnpm supervises
# them: output is prefixed per package, and one Ctrl-C stops both instead of
# leaving an orphaned API holding port 3000. Only `server` and `web` define a
# `dev` script, so `-r` selects exactly those two.
#
# These are the DEV ports and they do not collide with the e2e gate, which runs
# its own API on 3001 and web on 5174 — so `just e2e` in another terminal will not
# fight this. The API here runs under a file watcher, which is right for a dev
# loop and deliberately wrong for the gate (see `e2e`).
#
# Empty instance? `just seed` first, then sign in as admin.

# Run both dev servers: API on :3000, web on :5173.
dev:
    pnpm -r --parallel dev

# API on :3000 with a file watcher. NOT what the e2e gate uses — see `e2e`.
dev-server:
    pnpm --filter @echozedlabs/server dev

# Web on :5173, proxying the API.
dev-web:
    pnpm --filter @echozedlabs/web dev

# ---------------------------------------------------------------- verify

typecheck:
    pnpm -r typecheck

build:
    pnpm -r build

# NUL-byte guard first (issue 25), then every package's own lint.
lint:
    node scripts/check-nul-bytes.mjs
    pnpm -r lint

# Unit and integration tests across every package.
test:
    pnpm -r test

# One package's tests, e.g. `just test-one server` or `just test-one search`.
test-one pkg:
    pnpm --filter @echozedlabs/{{pkg}} test

# Server tests matching a name, e.g. `just test-server publish-lint-gate`.
test-server pattern:
    pnpm --filter @echozedlabs/server test -- {{pattern}}

# The browser suite, minus anything tagged @quarantine.
#
# The `rm -rf` is load-bearing, not hygiene (lesson 66). Vite does not
# re-optimize a workspace package when its CONTENT changes — only when the
# dependency graph does — so after any edit under packages/** the suite will
# happily test the PREVIOUS build of that package. It has cost this project two
# separate afternoons: once a stale @echozedlabs/ui bundle failed every UI spec
# with "does not provide an export named X", and once it rendered the old
# component beside the new copy and failed 66 tests.
#
# The gate starts the API with `dev:nowatch` and waits on /readyz, deliberately:
# the test database lives inside the tree `node --watch` was watching, so the
# first sign-in used to restart the server mid-run (issues 95, 102, 109, 111).

# Run the browser suite (clears the Vite dep cache first — see above).
e2e:
    node -e "require('node:fs').rmSync('web/node_modules/.vite',{recursive:true,force:true})"
    pnpm --filter @echozedlabs/web test:e2e:ci

# The order is not arbitrary: typecheck before build catches a type error without
# waiting for a bundle, and the browser suite runs LAST because it is the slowest
# and the only one that needs a built web app and a booted API.

# The full gate, in CI's order. Stops at the first failure.
gate: typecheck build lint test e2e
    @echo "gate: green"

# Everything except the browser suite — the loop to run while working.
check: typecheck lint test
    @echo "check: green"

# ---------------------------------------------------------------- data

# Admin user plus the first-MVP corpus, into the configured database.
seed:
    pnpm --filter @echozedlabs/server seed

# `seed` only fills in what is absent, so a dev instance seeded before the seed
# changed keeps the old seed forever (a "News" Section after the rename to
# Updates, pins with no icons). This MOVES server/data/kp.sqlite* and
# server/data/wiki into server/data/backup-<timestamp>/ — nothing is deleted —
# then seeds fresh. It refuses if DB_URL, CONTENT_ROOT, GIT_MIRROR_ROOT,
# KNOWLEDGE_E3_CONFIG or a server config file could point elsewhere, and fails
# cleanly (changing nothing) while `just dev` still holds the files.

# Set the dev database and content aside (moved, not deleted) and seed fresh.
dev-reset:
    node scripts/dev-reset.mjs
    pnpm --filter @echozedlabs/server seed

# The larger demo corpus, on top of `seed`.
demo:
    pnpm --filter @echozedlabs/server populate:demo

# This is the claim ADR-0001 makes — the index is derived and reconstructible —
# and the only way to find out it is false is to run it. The operations runbook
# §3.7 lists what it does NOT restore (users, sessions, tokens, config, the source
# registry, the audit log); read it before running this against anything you care
# about.

# Drop and rebuild the SQLite index from the git working trees alone.
rebuild-index:
    pnpm --filter @echozedlabs/server rebuild:git

# Nothing in the gate enforces that the committed document is current, so this is
# on you after adding or changing an endpoint.

# Regenerate server/openapi.json.
openapi:
    pnpm --filter @echozedlabs/server openapi

# ---------------------------------------------------------------- operations

# The recovery unit is THREE things and they are not one backup: the git working
# trees (content of record), the asset bytes, and SQLite (derived, but the only
# home of users, sessions, tokens, config, the source registry and the audit log).
#
#   just backup /tmp/ke3-backup

# Capture the recovery unit — git trees, asset bytes, SQLite — into OUT.
backup out:
    pnpm --filter @echozedlabs/server backup -- --out {{out}}

# Restore a backup into an isolated instance and verify it: integrity and
# foreign-key checks, every git tree at its captured commit, every asset byte
# present, then it boots the real app and signs in, reads an item, searches, and
# fetches an asset. Exits non-zero on any failure. Records RPO and RTO.
#
#   just drill /tmp/ke3-backup /tmp/ke3-restore
#
# Two commands rather than one on purpose: `drill:restore` with no --from makes a
# backup that nothing ever deletes, and separating them tells "could not back up"
# apart from "could not restore". The scheduler (`backup.drill.every`, off by
# default) does the same two steps and deletes the scratch either way.

# Restore a backup into an isolated instance and verify it end to end.
drill from target:
    pnpm --filter @echozedlabs/server drill:restore -- --from {{from}} --target {{target}}

# Backup and drill in one go into WORK, which you supply and own.
#
# No temp-directory magic, because a portable mktemp/trap does not exist across
# sh and PowerShell — and a drill that silently deletes its own evidence is the
# wrong default anyway. Point it somewhere you can inspect afterwards, and note
# that the scheduled drill (`backup.drill.every`) is the one that cleans up.
#
#   just drill-now C:/temp/ke3-drill
drill-now work:
    pnpm --filter @echozedlabs/server backup -- --out {{work}}/backup
    pnpm --filter @echozedlabs/server drill:restore -- --from {{work}}/backup --target {{work}}/restore

# ---------------------------------------------------------------- tracker

# Open issues, newest first.
issues:
    python scripts/tracker.py issues

# What is still excluded from the e2e gate, and why.
quarantine:
    python scripts/tracker.py quarantine
