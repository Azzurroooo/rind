import { describe, expect, it } from "vitest";
import { memoryCredentials, parsePairing } from "./pairing.js";

describe("pairing trust boundary", () => {
  it("consumes the existing Desktop QR format without retaining a credential in the address", () => {
    expect(parsePairing("http://192.168.1.20:8766/#connect=abc_123")).toEqual({ origin: "http://192.168.1.20:8766", endpoint: "ws://192.168.1.20:8766/ws", token: "abc_123" });
  });
  it("accepts app links and HTTPS hosts", () => {
    expect(parsePairing("rind://connect?address=https%3A%2F%2Frind.example.com#connect=secret")).toEqual({ origin: "https://rind.example.com", endpoint: "wss://rind.example.com/ws", token: "secret" });
    expect(parsePairing("rind.example.com", "token").origin).toBe("https://rind.example.com");
    expect(parsePairing("192.168.0.3:8766").origin).toBe("http://192.168.0.3:8766");
  });
  it.each([
    "javascript:alert(1)", "file:///etc/passwd", "https://user:secret@host.test",
    "https://host.test/path", "https://host.test/?token=secret", "http://public.example.com",
    "http://8.8.8.8", "http://172.32.0.1", "https://host.test/#other=secret",
    "https://host.test/#connect=a&connect=b", "rind://evil?address=https://host.test",
    "rind://user@connect?address=https://host.test", "rind://connect?address=https://a.test&address=https://b.test",
  ])("rejects ambiguous or unsafe input %s", (input) => expect(() => parsePairing(input)).toThrow());
  it("isolates credentials per host and drops them without persistence", () => {
    const store = memoryCredentials("one", "wss://one/ws");
    expect(store.readStoredToken("wss://two/ws")).toBe("");
    store.storeToken("two", "wss://two/ws");
    expect(store.readStoredToken("wss://one/ws")).toBe("one");
    store.dropCredentials();
    expect(store.hasStoredCredential("wss://one/ws")).toBe(false);
  });
});
