import { describe, expect, test, vi } from "vitest";

import {
  LocalEventAdapter,
  type LocalEventSocket,
} from "../src/adapter/local.js";

const event = {
  appId: "demo-app",
  channel: "public-updates",
  event: "demo.event",
  data: JSON.stringify({ ok: true }),
};

describe("local event adapter", () => {
  test("publishes encoded data once to the uWS app topic", () => {
    const app = { publish: vi.fn(() => true) };
    const adapter = new LocalEventAdapter(app, new Map());

    expect(adapter.publish(event)).toBe(true);
    expect(app.publish).toHaveBeenCalledWith(
      "demo-app/public-updates",
      JSON.stringify({
        event: "demo.event",
        channel: "public-updates",
        data: event.data,
      }),
    );
  });

  test("includes presence user metadata when supplied", () => {
    const app = { publish: vi.fn(() => true) };
    const adapter = new LocalEventAdapter(app, new Map());

    adapter.publish({ ...event, userId: "user-1" });

    expect(app.publish).toHaveBeenCalledWith(
      "demo-app/public-updates",
      JSON.stringify({
        event: "demo.event",
        channel: "public-updates",
        data: event.data,
        user_id: "user-1",
      }),
    );
  });

  test("temporarily unsubscribes an excluded subscriber and safely restores it", () => {
    const socket = createSocket([event.channel]);
    const app = {
      publish: vi.fn(() => {
        expect(socket.unsubscribe).toHaveBeenCalledWith(
          "demo-app/public-updates",
        );
        expect(socket.subscribe).not.toHaveBeenCalled();
        return true;
      }),
    };
    const adapter = new LocalEventAdapter(
      app,
      new Map([["123.456", socket]]),
    );

    adapter.publish({ ...event, excludeSocket: "123.456" });

    expect(socket.subscribe).toHaveBeenCalledWith("demo-app/public-updates");
  });

  test("does not touch absent, unsubscribed, or closed excluded sockets", () => {
    for (const socket of [createSocket([]), createSocket([event.channel], true)]) {
      const app = { publish: vi.fn(() => true) };
      const adapter = new LocalEventAdapter(
        app,
        new Map([["123.456", socket]]),
      );

      adapter.publish({ ...event, excludeSocket: "123.456" });

      expect(socket.unsubscribe).not.toHaveBeenCalled();
      expect(socket.subscribe).not.toHaveBeenCalled();
    }

    const app = { publish: vi.fn(() => true) };
    new LocalEventAdapter(app, new Map()).publish({
      ...event,
      excludeSocket: "missing.1",
    });
    expect(app.publish).toHaveBeenCalledOnce();
  });

  test("does not resubscribe a socket that closes during synchronous publish", () => {
    const socket = createSocket([event.channel]);
    const app = {
      publish: vi.fn(() => {
        socket.getUserData().closed = true;
        return true;
      }),
    };
    const adapter = new LocalEventAdapter(
      app,
      new Map([["123.456", socket]]),
    );

    adapter.publish({ ...event, excludeSocket: "123.456" });

    expect(socket.unsubscribe).toHaveBeenCalledOnce();
    expect(socket.subscribe).not.toHaveBeenCalled();
  });
});

function createSocket(
  subscriptions: string[],
  closed = false,
): LocalEventSocket & {
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  const data = { closed, subscriptions: new Set(subscriptions) };
  return {
    getUserData: () => data,
    subscribe: vi.fn(() => true),
    unsubscribe: vi.fn(() => true),
  };
}
