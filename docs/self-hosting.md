# Self-hosting Knowledge E3 with Docker

A single container serves both the JSON API and the built web UI on port 3000.
SQLite is the supported store; there are no external services to run.

**Every instance needs an admin account.** Authentication cannot be turned off —
the server refuses to start if anything asks it to — so the first thing this guide
does is create that account.

## Quick start (Docker Compose)

```sh
cp .env.example .env
# edit .env — at minimum set SEED_ADMIN_PASSWORD
docker compose up -d
```

Open <http://localhost:3000> and sign in with `SEED_ADMIN_USERNAME` /
`SEED_ADMIN_PASSWORD`. Each boot idempotently creates that admin (admin only — no
demo data) and is a no-op once the account exists; it never rewrites the password
of an account that is already there, so changing it in the app sticks.

Compose publishes the container on loopback (`127.0.0.1:3000`) by default. Set
`BIND_ADDRESS` / `PORT` in `.env` to publish it somewhere else — do that only
once TLS is terminated in front of it (see below).

## Quick start (plain `docker run`)

```sh
docker build -t knowledge-e3 .
docker run -d -p 127.0.0.1:3000:3000 \
  -v knowledge-e3-data:/data \
  -e SEED_ADMIN_USERNAME=admin \
  -e SEED_ADMIN_PASSWORD='choose-a-strong-one' \
  knowledge-e3
```

Leave `SEED_ADMIN_PASSWORD` unset and the bootstrap is skipped — the entrypoint
says so in the log, and you get a sign-in page with no account behind it until you
seed one by hand:

```sh
docker compose exec -e SEED_ADMIN_PASSWORD='choose-a-strong-one' app \
  node scripts/seed-admin.mjs
```

The password must satisfy the instance's password policy (by default: at least 8
characters; an admin can tighten it in **Admin → Authentication**). A password
that does not is reported by the rule it broke, never by echoing the password.

## Data & backups

Everything lives on the `/data` volume:

| Path | What | Notes |
|---|---|---|
| `/data/kp.sqlite` | Derived search/index database | Rebuildable from git; not a source of truth |
| `/data/wiki` | Git-of-record Markdown working trees **+ uploaded media** | The source of truth (ADR-0001) |

Back up the volume and you have backed up everything. Per ADR-0001 the Markdown in
git is authoritative and the database is a derived index — but the index is the
*only* home of the things that were never content: users, sessions, API tokens,
app config, the source registry, and the audit log. So `/data/wiki` is the half
that matters most, and `/data/kp.sqlite` is not optional.

The product ships its own capture and rehearsal, both plain Node so they run the
same on a laptop and in the container. Mount a **second** volume for the output —
a backup that lives on the volume it is backing up is not a backup:

```sh
# Capture the database, every working tree and every asset byte into one
# self-describing directory (with a manifest describing the copy, not the original).
docker compose exec app sh -c \
  'cd /app/server && node --import @swc-node/register/esm-register scripts/backup.ts --out /backups/$(date +%F)'

# Restore that backup into a fresh, isolated instance and verify it end to end:
# integrity and foreign keys, per-tree git verification, per-asset checksums, then
# it boots the app against the copy and signs in, reads, searches and fetches an
# asset. Exits non-zero on any failed check, so it can be scheduled.
docker compose exec app sh -c \
  'cd /app/server && node --import @swc-node/register/esm-register scripts/restore-drill.ts --from /backups/<date>'
```

**Until a drill has run, Admin → Health → System reports the restore drill as
`never`, which means unverified — not fine.** To have the server rehearse on its
own schedule, set `backup.drill.every` in `knowledge-e3.config.yaml` (or
`BACKUP_DRILL_EVERY`); it is off by default because each run copies the whole
instance to scratch, so the operator chooses the cadence and where the scratch
lives (`BACKUP_DRILL_WORK_DIR`). The drill is a rehearsal, not a backup schedule —
its artifact is scratch and is deleted at the end of the run.

