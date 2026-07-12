# Contributing

Thanks for your interest in contributing. This document explains how to build
the project, what kinds of changes belong here, and the ground rules for
submitting a contribution.

## Project model (please read first)

This repository is the **open core** of an open-core product. The core —
the OKF codec, the parser/exporter, the server engine, the web editor and
viewer, local search, and self-hosting — is open source under the
[Apache License 2.0](./LICENSE) and is genuinely useful on its own.

A separate **hosted cloud edition** (multi-tenancy, billing, hosted
SSO/SAML, managed backups and search, and other managed operations) is
proprietary and lives in a private repository. It is **not** part of this
project and contributions to it do not happen here.

We call this out up front so it's clear what your contribution is and isn't
being used for. Contributions to this repository are used in the open-core
edition. Because the license is permissive (Apache-2.0), they may also be
used in the proprietary hosted edition — see [Licensing of contributions](#licensing-of-contributions).

## What belongs in this repository (contribution triage)

Before opening a large PR, check which side of the line your idea falls on.

**In scope (open core) — welcome here:**

- OKF parsing, validation, export, and round-trip fidelity
- The Markdown ↔ AST codec and its fixtures
- Wiki domain features: pages, links, versioning, taxonomy, content types
- Local search (lexical / FTS) and ranking
- The web editor and viewer
- Local and git-backed storage adapters
- Local auth and standards-based OIDC
- The MCP server and tools
- Self-hosting: Docker Compose, docs, backup/restore scripts
- **Provider _interfaces_** (storage, search, auth, telemetry) — improving
  the seams so alternative implementations can plug in

**Out of scope (belongs in the proprietary cloud edition) — will be declined here:**

- Multi-tenant provisioning, tenant isolation infrastructure
- Billing, subscriptions, plan/entitlement enforcement
- Hosted SSO/SAML/SCIM implementations
- Vendor-specific managed adapters (e.g. cloud blob storage, managed hybrid
  search) — note that a *clean interface* for these IS in scope; only the
  proprietary *implementation* is not
- Operational dashboards and hosted admin tooling

If you're unsure which side something falls on, **open an issue to discuss
before writing code.** A well-designed provider interface contributed here
is often the most valuable form of a "cloud-adjacent" idea.

## Getting started

Prerequisites: Node 20+, pnpm 9+, and (optionally) Docker for the compose
setup.

```bash
pnpm install
pnpm build
pnpm test
```

Useful scoped commands:

```bash
pnpm test:codec      # round-trip codec gate (must stay green)
pnpm test:server     # server e2e suite
pnpm test:web        # web unit tests
pnpm lint
pnpm typecheck
```

To run locally, see the README quickstart (server on port 3000, web on 5173;
SQLite by default, no Docker required).

## Submitting a change

1. **Open an issue first** for anything non-trivial, so we can agree on scope
   and confirm it's in-scope per the triage list above.
2. Fork and branch from the default branch.
3. Keep PRs focused. One logical change per PR.
4. Add or update tests. The **codec round-trip gate must remain green** — it
   is a hard correctness boundary for this project.
5. Run `pnpm lint && pnpm typecheck && pnpm test` before pushing.
6. Match the surrounding code's style and conventions.
7. Write a clear PR description: what changed, why, and how you verified it.

## Licensing of contributions

By submitting a contribution, you agree that it is licensed under the
project's [Apache License 2.0](./LICENSE), and you certify the
[Developer Certificate of Origin](https://developercertificate.org/) (DCO)
for your contribution.

**Sign your commits** with the DCO sign-off (this asserts you have the right
to submit the code):

```bash
git commit -s -m "your message"
```

This adds a `Signed-off-by: Your Name <your@email>` trailer.

> **Note (subject to change):** The project currently uses the DCO. Under
> Apache-2.0's permissive terms, contributions may be incorporated into the
> proprietary hosted edition. We may adopt a Contributor License Agreement
> (CLA) in the future; if so, this section will be updated and the change
> announced. See the project's contribution-model decision for status.

## Security

Please do **not** file public issues for security vulnerabilities. See
[`SECURITY.md`](./SECURITY.md) for how to report privately. (If that file is
not yet present, email the maintainer directly and allow time for a fix
before any public disclosure.)

## Code of conduct

Be respectful and constructive. Harassment or abuse is not tolerated. A full
Code of Conduct may be added as the community grows.
