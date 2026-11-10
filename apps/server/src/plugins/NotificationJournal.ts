import {
  PluginError,
  PluginNotification,
  PluginNotificationRead,
  type PluginNotificationBatch,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decodeRead = Schema.decodeUnknownEffect(PluginNotificationRead);
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginNotification));

export class NotificationJournal extends Context.Service<
  NotificationJournal,
  {
    readonly read: (
      input: PluginNotificationRead,
    ) => Effect.Effect<PluginNotificationBatch, PluginError>;
  }
>()("t3/plugins/NotificationJournal") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const read = Effect.fn("NotificationJournal.read")(
    function* (input: PluginNotificationRead) {
      const { after } = yield* decodeRead(input);
      if (after === null) {
        const rows = yield* sql<{
          cursor: number;
        }>`SELECT COALESCE(MAX(sequence), 0) AS cursor FROM notification_journal`;
        return { cursor: rows[0]?.cursor ?? 0, events: [] };
      }
      const rows = yield* sql<{ sequence: number; payload_json: string }>`
      SELECT sequence, payload_json FROM notification_journal
      WHERE sequence > ${after} ORDER BY sequence LIMIT 100
    `;
      const events = yield* Effect.forEach(rows, ({ sequence, payload_json }) =>
        decodeEvent(payload_json).pipe(Effect.map((event) => ({ ...event, sequence }))),
      );
      return { cursor: rows.at(-1)?.sequence ?? after, events };
    },
    Effect.mapError((cause) => new PluginError({ operation: "notifications-read", cause })),
  );
  return NotificationJournal.of({ read });
});

export const layer = Layer.effect(NotificationJournal, make);