## Configuration

Config resolves **built-in defaults → `knowledge-e3.config.yaml` → environment
variables** (env wins). Copy `knowledge-e3.config.example.yaml` if you prefer a
file — it documents far more than the table below; otherwise these are enough.

| Env var | Default | Meaning |
|---|---|---|
| `BIND_ADDRESS` / `PORT` | `127.0.0.1` / `3000` | Where Compose publishes the container (it always listens on 3000 inside) |
| `DB_URL` | `/data/kp.sqlite` | SQLite index path |
| `GIT_MIRROR_ROOT` | `/data/wiki` | Git-of-record working trees + media. `CONTENT_ROOT` overrides it for content alone |
| `SEED_ADMIN_USERNAME` / `_EMAIL` / `_PASSWORD` | `admin` / `admin@local` / — | First-run admin bootstrap |
| `NODE_ENV` | `development` in Compose | `production` is what puts the `Secure` flag on the session cookie |
| `HTTPS_ONLY` | — | `1` behind TLS; silences the production start-up warning about cookie security |
| `KNOWLEDGE_E3_ALLOWED_ORIGINS` | — | CSRF origin allowlist (your public URL) |
| `TRUST_PROXY` | off | Proxy hops allowed to report the client address. `1` for a single terminator; `true` is refused |
| `KNOWLEDGE_E3_DEFAULT_READ_ACCESS` | `public` | `public` (anonymous may read published content) or `authenticated` |
| `LOGIN_THROTTLE_WINDOW` / `_PER_USERNAME` / `_PER_IP` | `15m` / `5` / `20` | Sign-in lockout buckets |
| `SQLITE_JOURNAL_MODE` | `WAL` | Use `DELETE` on SMB/NFS/Azure-Files mounts, where WAL breaks |
| `AUDIT_RETENTION_DAYS` | `365` | How long the audit log keeps a row; `off` keeps everything |
| `KNOWLEDGE_E3_MCP_RATE_LIMIT` | `120` | Per-user MCP requests/min |
| `KNOWLEDGE_E3_IMPORT_DEFAULT_STATUS` | `draft` | Status for imported items that declare none |

There is no "no login" mode. `KNOWLEDGE_E3_AUTH_MODE` accepts `session` or
nothing at all; any other value stops the boot with the fix in the message.

## Behind a reverse proxy (TLS)

Terminate TLS at a proxy (nginx, Caddy, Traefik) and forward to the container on
3000. Then set **all** of:

```
NODE_ENV=production
HTTPS_ONLY=1
KNOWLEDGE_E3_ALLOWED_ORIGINS=https://knowledge.example.com
TRUST_PROXY=1
```

`NODE_ENV=production` is the one that marks the session cookie `Secure`, which is
also why the Compose default stays `development`: a browser drops a `Secure`
cookie over a plain-HTTP loopback trial, and sign-in would appear to succeed and
then do nothing. Without the origin allowlist, browser mutations from your public
origin are rejected by the CSRF guard with a 403. Without `TRUST_PROXY`, every
request looks like it came from the proxy, so the per-IP sign-in throttle becomes
one bucket for the whole instance. If your proxy limits request bodies, allow at
least 50 MB so OKF `.tar.gz` archive imports pass through (image uploads need 25 MB).

## Health & upgrades

- Liveness `GET /api/v1/healthz` (also the container `HEALTHCHECK`); readiness
  `GET /api/v1/readyz`, which actually asks the database and the content root.
- **Admin → Health → System** is the same set of checks with evidence and a
  suggested action per finding: database, migrations, content root, disk
  headroom, sources, secrets, git mirror backlog and errors, merge conflicts,
  and the restore drill.
- The schema **auto-migrates on boot**; there is no manual migration step.
- Upgrade by pulling or rebuilding the image and recreating the container — the
  `/data` volume persists and the admin bootstrap stays a no-op.

## Git sources, and private repositories

