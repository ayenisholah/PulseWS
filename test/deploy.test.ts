import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

describe("production container and Compose cluster", () => {
  test("builds a non-root multi-stage production image with health checks", async () => {
    const dockerfile = await read("Dockerfile");

    expect(dockerfile.match(/^FROM /gm)).toHaveLength(2);
    expect(dockerfile).toContain("FROM node:22-trixie-slim AS build");
    expect(dockerfile).toContain("FROM node:22-trixie-slim AS runtime");
    expect(dockerfile).toContain("npm run build:prod");
    expect(dockerfile).toContain("npm prune --omit=dev");
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain('CMD ["node", "dist/index.js"]');
    expect(dockerfile).not.toContain("pulsews.config.json ./");
  });

  test("defines the complete two-node cluster with stable identities", async () => {
    const compose = await read("deploy/docker-compose.yml");
    for (const service of [
      "redis:",
      "pulsews-a:",
      "pulsews-b:",
      "nginx:",
      "prometheus:",
      "grafana:",
    ]) {
      expect(compose).toContain(service);
    }
    expect(compose).toContain("PULSEWS_NODE_ID: pulsews-a");
    expect(compose).toContain("PULSEWS_NODE_ID: pulsews-b");
    expect(compose).toContain('PULSEWS_CLUSTER_SIZE: "2"');
    expect(compose).toContain(
      "image: ${PULSEWS_IMAGE:-ghcr.io/ayenisholah/pulsews:edge}",
    );
    expect(compose).toContain("pull_policy: always");
    expect(compose).toContain(
      "./pulsews.config.json:/run/secrets/pulsews.config.json:ro",
    );
  });

  test("configures least-connection WebSocket proxying and monitoring", async () => {
    const [nginx, prometheus, datasource, provider, dashboard] = await Promise.all([
      read("deploy/nginx.conf"),
      read("deploy/prometheus.yml"),
      read("deploy/grafana/provisioning/datasources/prometheus.yml"),
      read("deploy/grafana/provisioning/dashboards/pulsews.yml"),
      read("deploy/grafana/provisioning/dashboards/json/pulsews-overview.json"),
    ]);

    expect(nginx).toContain("least_conn;");
    expect(nginx).toContain("proxy_set_header Upgrade $http_upgrade;");
    expect(nginx).toContain('proxy_set_header Connection "upgrade";');
    expect(prometheus).toContain("pulsews-a:6001");
    expect(prometheus).toContain("pulsews-b:6001");
    expect(datasource).toContain("url: http://prometheus:9090");
    expect(datasource).toContain("uid: pulsews-prometheus");
    expect(provider).toContain("/etc/grafana/provisioning/dashboards/json");
    for (const metric of [
      "pulsews_connections",
      "pulsews_messages_total",
      "pulsews_delivery_latency_seconds_bucket",
      "pulsews_dropped_messages_total",
      "pulsews_client_event_rejections_total",
      "pulsews_rest_throttled_total",
    ]) {
      expect(dashboard).toContain(metric);
    }
  });

  test("keeps the mounted secret config out of git", async () => {
    const gitignore = await read(".gitignore");
    expect(gitignore).toContain("deploy/pulsews.config.json");
  });
});

function read(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}
