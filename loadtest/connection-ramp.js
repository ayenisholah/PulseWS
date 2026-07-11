import ws from "k6/ws";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";
import { baseUrl, duration, positiveInteger, wsUrl } from "./common.js";

const vus = positiveInteger("PULSEWS_VUS", 500);
const handshake = new Trend("pulsews_ws_handshake_ms", true);
const failures = new Counter("pulsews_ws_failures");
let attempted = false;

export const options = {
  stages: [
    { duration: __ENV.PULSEWS_RAMP_DURATION || "30s", target: vus },
    { duration, target: vus },
    { duration: __ENV.PULSEWS_RAMP_DOWN_DURATION || "15s", target: 0 },
  ],
  thresholds: {
    dropped_iterations: ["count==0"],
    pulsews_ws_failures: ["count==0"],
    pulsews_ws_handshake_ms: ["p(99)<2000"],
  },
};

export default function () {
  if (attempted) {
    // ramping-vus repeats default(); park the VU so a rejected connection does
    // not become a hot retry loop and distort the fixed concurrency gate.
    sleep(positiveInteger("PULSEWS_SCENARIO_SECONDS", 105));
    return;
  }
  attempted = true;
  const started = Date.now();
  const response = ws.connect(wsUrl(), {}, (socket) => {
    socket.on("open", () => handshake.add(Date.now() - started));
    socket.on("error", (error) => {
      failures.add(1, { phase: "socket" });
      console.warn(`WebSocket error: ${String(error)}`);
    });
    socket.setInterval(() => socket.send(JSON.stringify({ event: "pusher:ping", data: {} })), 15000);
    socket.setTimeout(() => socket.close(), positiveInteger("PULSEWS_HOLD_SECONDS", 60) * 1000);
  });
  const upgraded = check(response, { "WebSocket upgraded": (result) => result && result.status === 101 });
  if (!upgraded) {
    const status = String(response?.status ?? "none");
    failures.add(1, { phase: "upgrade", status });
    console.warn(`WebSocket upgrade rejected with status ${status}`);
  }
}

export function setup() {
  check(baseUrl, { "URL configured": (value) => value.startsWith("http") });
}
