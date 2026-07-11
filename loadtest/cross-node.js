import http from "k6/http";
import ws from "k6/ws";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";
import { channelFor, positiveInteger, signedPublish, subscribeMessage, wsUrl } from "./common.js";

const publishUrl = (__ENV.PULSEWS_NODE_A_URL || "http://127.0.0.1:6002").replace(/\/$/, "");
const receiveUrl = (__ENV.PULSEWS_NODE_B_URL || "http://127.0.0.1:6003").replace(/\/$/, "");
const expectedScope = __ENV.PULSEWS_EXPECT_SCOPE || "cross_node";

const failures = new Counter("pulsews_delivery_failures");
const delivery = new Trend("pulsews_delivery_ms", true);

export const options = {
  vus: positiveInteger("PULSEWS_VUS", 10),
  iterations: positiveInteger("PULSEWS_ITERATIONS", 20),
  thresholds: {
    dropped_iterations: ["count==0"],
    http_req_failed: ["rate==0"],
    pulsews_delivery_failures: ["count==0"],
    pulsews_delivery_ms: ["p(99)<40"],
  },
};

export default function () {
  if (!["same_node", "cross_node"].includes(expectedScope)) {
    throw new Error("PULSEWS_EXPECT_SCOPE must be same_node or cross_node");
  }
  if (expectedScope === "cross_node" && publishUrl === receiveUrl) {
    throw new Error("Cross-node mode requires different node URLs");
  }
  if (expectedScope === "same_node" && publishUrl !== receiveUrl) {
    throw new Error("Same-node mode requires identical node URLs");
  }
  const channel = channelFor(__VU * 100000 + __ITER);
  let nodeId;
  let sentAt;
  let delivered = false;
  const response = ws.connect(wsUrl(receiveUrl), {}, (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw);
      if (message.event === "pulsews:node") {
        nodeId = JSON.parse(message.data).node_id;
      }
      if (message.event === "pusher:connection_established") {
        socket.send(subscribeMessage(channel));
      }
      if (message.event === "pusher_internal:subscription_succeeded") {
        sentAt = Date.now();
        const request = signedPublish(
          channel,
          "cross-node-load",
          { sentAt, receiverNode: nodeId, expectedScope },
          publishUrl,
        );
        const publish = http.post(request.url, request.body, { headers: { "Content-Type": "application/json" } });
        if (publish.status !== 200) failures.add(1);
      }
      if (message.event === "cross-node-load") {
        delivery.add(Date.now() - sentAt);
        delivered = true;
        socket.close();
      }
    });
    socket.on("error", () => failures.add(1));
    socket.setTimeout(() => socket.close(), positiveInteger("PULSEWS_TIMEOUT_SECONDS", 10) * 1000);
  });
  check(response, { "WebSocket upgraded": (result) => result && result.status === 101 });
  if (!delivered) failures.add(1);
}
