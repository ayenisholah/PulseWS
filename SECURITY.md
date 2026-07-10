# Security Policy

## Supported versions

PulseWS is pre-1.0; only the latest commit on `main` receives security fixes.

| Version | Supported |
|---|---|
| `main` | Yes |
| Anything else | No |

## Reporting a vulnerability

Please do **not** open a public issue for security vulnerabilities.

Report privately via GitHub's
[private vulnerability reporting](https://github.com/ayenisholah/PulseWS/security/advisories/new)
or by email to <ayenisholah@yahoo.com> with a description of the issue, steps
to reproduce, and the potential impact.

You can expect an acknowledgment within 72 hours. Please allow a reasonable
window for a fix before any public disclosure.

## Scope notes

PulseWS handles per-app credentials (HMAC signing secrets) and authenticated
channel subscriptions. Reports about authentication bypass, signature
verification flaws, replay attacks, resource-exhaustion vectors, or
cross-app data leakage are especially valuable.
