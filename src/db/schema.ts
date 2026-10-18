import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Column names are the contract's lower_snake_case attribute names, so a
// row is already API-shaped and a history row mirrors its ODCS column.

export const clients = sqliteTable(
  "clients",
  {
    client_id: text().primaryKey(),
    walker_id: text().notNull(),
    name: text().notNull(),
    email: text(),
    phone: text(),
    address: text(),
    notes: text(),
    created_at: text().notNull(),
  },
  (t) => [index("clients_walker_created").on(t.walker_id, t.created_at)],
);

export const dogs = sqliteTable(
  "dogs",
  {
    dog_id: text().primaryKey(),
    walker_id: text().notNull(),
    client_id: text()
      .notNull()
      .references(() => clients.client_id, { onDelete: "cascade" }),
    name: text().notNull(),
    breed: text(),
    date_of_birth: text(),
    notes: text(),
    created_at: text().notNull(),
  },
  (t) => [index("dogs_walker_client").on(t.walker_id, t.client_id)],
);

export const walks = sqliteTable(
  "walks",
  {
    walk_id: text().primaryKey(),
    walker_id: text().notNull(),
    scheduled_at: text().notNull(),
    duration_minutes: integer().notNull(),
    /** JSON array of dog ids - the contract's dog_ids. */
    dog_ids: text().notNull(),
    status: text().notNull(),
    notes: text(),
    started_at: text(),
    completed_at: text(),
    cancelled_at: text(),
    cancellation_reason: text(),
    created_at: text().notNull(),
  },
  (t) => [index("walks_walker_scheduled").on(t.walker_id, t.scheduled_at)],
);

/** Transactional outbox: written in the same D1 batch as the aggregate
 * change, relayed to the queue afterwards (see the walks ADR-001). */
export const outbox = sqliteTable(
  "outbox",
  {
    event_id: text().primaryKey(),
    channel: text().notNull(),
    subject: text().notNull(),
    envelope: text().notNull(),
    created_at: text().notNull(),
    published_at: text(),
    attempts: integer().notNull().default(0),
  },
  (t) => [index("outbox_unpublished").on(t.published_at, t.created_at)],
);

// The walk history data contract (walks-events.odcs.yaml), one table per
// channel, deduplicated on event_id by INSERT OR IGNORE.

const envelopeColumns = {
  event_id: text().primaryKey(),
  event_type: text().notNull(),
  event_source: text().notNull(),
  event_time: text().notNull(),
  walk_id: text().notNull(),
  walker_id: text().notNull(),
  scheduled_at: text().notNull(),
};

export const walk_scheduled_events = sqliteTable("walk_scheduled_events", {
  ...envelopeColumns,
  duration_minutes: integer().notNull(),
  dog_ids: text().notNull(),
});

export const walk_completed_events = sqliteTable("walk_completed_events", {
  ...envelopeColumns,
  started_at: text(),
  completed_at: text().notNull(),
  duration_minutes: integer().notNull(),
  dog_ids: text().notNull(),
});

export const walk_cancelled_events = sqliteTable("walk_cancelled_events", {
  ...envelopeColumns,
  cancelled_at: text().notNull(),
  reason: text().notNull(),
});

/** Test-harness switches (AUTH_MODE=test only), e.g. publication_unavailable. */
export const test_flags = sqliteTable("test_flags", {
  key: text().primaryKey(),
  value: text().notNull(),
});
