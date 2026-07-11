import http from "k6/http";
import ws from "k6/ws";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";
import { channelFor, positiveInteger, signedPublish, subscribeMessage, wsUrl } from "./common.js";

const failures = new Counter("pulsews_cross_node_failures");
const delivery = new Trend("pulsews_cross_node_delivery_ms", true);

export const options = {
  vus: positiveInteger("PULSEWS_VUS", 10),
  iterations: positiveInteger("PULSEWS_ITERATIONS", 20),
  thresholds: {
    pulsews_cross_node_failures: ["count==0"],
    pulsews_cross_node_delivery_ms: ["p(99)<1000"],
  },
};

export default function () {
  const channel = channelFor(__VU * 100000 + __ITER);
  let nodeId;
  let sentAt;
  let delivered = false;
  const response = ws.connect(wsUrl(), {}, (socket) => {
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
        const request = signedPublish(channel, "cross-node-load", { sentAt, sourceNode: nodeId });
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
