# Security Policy

Knowledge E3 is an early-stage (pre-1.0) open-core project. We take security
seriously and appreciate responsible disclosure.

## Supported versions

Security fixes are applied to the latest version on the default branch.
Older pre-release versions are not separately maintained.

| Version        | Supported |
|----------------|-----------|
| 0.1.x (latest) | ✅        |
| < 0.1          | ❌        |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
pull requests, or discussions.**

Instead, use **GitHub's private vulnerability reporting**:

1. Open the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Complete the private advisory form.

This opens a channel visible only to the maintainers. Please include, where
possible:

- A description of the issue and its impact.
- Steps to reproduce (proof-of-concept; affected component/endpoint).
- The version or commit affected, and your environment.
- Any suggested remediation.

## What to expect

This is a small project maintained on a best-effort basis:

- We aim to acknowledge a report within a few business days.
- We'll validate the issue with you and keep you updated on remediation.
- Please allow reasonable time for a fix before any public disclosure. We're
  glad to credit reporters who would like to be acknowledged.

## Scope

This policy covers the **open-core edition** in this repository — the
self-hostable server, web client, codec, OKF tooling, and MCP server. The
hosted cloud edition is operated separately and is out of scope here.

Because Knowledge E3 is self-hosted, the operational security of any given
deployment (secrets management, TLS, network exposure, OS/runtime patching,
database backups) is the responsibility of the operator. See the README and
`knowledge-e3.config.example.yaml` for secure-by-default guidance.
