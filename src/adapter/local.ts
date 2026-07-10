import { topicFor } from "../channels.js";
import {
  channelEventMessageFromEncodedData,
  encodePusherMessage,
} from "../protocol.js";

export type EventPublish = {
  appId: string;
  channel: string;
  event: string;
  data: string;
  excludeSocket?: string;
  userId?: string;
};

export interface EventAdapter {
  publish(event: EventPublish): boolean;
}

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

export class LocalEventAdapter implements EventAdapter {
  constructor(
    private readonly app: TopicPublisher,
    private readonly socketsById: ReadonlyMap<string, LocalEventSocket>,
  ) {}

  publish(event: EventPublish): boolean {
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
      return this.app.publish(
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
}
