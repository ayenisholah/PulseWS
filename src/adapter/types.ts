export type EventPublish = {
  appId: string;
  channel: string;
  event: string;
  data: string;
  excludeSocket?: string;
  userId?: string;
  publishedAt?: number;
  originNodeId?: string;
};

export interface EventAdapter {
  initialize(): Promise<void>;
  publish(event: EventPublish): Promise<boolean>;
  receive(event: EventPublish): boolean;
  close(): Promise<void>;
}
