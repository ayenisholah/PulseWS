import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";

export type DeliveryScope = "same_node" | "cross_node";

export class PulseWsMetrics {
  readonly registry = new Registry();

  private readonly connections = new Gauge({
    name: "pulsews_connections",
    help: "Current accepted WebSocket connections.",
    labelNames: ["app_id"] as const,
    registers: [this.registry],
  });
  private readonly messages = new Counter({
    name: "pulsews_messages_total",
    help: "Messages processed by direction.",
    labelNames: ["app_id", "direction"] as const,
    registers: [this.registry],
  });
  private readonly subscriptions = new Gauge({
    name: "pulsews_subscriptions",
    help: "Current channel subscriptions.",
    labelNames: ["app_id", "channel_type"] as const,
    registers: [this.registry],
  });
  private readonly deliveryLatency = new Histogram({
    name: "pulsews_delivery_latency_seconds",
    help: "Time from event publish to local node delivery.",
    labelNames: ["app_id", "scope"] as const,
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });
  private readonly droppedMessages = new Counter({
    name: "pulsews_dropped_messages_total",
    help: "Messages dropped before delivery.",
    labelNames: ["reason"] as const,
    registers: [this.registry],
  });
  private readonly clientEventRejections = new Counter({
    name: "pulsews_client_event_rejections_total",
    help: "Rejected client events.",
    labelNames: ["app_id", "reason"] as const,
    registers: [this.registry],
  });
  private readonly restThrottled = new Counter({
    name: "pulsews_rest_throttled_total",
    help: "Authenticated REST publishes rejected by rate limiting.",
    labelNames: ["app_id"] as const,
    registers: [this.registry],
  });

  constructor(appIds: readonly string[]) {
    collectDefaultMetrics({
      register: this.registry,
      prefix: "pulsews_",
      eventLoopMonitoringPrecision: 10,
    });
    for (const appId of appIds) {
      this.connections.set({ app_id: appId }, 0);
      for (const channelType of ["public", "private", "presence"]) {
        this.subscriptions.set({ app_id: appId, channel_type: channelType }, 0);
      }
    }
  }

  connectionOpened(appId: string): void {
    this.connections.inc({ app_id: appId });
  }

  connectionClosed(appId: string): void {
    this.connections.dec({ app_id: appId });
  }

  messageIn(appId: string): void {
    this.messages.inc({ app_id: appId, direction: "in" });
  }

  messageOut(appId: string): void {
    this.messages.inc({ app_id: appId, direction: "out" });
  }

  subscriptionAdded(appId: string, channelType: string): void {
    this.subscriptions.inc({ app_id: appId, channel_type: channelType });
  }

  subscriptionRemoved(appId: string, channelType: string): void {
    this.subscriptions.dec({ app_id: appId, channel_type: channelType });
  }

  observeDelivery(appId: string, scope: DeliveryScope, latencyMs: number): void {
    this.deliveryLatency.observe(
      { app_id: appId, scope },
      Math.max(0, latencyMs) / 1_000,
    );
  }

  drop(reason: string): void {
    this.droppedMessages.inc({ reason });
  }

  rejectClientEvent(appId: string, reason: string): void {
    this.clientEventRejections.inc({ app_id: appId, reason });
  }

  throttleRest(appId: string): void {
    this.restThrottled.inc({ app_id: appId });
  }

  contentType(): string {
    return this.registry.contentType;
  }

  exposition(): Promise<string> {
    return this.registry.metrics();
  }
}
