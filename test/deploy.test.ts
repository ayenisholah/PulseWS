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
    expect(nginx).toContain("worker_processes auto;");
    expect(nginx).toContain("worker_connections 4096;");
    expect(nginx).toContain("worker_rlimit_nofile 65535;");
    expect(nginx).toContain("proxy_set_header Upgrade $http_upgrade;");
    expect(nginx).toContain('proxy_set_header Connection "upgrade";');
    expect(prometheus).toContain("pulsews-a:6001");
    expect(prometheus).toContain("pulsews-b:6001");
    expect(datasource).toContain("url: http://prometheus:9090");
    expect(datasource).toContain("uid: pulsews-prometheus");
    expect(datasource).toContain("deleteDatasources:");
    expect(datasource).toContain("prune: true");
    expect(datasource).toContain("version: 1");
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

    const provisionedDashboard = JSON.parse(dashboard) as {
      uid?: string;
      panels?: Array<{ title?: string; datasource?: { uid?: string } }>;
    };
    expect(provisionedDashboard.uid).toBe("pulsews-overview");
    expect(provisionedDashboard.panels).toHaveLength(10);
    expect(provisionedDashboard.panels?.every(
      (panel) => panel.datasource?.uid === "pulsews-prometheus",
    )).toBe(true);
  });

  test("keeps the mounted secret config out of git", async () => {
    const gitignore = await read(".gitignore");
    expect(gitignore).toContain("deploy/pulsews.config.json");
  });

  test("keeps monitoring and direct node diagnostics on localhost", async () => {
    const compose = await read("deploy/docker-compose.yml");

    expect(compose).toContain('127.0.0.1:${PULSEWS_NODE_A_PORT:-6002}:6001');
    expect(compose).toContain('127.0.0.1:${PULSEWS_NODE_B_PORT:-6003}:6001');
    expect(compose).toContain('127.0.0.1:${PROMETHEUS_PORT:-9090}:9090');
    expect(compose).toContain('127.0.0.1:${GRAFANA_PORT:-3000}:3000');
    expect(compose).toContain('max-size: "10m"');
    expect(compose).toContain('max-file: "5"');
    expect(compose.match(/soft: 65535/g)).toHaveLength(3);
    expect(compose.match(/hard: 65535/g)).toHaveLength(3);
  });

  test("checks named smoke members without rejecting other demo users", async () => {
    const smoke = await read("scripts/cluster-smoke.ts");

    expect(smoke).toContain('firstChannel.members.get(userId)');
    expect(smoke).toContain('secondChannel.members.get(userId)');
    expect(smoke).not.toContain("members.count !== 2");
  });

  test("provides an opt-in production failover gate", async () => {
    const workflow = await read(".github/workflows/deploy-production.yml");

    expect(workflow).toContain("run_failover:");
    expect(workflow).toContain('PULSEWS_FAILOVER_TIMEOUT_SECONDS: "45"');
    expect(workflow).toContain("stop pulsews-a");
    expect(workflow).toContain("start pulsews-a");
    expect(workflow).toContain('test "$smoke_status" -eq 0');
  });

  test("provides a fixed, evidence-preserving 500-connection acceptance gate", async () => {
    const [workflow, runner] = await Promise.all([
      read(".github/workflows/load-acceptance.yml"),
      read(".github/scripts/run-load-acceptance.sh"),
    ]);

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("image_tag:");
    expect(workflow).toContain("retention_days:");
    expect(workflow).toContain("if: ${{ always() }}");
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("npm run smoke:cluster");
    expect(workflow).toContain("rm -f '/tmp/pulsews-load-$RUN_ID.env'");
    expect(runner).toContain("grafana/k6:2.0.0");
    expect(runner).toContain("--network host");
    expect(runner).toContain("--env-file");
    expect(runner).toContain("PULSEWS_VUS=500");
    expect(runner).toContain("PULSEWS_RATE=50");
    expect(runner).toContain("PULSEWS_DURATION=5m");
    expect(runner).toContain("PULSEWS_ITERATIONS=100");
    expect(runner).toContain("same-node-500");
    expect(runner).toContain("cross-node-500");
    expect(runner).toContain("prometheus-targets.json");
    expect(runner).toContain("Contention disclosure:");
    expect(runner).toContain("postflight || overall_status=1");
    expect(runner).toContain('--user "$(id -u):$(id -g)"');
    expect(runner).toContain("connection_headroom");
    expect(runner).toContain("wait_for_recovery");
    expect(runner).toContain("drops-by-reason.json");
    expect(runner.match(/reason%21%3D%22no_local_subscribers%22/g)).toHaveLength(2);
    expect(runner.match(/%20or%20vector%280%29/g)).toHaveLength(2);
    expect(runner).toContain("PULSEWS_CHANNEL_PREFIX");
    expect(runner).toContain("PULSEWS_CONSUMER_SECONDS=310");
    expect(runner.match(/PULSEWS_PUBLISH_DELAY_MS=250/g)).toHaveLength(2);
    expect(runner).toContain("printf '0\\n'");
    expect(runner).toContain('current_connections=$(prometheus_scalar');
    expect(runner).toContain('current_drops=$(prometheus_scalar');
    expect(runner).toContain('current_throttles=$(prometheus_scalar');
  });

  test("prevents connection retry amplification and diagnoses delivery rejects", async () => {
    const [connections, delivery, common] = await Promise.all([
      read("loadtest/connection-ramp.js"),
      read("loadtest/cross-node.js"),
      read("loadtest/common.js"),
    ]);

    expect(connections).toContain("let attempted = false");
    expect(connections).toContain("if (attempted)");
    expect(connections).toContain("WebSocket upgrade rejected with status");
    expect(connections).toContain('pulsews_ws_handshake_ms: ["p(99)<2000"]');
    expect(delivery).toContain("pulsews_delivery_publish_failures");
    expect(delivery).toContain("pulsews_delivery_timeouts");
    expect(delivery).toContain("Delivery publish rejected: status=");
    expect(delivery).toContain('sleep(positiveInteger("PULSEWS_PUBLISH_DELAY_MS", 250) / 1000)');
    expect(delivery).toContain('pulsews_delivery_ms: ["p(99)<40"]');
    expect(common).toContain('PULSEWS_CHANNEL_PREFIX || "load"');
  });

  test("keeps REST publishing subscribed on every channel on both nodes", async () => {
    const rest = await read("loadtest/rest-latency.js");

    expect(rest).toContain("consumers_a:");
    expect(rest).toContain("consumers_b:");
    expect(rest.match(/vus: 32/g)).toHaveLength(2);
    expect(rest).toContain('startTime: "5s"');
    expect(rest).toContain("pulsews_rest_consumer_connection_failures");
    expect(rest).toContain("pulsews_rest_consumer_subscription_failures");
    expect(rest).toContain('pulsews_rest_publish_ms: ["p(99)<1000"]');
  });

  test("provides an automatic stop-on-first-failure measured capacity benchmark", async () => {
    const [workflow, runner, scenario] = await Promise.all([
      read(".github/workflows/load-capacity.yml"),
      read(".github/scripts/run-load-capacity.sh"),
      read("loadtest/capacity.js"),
    ]);

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("run-load-capacity.sh");
    expect(workflow).toContain("if: ${{ always() }}");
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("npm run smoke:cluster");
    expect(workflow).toContain("rm -f '/tmp/pulsews-capacity-$RUN_ID.env'");
    expect(runner).toContain("readonly tiers=(1000 2500 5000 7500 10000)");
    expect(runner).toContain("readonly required_cap=12000");
    expect(runner).toContain('required_headroom=10000');
    expect(runner).toContain('break; fi');
    expect(runner).toContain("wait_for_recovery");
    expect(runner).toContain("sleep 5");
    expect(runner).toContain("overload < 12");
    expect(runner).toContain("sustained-overload.failed");
    expect(runner).toContain("k6-summary.json");
    expect(runner).toContain("image-digests.txt");
    expect(runner).toContain("host-samples.csv");
    expect(runner).toContain("container-samples.csv");
    expect(runner).toContain("prometheus-samples.csv");
    expect(runner).toContain("not every intended WebSocket upgrade was observed");
    expect(runner).toContain("not every intended public subscription was observed");
    expect(runner).toContain("redis-errors.txt");
    expect(runner).toContain("trap 'stop_sampler; rm -f");
    expect(runner).toContain("same-node and cross-node delivery series did not both increase");
    expect(runner).toContain("k6 and PulseWS shared the VPS");
    expect(scenario).toContain('executor: "ramping-vus"');
    expect(scenario).toContain('executor: "constant-arrival-rate"');
    expect(scenario).toContain('PULSEWS_CHANNELS');
    expect(scenario).toContain('"p(99)<2000"');
    expect(scenario).toContain('"p(99)<40"');
    expect(scenario).toContain('dropped_iterations: ["count==0"]');
    expect(scenario).toContain("sentAt: Date.now()");
    expect(scenario).toContain("pusher_internal:subscription_succeeded");
  });
});

function read(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}
