# Decision Log (ADR-lite)

Significant technical decisions are recorded here before implementation.
Statuses: Proposed → Approved / Rejected; later possibly Superseded.

## Template

```
## D-XXX: <short title>
- Date: YYYY-MM-DD · Status: Proposed · Decider: Shola Ayeni
- Context: <what prompted this>
- Decision: <what will be done>
- Consequences: <trade-offs, follow-ups>
```

---

## D-001: MIT license

- Date: 2026-07-10 · Status: Approved · Decider: Shola Ayeni
- Context: open-source infrastructure project; comparable projects (Soketi)
  are permissively licensed.
- Decision: MIT, © 2026 Shola Ayeni.
- Consequences: maximally permissive; no CLA needed.

## D-002: Add Node.js type declarations

- Date: 2026-07-10 · Status: Approved · Decider: Shola Ayeni
- Context: the config loader reads JSON from disk and uses Node built-ins such
  as `node:fs/promises`, `node:path`, `node:os`, and `process.env`. TypeScript
  needs the Node type declarations for those APIs.
- Decision: add `@types/node` as a dev dependency.
- Consequences: the dev dependency allowlist expands by one type-only package;
  runtime dependencies remain unchanged.

## D-003: Use Node 22 as the minimum runtime

- Date: 2026-07-10 · Status: Approved · Decider: Shola Ayeni
- Context: the pinned uWebSockets.js `v20.68.0` release supports Node 22 and
  newer, while CI was configured to run on unsupported Node 20.
- Decision: raise the documented and package-declared minimum runtime to Node
  22 and run CI on Node 22.
- Consequences: Node 20 is no longer supported; Node 22 is the oldest tested
  runtime while compatible newer releases remain usable.

## D-004: Use Node HTTP for the authentication example

- Date: 2026-07-10 · Status: Approved · Decider: Shola Ayeni
- Context: the private-channel milestone calls for a small authentication
  endpoint, while adding Express solely for the example would expand the
  dependency surface without changing the protocol demonstration.
- Decision: build the example with the Node.js HTTP server and existing
  PulseWS signing helpers.
- Consequences: the example has no additional dependencies and remains
  framework-neutral, but production users must adapt its authorization policy
  to their own web framework and identity system.
