# Contributing to PulseWS

Thanks for your interest in PulseWS. The project is in active early
development, so the surface area changes quickly — opening an issue before a
large pull request will save you time.

## Development setup

Requirements: Node.js 22+ and npm. `uWebSockets.js` is installed from a pinned
GitHub release, so git must be available on your PATH.

```sh
git clone https://github.com/ayenisholah/PulseWS.git
cd PulseWS
npm install
npm run verify
```

`npm run verify` runs the strict TypeScript build check and the Vitest suite —
it must pass before every commit. On Windows you can also use:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify.ps1
```

## Testing

- `npm test` runs the Vitest suite once.
- Protocol behavior must be verified against the official `pusher-js` and
  `pusher` SDKs (both are dev dependencies) — new protocol features need
  fixture tests driven by those SDKs, not hand-written message shapes.
- Never weaken or delete an existing test to get to green.

## Commit conventions

- [Conventional Commits](https://www.conventionalcommits.org/) subject lines:
  `type(scope)?: summary`, type ∈ feat fix docs chore refactor test perf ci
  build style, ≤ 72 characters.
- One logical change per commit; CHANGELOG entries go under `[Unreleased]`.

## Proposing significant changes

Design-level changes (new dependencies, protocol behavior, architecture)
are recorded as ADR-lite entries in [docs/DECISIONS.md](docs/DECISIONS.md).
Open an issue or a PR adding an entry with Status `Proposed` and the
context/decision/consequences filled in; implementation starts once it is
`Approved`.

## Scope

PulseWS intentionally excludes an admin dashboard, webhooks, database-backed
app management, encrypted channels, and clustering beyond Redis pub/sub (see
the [engineering spec](docs/pulsews-engineering-doc.md)). PRs adding these
will be declined; feel free to discuss in an issue first.
