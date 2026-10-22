import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { PluginView } from "./index.ts";

const valid = Schema.is(PluginView);
it("rejects ambiguous form and table identities before clients render them", () => {
  const form = {
    id: "settings",
    kind: "form",
    label: "Save",
    command: "save",
    input: {},
    fields: [
      { name: "token", label: "Token", kind: "password" },
      { name: "token", label: "Another token", kind: "text" },
    ],
  };
  expect(valid({ title: "Test", blocks: [form] })).toBe(false);
  const table = {
    id: "accounts",
    kind: "table",
    columns: ["Name"],
    rows: [{ id: "first", cells: ["First"], actions: [] }],
  };
  expect(valid({ title: "Test", blocks: [table] })).toBe(true);
  expect(valid({ title: "Test", blocks: [table, table] })).toBe(false);
  expect(valid({ title: "Test", blocks: [{ ...table, columns: ["Name", "Name"] }] })).toBe(false);
  expect(
    valid({ title: "Test", blocks: [{ ...table, rows: [...table.rows, ...table.rows] }] }),
  ).toBe(false);
  expect(
    valid({
      title: "Test",
      blocks: [{ ...table, rows: [{ id: "first", cells: [], actions: [] }] }],
    }),
  ).toBe(false);
});
