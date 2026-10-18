/** CloudEvents 1.0 structured envelopes for the walks AsyncAPI. The shapes
 * here mirror walks.asyncapi.yaml field for field; the contract is the
 * record, this is the implementation of it. */

export const ORG = "com.hungovercoders";
export const SOURCE = "/walks";

export const CHANNELS = {
  scheduled: "walks.scheduled.v1",
  completed: "walks.completed.v1",
  cancelled: "walks.cancelled.v1",
} as const;

export const TYPES = {
  scheduled: `${ORG}.walks.scheduled.v1`,
  completed: `${ORG}.walks.completed.v1`,
  cancelled: `${ORG}.walks.cancelled.v1`,
} as const;

export type WalkScheduledData = {
  walk_id: string;
  walker_id: string;
  scheduled_at: string;
  duration_minutes: number;
  dog_ids: string[];
};

export type WalkCompletedData = {
  walk_id: string;
  walker_id: string;
  scheduled_at: string;
  started_at?: string;
  completed_at: string;
  duration_minutes: number;
  dog_ids: string[];
};

export type WalkCancelledData = {
  walk_id: string;
  walker_id: string;
  scheduled_at: string;
  cancelled_at: string;
  reason: string;
};

export type Envelope<D> = {
  specversion: "1.0";
  id: string;
  source: typeof SOURCE;
  type: string;
  subject: string;
  time: string;
  datacontenttype: "application/json";
  data: D;
};

export type WalkEvent =
  | Envelope<WalkScheduledData>
  | Envelope<WalkCompletedData>
  | Envelope<WalkCancelledData>;

export function envelope<D extends { walk_id: string }>(
  type: string,
  data: D,
  time: string,
): Envelope<D> {
  return {
    specversion: "1.0",
    id: crypto.randomUUID(),
    source: SOURCE,
    type,
    subject: data.walk_id,
    time,
    datacontenttype: "application/json",
    data,
  };
}
