import { mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import net from "node:net";

const CONNECT_TIMEOUT_MS = 2000;

export function ipcEndpointName(sessionId) {
  const id = String(sessionId || "");
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error("Invalid session id.");
  }
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\rind-${id}`;
  }
  return path.join(process.env.RIND_HOME || path.join(homedir(), ".rind"), "ipc", `${id}.sock`);
}

export async function listenIpc({ sessionId, getSessionId, dispatch, net: netImpl = net, onUnavailable = () => {} }) {
  const endpoint = ipcEndpointName(sessionId);
  const server = netImpl.createServer();
  let listening = false;
  let closing = false;
  let settled = false;
  let recovering = false;

  server.on("connection", (socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      socket.removeAllListeners("data");
      respond(socket, buffer.slice(0, newlineIndex));
    });
    socket.on("error", () => {});
  });

  const ready = new Promise((resolve) => {
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    server.on("listening", () => {
      listening = true;
      settle();
    });
    server.on("error", () => {
      if (settled || recovering) {
        return;
      }
      recovering = true;
      void recover().then(settle, settle).finally(() => {
        recovering = false;
      });
    });
  });

  function respond(socket, line) {
    let input = "";
    try {
      const message = JSON.parse(line);
      if (typeof message.input === "string") {
        input = message.input;
      }
    } catch {
      return socket.end(`${JSON.stringify({ ok: false, message: "Invalid request." })}\n`);
    }
    const payload = closing
      ? { ok: false, message: "Session is shutting down." }
      : input.trim()
        ? { ok: true, session_id: String(getSessionId() || "") }
        : { ok: false, message: "Empty input." };
    socket.end(`${JSON.stringify(payload)}\n`);
    if (payload.ok) {
      dispatch(input);
    }
  }

  async function recover() {
    if (process.platform === "win32") {
      onUnavailable();
      return;
    }
    if (await probeEndpoint(netImpl, endpoint)) {
      onUnavailable();
      return;
    }
    await unlink(endpoint).catch(() => {});
    await new Promise((resolve) => {
      const onRetryError = () => {
        onUnavailable();
        resolve();
      };
      server.once("error", onRetryError);
      server.listen(endpoint, () => {
        server.removeListener("error", onRetryError);
        listening = true;
        resolve();
      });
    });
  }

  if (process.platform !== "win32") {
    await mkdir(path.dirname(endpoint), { recursive: true }).catch(() => {});
  }
  server.listen(endpoint);
  await ready;
  return {
    close() {
      closing = true;
      return new Promise((resolve) => {
        server.close(() => {
          if (process.platform !== "win32" && listening) {
            void unlink(endpoint).catch(() => {});
          }
          resolve();
        });
      });
    },
  };
}

function probeEndpoint(netImpl, endpoint) {
  return new Promise((resolve) => {
    const probe = netImpl.connect(endpoint);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

export function sendIpc({ session, input, timeoutMs = CONNECT_TIMEOUT_MS, net: netImpl = net }) {
  const endpoint = ipcEndpointName(session);
  return new Promise((resolve) => {
    const socket = netImpl.connect(endpoint);
    let timer = null;
    let settled = false;
    let buffer = "";
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      socket.destroy();
      resolve(result);
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ input: String(input || "") })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      let payload = null;
      try {
        payload = JSON.parse(buffer.slice(0, newlineIndex));
      } catch {
        payload = null;
      }
      finish(payload && typeof payload === "object" ? payload : { ok: false, message: "Invalid response from the rind session." });
    });
    socket.on("error", () => finish({ ok: false, message: notRunningMessage(session) }));
    timer = setTimeout(() => {
      finish({ ok: false, message: notRunningMessage(session) });
    }, timeoutMs);
  });
}

function notRunningMessage(sessionId) {
  return `rind session ${sessionId} is not running — the id is shown in the target session's banner and /status.`;
}
