import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { BearerConnectionProfile, type ConnectionCatalogEntry } from "../connection/catalog.ts";
import { BearerConnectionTarget } from "../connection/model.ts";
import { createManagedPluginConnections, type ManagedPluginEnvironment } from "./managed.ts";
const controller = EnvironmentId.make("controller");
const guest = EnvironmentId.make("guest");
const owner = { environmentId: controller, pluginId: "sandboxes" };
const source = (input: Partial<ManagedPluginEnvironment> = {}): ManagedPluginEnvironment => ({
  id: "guest",
  kind: "environment",
  environmentId: guest,
  label: "Guest",
  url: "https://guest.test",
  state: "running",
  connect: { id: "pair", label: "Connect", command: "pair", input: {} },
  owner,
  command: {
    pluginId: "sandboxes",
    commandId: "pair",
    permission: "environment:maintain",
    input: {},
  },
  ...input,
});
const saved = (managed = true): ConnectionCatalogEntry => ({
  target: new BearerConnectionTarget({
    environmentId: guest,
    label: "Guest",
    connectionId: "bearer:guest",
  }),
  profile: Option.some(
    new BearerConnectionProfile({
      environmentId: guest,
      label: "Guest",
      connectionId: "bearer:guest",
      httpBaseUrl: "https://guest.test/",
      wsBaseUrl: "wss://guest.test/",
      ...(managed ? { managedBy: owner } : {}),
    }),
  ),
  enabled: true,
});
it("registers once per client, retains stopped connections, and removes only its own deleted connection", async () => {
  const calls: string[] = [];
  const actor = createManagedPluginConnections({
    execute: async () => {
      calls.push("pair");
      return { $t3: "secret", value: "https://guest.test/pair#token=fixture" };
    },
    connect: async (input) => {
      expect(input.expectedEnvironmentId).toBe(guest);
      expect(input.managedBy).toEqual(owner);
      calls.push("connect");
    },
    remove: async () => {
      calls.push("remove");
    },
    allowLoopback: () => false,
  });
  await actor.reconcile([source()], new Map());
  expect(calls).toEqual(["pair", "connect"]);
  const entries = new Map([[guest, saved()]]);
  await actor.reconcile([source()], entries);
  await actor.reconcile([source({ state: "stopped" })], entries);
  expect(calls).toEqual(["pair", "connect"]);
  await actor.reconcile([source({ state: "deleted" })], new Map([[guest, saved(false)]]));
  expect(calls).toEqual(["pair", "connect"]);
  await actor.reconcile([source({ state: "deleted" })], entries);
  expect(calls).toEqual(["pair", "connect", "remove"]);
  actor.close();
});
it("coalesces concurrent advertisements and does not pair a sandbox deleted during token issuance", async () => {
  const token = Promise.withResolvers<unknown>();
  let requests = 0,
    connections = 0;
  const actor = createManagedPluginConnections({
    execute: () => {
      requests++;
      return token.promise;
    },
    connect: async () => {
      connections++;
    },
    remove: async () => {},
    allowLoopback: () => false,
  });
  const first = actor.reconcile([source()], new Map());
  const second = actor.reconcile([source()], new Map());
  const deleted = actor.reconcile([source({ state: "deleted" })], new Map());
  token.resolve({ $t3: "secret", value: "https://guest.test/pair#token=fixture" });
  await Promise.all([first, second, deleted]);
  expect(requests).toBe(1);
  expect(connections).toBe(0);
  actor.close();
});
it("never consumes a pairing token for a different advertised origin or a manually added machine", async () => {
  let requests = 0,
    connections = 0;
  const actor = createManagedPluginConnections({
    execute: async () => {
      requests++;
      return { $t3: "secret", value: "https://other.test/pair#token=fixture" };
    },
    connect: async () => {
      connections++;
    },
    remove: async () => {},
    allowLoopback: () => false,
    now: () => 0,
  });
  await actor.reconcile([source()], new Map([[guest, saved(false)]]));
  expect(requests).toBe(0);
  await actor.reconcile([source()], new Map());
  expect(requests).toBe(1);
  expect(connections).toBe(0);
  await actor.reconcile([source()], new Map());
  expect(requests).toBe(1);
  actor.close();
});
it("does not treat a remote controller Docker loopback address as local", async () => {
  let requests = 0;
  const actor = createManagedPluginConnections({
    execute: async () => {
      requests++;
      return null;
    },
    connect: async () => {},
    remove: async () => {},
    allowLoopback: () => true,
  });
  await actor.reconcile([source({ url: "http://127.0.0.1:1234" })], new Map());
  expect(requests).toBe(0);
  actor.close();
});
