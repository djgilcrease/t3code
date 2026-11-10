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
  const collection = {
    id: "items",
    kind: "collection",
    label: "Items",
    items: [{ id: "one", label: "One", search: "", input: { selected: "one" } }],
  };
  expect(valid({ title: "Test", blocks: [collection] })).toBe(true);
  expect(
    valid({
      title: "Test",
      blocks: [{ ...collection, items: [...collection.items, ...collection.items] }],
    }),
  ).toBe(false);
  expect(
    valid({
      title: "Test",
      blocks: [
        { id: "image", kind: "image", label: "Image", source: "https://example.com/tracking.png" },
      ],
    }),
  ).toBe(false);
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

it("bounds searchable associations and rejects duplicate identities", () => {
  const item = {
    id: "repo:123",
    label: "#123",
    select: { id: "select", label: "Select", command: "select", input: {} },
  };
  const block = {
    id: "issues",
    kind: "associations",
    label: "Issues",
    selected: [],
    options: [item],
  };
  expect(valid({ title: "Issues", blocks: [block] })).toBe(true);
  expect(valid({ title: "Issues", blocks: [{ ...block, options: [item, item] }] })).toBe(false);
  expect(
    valid({
      title: "Issues",
      blocks: [
        { ...block, selected: Array.from({ length: 21 }, (_, i) => ({ ...item, id: String(i) })) },
      ],
    }),
  ).toBe(false);
});

it("bounds ordered graphs and rejects backwards edges and duplicate nodes", () => {
  const node = {
    id: "child",
    parents: ["parent"],
    label: "Child",
    detail: "Detail",
    annotation: "id",
    badges: [],
    action: { id: "open", label: "Open", command: "read", input: {} },
  };
  const graph = {
    id: "graph",
    kind: "graph",
    label: "History",
    nodes: [node, { ...node, id: "parent", parents: [] }],
  };
  expect(valid({ title: "Test", blocks: [graph] })).toBe(true);
  expect(valid({ title: "Test", blocks: [{ ...graph, nodes: [node, node] }] })).toBe(false);
  expect(valid({ title: "Test", blocks: [{ ...graph, nodes: [...graph.nodes].reverse() }] })).toBe(
    false,
  );
  expect(
    valid({ title: "Test", blocks: [{ ...graph, nodes: [{ ...node, parents: ["child"] }] }] }),
  ).toBe(false);
  expect(
    valid({
      title: "Test",
      blocks: [
        {
          ...graph,
          nodes: Array.from({ length: 101 }, (_, i) => ({ ...node, id: `node-${i}`, parents: [] })),
        },
      ],
    }),
  ).toBe(false);
});
