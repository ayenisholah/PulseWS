import http from "k6/http";
import ws from "k6/ws";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";
import { channelCount, channelFor, positiveInteger, signedPublish, subscribeMessage, wsUrl } from "./common.js";

const vus = positiveInteger("PULSEWS_VUS", 50);
const rate = positiveInteger("PULSEWS_RATE", 50);
const ramp = __ENV.PULSEWS_RAMP_DURATION || "5m";
const hold = __ENV.PULSEWS_HOLD_DURATION || "5m";
const rampDown = __ENV.PULSEWS_RAMP_DOWN_DURATION || "30s";
const connectionSeconds = positiveInteger("PULSEWS_CONNECTION_SECONDS", 630);

const handshakes = new Trend("pulsews_capacity_handshake_ms", true);
const deliveries = new Trend("pulsews_capacity_delivery_ms", true);
const connectionFailures = new Counter("pulsews_capacity_connection_failures");
const subscriptionFailures = new Counter("pulsews_capacity_subscription_failures");
const publishFailures = new Counter("pulsews_capacity_publish_failures");
let attempted = false;

export const options = {
  scenarios: {
    connections: {
      executor: "ramping-vus",
      exec: "connection",
      startVUs: 0,
      stages: [
        { duration: ramp, target: vus },
        { duration: hold, target: vus },
        { duration: rampDown, target: 0 },
      ],
      gracefulRampDown: "30s",
    },
    publishers: {
      executor: "constant-arrival-rate",
      exec: "publish",
      startTime: ramp,
      duration: hold,
      rate,
      timeUnit: "1s",
      preAllocatedVUs: positiveInteger("PULSEWS_PUBLISHER_VUS", 10),
      maxVUs: positiveInteger("PULSEWS_MAX_PUBLISHER_VUS", 50),
    },
  },
  thresholds: {
    dropped_iterations: ["count==0"],
    http_req_failed: ["rate==0"],
    pulsews_capacity_connection_failures: ["count==0"],
    pulsews_capacity_subscription_failures: ["count==0"],
    pulsews_capacity_publish_failures: ["count==0"],
    pulsews_capacity_handshake_ms: ["p(99)<2000"],
    pulsews_capacity_delivery_ms: ["p(99)<40"],
  },
};

export function setup() {
  if (channelCount !== 100) throw new Error("PULSEWS_CHANNELS must be 100 for the capacity benchmark");
}

export function connection() {
  if (attempted) {
    sleep(connectionSeconds);
    return;
  }
  attempted = true;
  const channel = channelFor(__VU - 1);
  const started = Date.now();
  let subscribed = false;
  const response = ws.connect(wsUrl(), {}, (socket) => {
    socket.on("open", () => handshakes.add(Date.now() - started));
    socket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw); } catch (_) { return; }
      if (message.event === "pusher:connection_established") socket.send(subscribeMessage(channel));
      if (message.event === "pusher_internal:subscription_succeeded") subscribed = true;
      if (message.event === "capacity-event") {
        try {
          const payload = typeof message.data === "string" ? JSON.parse(message.data) : message.data;
          if (Number.isFinite(payload?.sentAt)) deliveries.add(Date.now() - payload.sentAt);
        } catch (_) { /* malformed application events fail server-side delivery checks */ }
      }
    });
    socket.on("error", () => connectionFailures.add(1, { phase: "socket" }));
    socket.setInterval(() => socket.send(JSON.stringify({ event: "pusher:ping", data: {} })), 15000);
    socket.setTimeout(() => socket.close(), connectionSeconds * 1000);
  });
  if (!check(response, { "WebSocket upgraded": (r) => r?.status === 101 })) {
    connectionFailures.add(1, { phase: "upgrade", status: String(response?.status ?? "none") });
  }
  if (!subscribed) subscriptionFailures.add(1);
}

export function publish() {
  const channel = channelFor(__ITER);
  const request = signedPublish(channel, "capacity-event", { sentAt: Date.now(), sequence: __ITER });
  const response = http.post(request.url, request.body, { headers: { "Content-Type": "application/json" } });
  if (!check(response, { "REST publish accepted": (r) => r.status === 200 })) {
    publishFailures.add(1, { status: String(response.status) });
  }
}
