import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";
import { channelFor, duration, positiveInteger, signedPublish } from "./common.js";

const rate = positiveInteger("PULSEWS_RATE", 50);
const failures = new Counter("pulsews_rest_failures");
const latency = new Trend("pulsews_rest_publish_ms", true);

export const options = {
  scenarios: {
    signed_rest: {
      executor: "constant-arrival-rate",
      rate,
      timeUnit: "1s",
      duration,
      preAllocatedVUs: Math.max(10, Math.ceil(rate / 2)),
      maxVUs: Math.max(50, rate * 2),
    },
  },
  thresholds: {
    pulsews_rest_failures: ["count==0"],
    pulsews_rest_publish_ms: ["p(99)<1000"],
  },
};

export default function () {
  const request = signedPublish(channelFor(__ITER), "load-event", { sentAt: Date.now(), iteration: __ITER });
  const response = http.post(request.url, request.body, { headers: { "Content-Type": "application/json" } });
  latency.add(response.timings.duration);
  check(response, { "signed publish accepted": (result) => result.status === 200 }) || failures.add(1);
}
