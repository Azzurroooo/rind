import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginGate } from "./LoginGate.jsx";
import { dropCredentials, fetchTicket, loginErrorMessage, TICKET_KEY } from "../ticket.js";

afterEach(cleanup);

// Harness mirrors App.jsx's submit wiring so the test exercises the real
// login error path: submit → GET /ticket → inline error on failure.
function Harness({ fetchImpl }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <LoginGate
      busy={busy}
      error={error}
      onSubmit={async (token) => {
        setBusy(true);
        try {
          const ticket = await fetchTicket(token, { fetchImpl });
          window.sessionStorage.setItem(TICKET_KEY, ticket);
        } catch (caught) {
          setError(loginErrorMessage(caught));
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

beforeEach(() => {
  dropCredentials();
  window.sessionStorage.clear();
});

describe("LoginGate — J1 first connection and login", () => {
  it("renders a single password card with description and no app chrome", () => {
    render(<LoginGate onSubmit={() => {}} />);
    expect(screen.getByLabelText("访问令牌")).not.toBeNull();
    expect(screen.getByLabelText("访问令牌").type).toBe("password");
    expect(screen.getByText(/访问令牌以建立连接/)).not.toBeNull();
    expect(screen.queryByText("Sessions")).toBeNull();
    expect(document.querySelector(".workspace-grid")).toBeNull();
  });

  it("submit button is disabled without a token", () => {
    render(<LoginGate onSubmit={() => {}} />);
    expect(screen.getByTitle("连接 worker").disabled).toBe(true);
  });

  it("401 from GET /ticket shows an inline error, preserves input, stores nothing, never navigates", async () => {
    const urlBefore = window.location.href;
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401 }));
    render(<Harness fetchImpl={fetchImpl} />);

    const input = screen.getByLabelText("访问令牌");
    fireEvent.change(input, { target: { value: "wrong-token" } });
    fireEvent.click(screen.getByTitle("连接 worker"));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("令牌无效"));
    expect(fetchImpl).toHaveBeenCalledWith("/ticket", expect.objectContaining({ method: "GET", headers: { Authorization: "Bearer wrong-token" } }));

    // Input preserved, no navigation, no credential persisted anywhere.
    expect(screen.getByLabelText("访问令牌").value).toBe("wrong-token");
    expect(window.sessionStorage.getItem(TICKET_KEY)).toBeNull();
    expect(window.localStorage.getItem(TICKET_KEY)).toBeNull();
    expect(window.location.href).toBe(urlBefore);
    expect(document.querySelector(".modal-backdrop")).toBeNull();
  });

  it("network failure renders the inline network error via the same path", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("network unreachable"), { status: 0 });
    });
    render(<Harness fetchImpl={fetchImpl} />);
    fireEvent.change(screen.getByLabelText("访问令牌"), { target: { value: "tok" } });
    fireEvent.click(screen.getByTitle("连接 worker"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("无法连接服务器"));
  });

  it("success stores the ticket in sessionStorage only (never localStorage)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ticket: "t-123" }) }));
    render(<Harness fetchImpl={fetchImpl} />);
    fireEvent.change(screen.getByLabelText("访问令牌"), { target: { value: "good-token" } });
    fireEvent.click(screen.getByTitle("连接 worker"));
    await waitFor(() => expect(window.sessionStorage.getItem(TICKET_KEY)).toBe("t-123"));
    expect(window.localStorage.getItem(TICKET_KEY)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an externally provided error inline (e.g. stale ticket on page load)", () => {
    render(<LoginGate onSubmit={() => {}} error="登录已失效，请重新输入令牌。" />);
    expect(screen.getByRole("alert").textContent).toBe("登录已失效，请重新输入令牌。");
  });
});