**Admin → Sources** registers a git repository as a source. Use an **HTTPS**
remote: there is no SSH key in the container, so a `git@github.com:…` URL cannot
authenticate.

A **public** repository needs nothing else. A **private** one needs a credential,
and each source carries its **own** — which is how one instance serves two GitHub
accounts, or GitHub and Bitbucket together. Three steps:

1. In **Admin → Sources**, open the source and, under *Host and credentials*,
   set **Host token env var** to a name you choose — say `ACME_DOCS_TOKEN`. Set
   **Host** too: it decides the username git pairs with the token (GitHub →
   `x-access-token`, Bitbucket → `x-token-auth`). This applies to **every** sync
   mode; a `direct` or `read-only` source on a private repository needs it just
   as much as a `review` one.
2. Put that variable in `.env` with the token as its value.
3. `docker compose up -d` to recreate the container.

```sh
# .env
ACME_DOCS_TOKEN=github_pat_xxxxxxxxxxxx
BITBUCKET_DOCS_TOKEN=xxxxxxxxxxxx
```

Compose passes the whole of `.env` into the container (`env_file:` in
`docker-compose.yml`), so **adding a source's variable needs no compose edit**.
That is also why the tokens are not listed one by one under `environment:`: an
`environment:` entry is interpolated when Compose parses the file, so the token
itself is what `docker compose config` prints, while an `env_file` is a path the
runtime reads.

A fine-grained GitHub token with **Contents: read** on that repository is enough
for a read-only source; a source that pushes (direct mode, or review branches)
needs **Contents: read and write**. On **Bitbucket Data Center**, an HTTP access
token works as the password; if your instance expects a real account name rather
than `x-token-auth`, set it by appending `_USERNAME` to the variable:

```sh
BITBUCKET_DOCS_TOKEN=xxxxxxxxxxxx
BITBUCKET_DOCS_TOKEN_USERNAME=e3.service
```

**`GIT_HTTPS_TOKEN` still works** as the instance-wide fallback, used by any
source that names no variable of its own — the right setting for a single
identity on a single host. A source's own variable always wins over it.

**Where the token goes.** Into the environment of the one `git` process making
that source's call, through `GIT_ASKPASS`, and nowhere else: not into the
database, not into gitconfig, not into a remote URL, not into an argument `ps`
could show, not into a log line or a recorded *Last error*, and not into any API
response. **Admin → Sources** reports only whether the named variable is set on
the server — a tick or a cross beside its name, never the value, its length or a
prefix. `GIT_TERMINAL_PROMPT=0` is set on every call, so a missing or wrong
credential fails with an authentication error within seconds instead of hanging
the source's sync on a prompt nobody can answer.

**Admin → Sources → Test connection** runs `git ls-remote` with exactly that
credential, so it answers the same question the sync will. If the variable the
form names is not set on the server, it says so by name.

## Where things are in the admin console

| You want to | Go to |
|---|---|
| Add or disable accounts, reset a password | **Admin → Users** |
| Read access, password policy, API tokens | **Admin → Authentication** |
| Who did what | **Admin → Audit** |
| Topics, primary categories, tags & groups | **Admin → Taxonomy** |
| Front-page sections and pinned topics | **Admin → Sections** |
| Uploaded images and files | **Admin → Files** |
| OKF import, export, and the library audit | **Admin → Data** |
| Register a git repository, test a connection, resolve a conflict | **Admin → Sources** |
| Content health, then instance health | **Admin → Health** |

## OKF v0.2

Exports and imports are Open Knowledge Format **v0.2** bundles (trust, provenance,
lifecycle, and Attested Computation). **Admin → Data** has three tabs — Import
(choose → review → import), Export (a topic, a format, download), and Audit (the
read-only conformance / policy / advisory roll-up with trust tiers and freshness).
Re-importing an export updates items in place, matched on their embedded `e3_id`,
so it doubles as instance-to-instance transfer.
