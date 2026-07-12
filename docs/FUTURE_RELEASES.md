# Future releases

PulseWS `v0.1.0` is the completed baseline: Pusher protocol 7 public, private,
and presence channels; signed REST publishing; client events; Redis-backed
clustering; production observability; graceful failover; and a measured
stable maximum of 7,500 concurrent connections on the documented shared VPS.

This roadmap records direction, not promises. An item becomes committed only
when it is assigned to a release with acceptance criteria and implementation
tracking. Compatibility and performance claims must be verified before they
are published.

## Proposed v0.2.0 — operations and compatibility

### Planned for evaluation

- Make release deployment, rollback, backup restoration, and disaster
  recovery repeatable and evidence-producing.
- Expand official SDK compatibility coverage beyond the current JavaScript
  browser and Node server clients.
- Improve configuration validation output, secret rotation guidance, and
  operator diagnostics.
- Publish multi-architecture container images if native dependency support
  and CI verification are reliable.
- Add bounded retention and alerting guidance for Prometheus, Grafana, Redis,
  and container logs.

### Compatibility candidates

- Pusher-compatible webhooks with signed delivery, retries, and bounded
  queues.
- Encrypted/private-encrypted channel feasibility and SDK interoperability.
- Additional REST API compatibility where real applications demonstrate a
  migration need.

These features require protocol fixtures, official SDK integration tests, and
security review before inclusion. They are not supported in `v0.1.0`.

### Performance candidates

- Separate load generation from the PulseWS host to remove shared-machine
  contention from published capacity results.
- Measure additional hardware profiles and longer sustained workloads.
- Investigate the 10,000-connection publisher-iteration failure before making
  any higher capacity claim.

## Under consideration

- Operator-facing configuration and health tooling.
- Optional administrative APIs with explicit authentication and auditability.
- Alternative Redis deployment guidance for managed and highly available
  installations.
- Additional language-specific authentication examples.

## Explicitly not committed

- A bespoke hosted control plane or billing system.
- Database-backed dynamic app management.
- Clustering without Redis.
- A 10,000-connection production claim without a fully passing measured tier.

## Release promotion rules

Before a future version is released:

1. Move selected work into a versioned implementation plan with measurable
   acceptance criteria.
2. Add unit, integration, official-SDK, deployment, and failure-path coverage
   appropriate to the change.
3. Update compatibility, security, operations, and migration documentation.
4. Run the full repository verification and all affected production gates.
5. Record user-visible changes in `CHANGELOG.md` and publish only measured
   performance results.
