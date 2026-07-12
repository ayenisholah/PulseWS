# Repository presentation

Repository files provide the README, package metadata, documentation, release
notes, and community guidance. The GitHub repository owner should keep the
following **About** settings synchronized manually because they are not
controlled by git.

## GitHub About settings

- **Description:** Self-hosted, Pusher-compatible WebSocket pub/sub server
  with Redis clustering and measured capacity.
- **Website:** <https://pulsews.sholaayeni.xyz>
- **Topics:** `websocket`, `pusher`, `realtime`, `pubsub`, `redis`,
  `typescript`, `self-hosted`, `websocket-server`

Enable **Releases** and **Packages** in the repository sidebar. Keep the
`v0.1.0` GitHub release and GHCR image public so README links work for visitors
who are not signed in.

## Release presentation checklist

For each release:

1. Ensure the version in `package.json`, git tag, GitHub release, and container
   tag match.
2. Keep performance claims tied to an artifact-backed run in
   [`loadtest.md`](loadtest.md).
3. Update the compatibility table, changelog, installation guide, and upgrade
   notes when behavior changes.
4. Confirm the live demo, CI badge, release link, container package, local
   documentation links, and security reporting link are public and working.
5. Never add application secrets, VPS credentials, or monitoring credentials
   to repository metadata or screenshots.
