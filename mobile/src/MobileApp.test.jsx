import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  hostStore: { list: vi.fn(), token: vi.fn(), save: vi.fn(), forget: vi.fn(), clearToken: vi.fn() },
  installNativeUI: vi.fn(() => () => {}), isNative: true, scanPairing: vi.fn(),
  shareConversation: vi.fn(), subscribeLifecycle: vi.fn(), ticketFetch: vi.fn(),
}));
vi.mock("./native.js", () => native);
vi.mock("@surface/App.jsx", () => ({ default: ({ platform }) => <div><span>Connected to {platform.endpoint}</span><button onClick={platform.onSignOut}>Sign out</button></div> }));
import MobileApp from "./MobileApp.jsx";
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  native.hostStore.list.mockResolvedValue([]);
  native.hostStore.token.mockResolvedValue(null);
  native.hostStore.clearToken.mockResolvedValue();
  native.ticketFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ticket: "temporary" }) });
  native.hostStore.save.mockImplementation(async (host) => ({ ...host, id: "host1" }));
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
});
afterEach(cleanup);
async function add() { render(<MobileApp />); await waitFor(() => expect(screen.getByRole("button", { name: "Add computer" }).disabled).toBe(false)); fireEvent.click(screen.getByRole("button", { name: "Add computer" })); }
it("pairs from a Desktop link, removes the secret from the address, and injects a remote surface", async () => {
  await add();
  const address = screen.getByLabelText("Server address or sign-in link");
  fireEvent.change(address, { target: { value: "http://192.168.1.2:8766/#connect=secret" } });
  expect(address.value).toBe("http://192.168.1.2:8766"); expect(screen.getByLabelText("Access code").value).toBe("secret");
  fireEvent.click(screen.getByRole("button", { name: "Connect", exact: true }));
  await screen.findByText("Connected to ws://192.168.1.2:8766/ws");
  expect(native.ticketFetch).toHaveBeenCalledWith("http://192.168.1.2:8766/ticket", expect.objectContaining({ headers: { Authorization: "Bearer secret" } }));
  expect(native.hostStore.save).toHaveBeenCalledWith({ name: "", origin: "http://192.168.1.2:8766" }, "secret", true);
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByRole("heading", { name: "Connect a computer" });
  expect(native.hostStore.clearToken).toHaveBeenCalledWith("host1");
});
it("does not save an invalid access code and preserves the form for retry", async () => {
  native.ticketFetch.mockResolvedValue({ ok: false, status: 401 }); await add();
  fireEvent.change(screen.getByLabelText("Server address or sign-in link"), { target: { value: "https://work.test" } });
  fireEvent.change(screen.getByLabelText("Access code"), { target: { value: "bad" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect", exact: true }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/invalid or expired/);
  expect(native.hostStore.save).not.toHaveBeenCalled(); expect(screen.getByLabelText("Access code").value).toBe("bad");
});
it("QR scan only fills the confirmation form and never automatically connects", async () => {
  native.scanPairing.mockResolvedValue("https://work.test/#connect=secret"); render(<MobileApp />);
  fireEvent.click(screen.getByRole("button", { name: "Scan QR code" }));
  await screen.findByRole("heading", { name: "Connect a computer" });
  expect(screen.getByLabelText("Server address or sign-in link").value).toBe("https://work.test");
  expect(native.ticketFetch).not.toHaveBeenCalled();
});
it("lets the user cancel forgetting and reports storage errors inline", async () => {
  native.hostStore.list.mockResolvedValue([{ id: "one", name: "Work", origin: "https://work.test" }]);
  native.hostStore.forget.mockRejectedValue(new Error("Storage unavailable")); render(<MobileApp />);
  fireEvent.click(await screen.findByRole("button", { name: "Forget Work" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(native.hostStore.forget).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Forget Work" }));
  fireEvent.click(screen.getByRole("button", { name: "Forget computer", exact: true }));
  expect((await screen.findByRole("alert")).textContent).toBe("Storage unavailable");
});
