import { topicFor } from "../channels.js";
import {
  channelEventMessageFromEncodedData,
  encodePusherMessage,
} from "../protocol.js";
import type { EventAdapter, EventPublish } from "./types.js";

export type LocalEventSocket = {
  getUserData: () => {
    closed: boolean;
    subscriptions: Set<string>;
  };
  subscribe: (topic: string) => boolean;
  unsubscribe: (topic: string) => boolean;
};

type TopicPublisher = {
  publish: (topic: string, message: string) => boolean;
};

type LocalDeliveryObserver = {
  messageOut: (appId: string) => void;
  observeDelivery: (
    appId: string,
    scope: "same_node" | "cross_node",
    latencyMs: number,
  ) => void;
  drop: (reason: string) => void;
};

export class LocalEventAdapter implements EventAdapter {
  constructor(
    private readonly app: TopicPublisher,
    private readonly socketsById: ReadonlyMap<string, LocalEventSocket>,
    private readonly nodeId?: string,
    private readonly observer?: LocalDeliveryObserver,
  ) {}

  async initialize(): Promise<void> {}

  async publish(event: EventPublish): Promise<boolean> {
    return this.receive({
      ...event,
      publishedAt: Date.now(),
      ...(this.nodeId === undefined ? {} : { originNodeId: this.nodeId }),
    });
  }

  receive(event: EventPublish): boolean {
    const topic = topicFor(event.appId, event.channel);
    const excludedSocket = event.excludeSocket
      ? this.socketsById.get(event.excludeSocket)
      : undefined;
    let resubscribe = false;

    if (excludedSocket) {
      const socketData = excludedSocket.getUserData();
      if (
        !socketData.closed &&
        socketData.subscriptions.has(event.channel)
      ) {
        resubscribe = excludedSocket.unsubscribe(topic);
      }
    }

    try {
      const delivered = this.app.publish(
        topic,
        encodePusherMessage(
          channelEventMessageFromEncodedData(
            event.channel,
            event.event,
            event.data,
            event.userId,
          ),
        ),
      );
      this.observer?.messageOut(event.appId);
      if (!delivered) {
        this.observer?.drop("no_local_subscribers");
      }
      if (event.publishedAt !== undefined && event.originNodeId !== undefined) {
        this.observer?.observeDelivery(
          event.appId,
          event.originNodeId === this.nodeId ? "same_node" : "cross_node",
          Date.now() - event.publishedAt,
        );
      }
      return delivered;
    } finally {
      if (resubscribe && excludedSocket && event.excludeSocket) {
        const socketData = excludedSocket.getUserData();
        if (
          this.socketsById.get(event.excludeSocket) === excludedSocket &&
          !socketData.closed &&
          socketData.subscriptions.has(event.channel)
        ) {
          excludedSocket.subscribe(topic);
        }
      }
    }
  }

  async close(): Promise<void> {}
}

export type { EventAdapter, EventPublish } from "./types.js";
