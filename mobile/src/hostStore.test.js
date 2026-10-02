import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHostStore } from "./hostStore.js";
let prefs, secrets, storage, store;
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  prefs = new Map(); secrets = new Map();
  storage = { get: async ({ key }) => ({ value: prefs.get(key) }), set: vi.fn(async ({ key, value }) => prefs.set(key, value)) };
  store = createHostStore(storage, { get: async (key) => secrets.get(key), set: async (key, value) => secrets.set(key, value), remove: async (key) => secrets.delete(key) });
});
it("persists only metadata outside the vault and deduplicates normalized origins", async () => {
  const a = await store.save({ name: "Work", origin: "https://work.test" }, "private-code", true);
  const b = await store.save({ name: "Renamed", origin: "https://work.test/" }, "new-code", true);
  expect(b.id).toBe(a.id); expect(await store.list()).toEqual([b]);
  expect([...prefs.values()].join()).not.toContain("code");
  expect(await store.token(a.id)).toBe("new-code");
});
it("can save and reload computers on a local HTTP origin without randomUUID", async () => {
  vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
  const a = await store.save({ name: "A", origin: "http://192.168.1.2:8766" }, "a", true);
  const b = await store.save({ name: "B", origin: "http://192.168.1.3:8766" }, "b", true);
  expect(a.id).not.toBe(b.id);
  expect(await store.list()).toEqual([b, a]);
  expect(await store.token(a.id)).toBe("a");
});
it("forgetting one computer removes only its credential and metadata", async () => {
  const a = await store.save({ name: "A", origin: "https://a.test" }, "a", true);
  const b = await store.save({ name: "B", origin: "https://b.test" }, "b", true);
  await store.forget(a.id);
  expect(await store.token(a.id)).toBeUndefined(); expect(await store.token(b.id)).toBe("b");
  expect(await store.list()).toEqual([b]);
});
it("disabling remember removes a previously saved credential", async () => {
  const a = await store.save({ name: "A", origin: "https://a.test" }, "a", true);
  await store.save(a, "b", false);
  expect(await store.token(a.id)).toBeUndefined();
});
it("does not orphan credentials if metadata cannot be persisted", async () => {
  storage.set.mockRejectedValueOnce(new Error("full"));
  await expect(store.save({ name: "A", origin: "https://a.test" }, "a", true)).rejects.toThrow("full");
  expect(secrets.size).toBe(0);
});
it("reports corrupt metadata instead of silently replacing the host list", async () => {
  prefs.set("rind.mobile.hosts.v1", "not-json");
  await expect(store.list()).rejects.toThrow("could not be read");
});
