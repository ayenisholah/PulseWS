import http from "k6/http";
import ws from "k6/ws";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";
import { channelFor, duration, positiveInteger, signedPublish, subscribeMessage, wsUrl } from "./common.js";

const rate = positiveInteger("PULSEWS_RATE", 50);
const failures = new Counter("pulsews_rest_failures");
const latency = new Trend("pulsews_rest_publish_ms", true);
const consumerConnectionFailures = new Counter("pulsews_rest_consumer_connection_failures");
const consumerSubscriptionFailures = new Counter("pulsews_rest_consumer_subscription_failures");
const nodeAUrl = (__ENV.PULSEWS_NODE_A_URL || "http://127.0.0.1:6002").replace(/\/$/, "");
const nodeBUrl = (__ENV.PULSEWS_NODE_B_URL || "http://127.0.0.1:6003").replace(/\/$/, "");
const consumerSeconds = positiveInteger("PULSEWS_CONSUMER_SECONDS", 70);

export const options = {
  scenarios: {
    consumers_a: {
      executor: "per-vu-iterations",
      vus: 32,
      iterations: 1,
      exec: "consumeNodeA",
      maxDuration: `${consumerSeconds}s`,
    },
    consumers_b: {
      executor: "per-vu-iterations",
      vus: 32,
      iterations: 1,
      exec: "consumeNodeB",
      maxDuration: `${consumerSeconds}s`,
    },
    signed_rest: {
      executor: "constant-arrival-rate",
      rate,
      timeUnit: "1s",
      duration,
      startTime: "5s",
      exec: "publish",
      preAllocatedVUs: Math.max(10, Math.ceil(rate / 2)),
      maxVUs: Math.max(50, rate * 2),
    },
  },
  thresholds: {
    dropped_iterations: ["count==0"],
    http_req_failed: ["rate==0"],
    pulsews_rest_failures: ["count==0"],
    pulsews_rest_consumer_connection_failures: ["count==0"],
    pulsews_rest_consumer_subscription_failures: ["count==0"],
    pulsews_rest_publish_ms: ["p(99)<1000"],
  },
};

export function publish() {
  const request = signedPublish(channelFor(__ITER), "load-event", { sentAt: Date.now(), iteration: __ITER });
  const response = http.post(request.url, request.body, { headers: { "Content-Type": "application/json" } });
  latency.add(response.timings.duration);
  check(response, { "signed publish accepted": (result) => result.status === 200 }) || failures.add(1);
}

function consume(targetUrl) {
  const channel = channelFor((__VU - 1) % 32);
  let subscribed = false;
  const response = ws.connect(wsUrl(targetUrl), {}, (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw);
      if (message.event === "pusher:connection_established") {
        socket.send(subscribeMessage(channel));
      }
      if (message.event === "pusher_internal:subscription_succeeded") {
        subscribed = true;
      }
    });
    socket.on("error", () => consumerConnectionFailures.add(1));
    socket.setInterval(() => socket.send(JSON.stringify({ event: "pusher:ping", data: {} })), 15000);
    socket.setTimeout(() => socket.close(), (consumerSeconds - 1) * 1000);
  });
  if (!check(response, { "REST consumer WebSocket upgraded": (result) => result && result.status === 101 })) {
    consumerConnectionFailures.add(1);
  }
  if (!subscribed) {
    consumerSubscriptionFailures.add(1);
  }
}

export function consumeNodeA() {
  consume(nodeAUrl);
}

export function consumeNodeB() {
  consume(nodeBUrl);
}
