import { backgroundMonitorText, delegateMonitorText } from "./rendering.js";

const PAGES = ["background", "delegates"];

export function createTaskMonitorController({
  request,
  state,
  redraw = () => {},
  log = () => {},
  terminalUi = false,
}) {
  const tasks = new Map();
  const pendingCommands = new Map();
  const delegates = new Map();
  let refreshTimer = null;
  let listInFlight = null;
  let monitorTimer = null;
  let monitorPollInFlight = false;
  let monitor = null;
  let monitorInputWasActive = false;

  function refresh() {
    if (!terminalUi || state.runtimeClosing) {
      return Promise.resolve();
    }
    if (listInFlight) {
      return listInFlight;
    }
    listInFlight = request("background.list")
      .then((result) => {
        const listed = Array.isArray(result?.tasks) ? result.tasks : [];
        const ids = new Set();
        for (const task of listed) {
          const bgId = String(task?.bg_id || "").trim();
          if (!bgId) {
            continue;
          }
          ids.add(bgId);
          tasks.set(bgId, { ...(tasks.get(bgId) || {}), ...task, bg_id: bgId });
        }
        for (const bgId of tasks.keys()) {
          if (!ids.has(bgId) && tasks.get(bgId)?.status === "running") {
            tasks.delete(bgId);
          }
        }
        updateCount();
        if (monitor) {
          monitor.selectedIndex = clampIndex(monitor.selectedIndex);
          if (!pageItems(monitor.page).length && pageItems(otherPage(monitor.page)).length) {
            monitor.page = otherPage(monitor.page);
            monitor.selectedIndex = 0;
          }
          redraw(true);
        }
      })
      .finally(() => {
        listInFlight = null;
      });
    return listInFlight;
  }

  function updateCount() {
    const count = [...tasks.values()].filter((task) => task.status === "running").length;
    if (Number(state.sessionInfo?.background_count) !== count) {
      state.sessionInfo = { ...state.sessionInfo, background_count: count };
      redraw();
    }
    if (count > 0) {
      startRefresh();
    } else {
      stopRefresh();
    }
  }

  function startRefresh() {
    if (refreshTimer || state.runtimeClosing) {
      return;
    }
    refreshTimer = setInterval(() => {
      void refresh().catch(() => {});
    }, 1000);
    refreshTimer.unref?.();
  }

  function stopRefresh() {
    if (!refreshTimer) {
      return;
    }
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  function clear() {
    tasks.clear();
    pendingCommands.clear();
    delegates.clear();
    stopRefresh();
    updateCount();
  }

  function clearDelegates() {
    delegates.clear();
    if (monitor?.page === "delegates") {
      monitor.selectedIndex = 0;
      redraw(true);
    }
  }

  function recordCommand(event) {
    if (event?.tool_name !== "bash" || !event.tool_call_id) {
      return;
    }
    const args = parseObject(event.args_preview);
    if (args.command) {
      pendingCommands.set(event.tool_call_id, String(args.command));
    }
  }

  function recordResult(event) {
    const parsed = parseObject(event?.result);
    const data = parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
    const bgId = String(data?.bg_id || "").trim();
    if (!bgId) {
      return;
    }
    const previous = tasks.get(bgId) || {};
    const command = pendingCommands.get(event.tool_call_id) || previous.command || "";
    tasks.set(bgId, { ...previous, ...data, bg_id: bgId, command });
    if (event.tool_call_id) {
      pendingCommands.delete(event.tool_call_id);
    }
    updateCount();
    void pollMonitor();
  }

  function recordDelegateRequest(event) {
    if (event?.tool_name !== "delegate" || !event.tool_call_id) {
      return;
    }
    const args = parseObject(event.args_preview);
    const agentId = String(args.agent_id || "").trim();
    if (!agentId) {
      return;
    }
    delegates.set(event.tool_call_id, {
      agent_id: agentId,
      task: String(args.task || "").trim(),
      status: "running",
      summary: "",
    });
    if (monitor?.page === "delegates") {
      monitor.selectedIndex = clampIndex(monitor.selectedIndex);
      redraw(true);
    }
  }

  function recordDelegateResult(event) {
    if (event?.tool_name !== "delegate" || !event.tool_call_id) {
      return;
    }
    const previous = delegates.get(event.tool_call_id);
    if (!previous) {
      return;
    }
    const parsed = parseObject(event.result);
    const data = parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
    const status = String(data.status || event.status || "completed").trim();
    const summary = String(data.summary || "").trim();
    delegates.set(event.tool_call_id, { ...previous, status, summary });
    if (monitor?.page === "delegates") {
      redraw(true);
    }
  }

  function enterMonitor() {
    if (monitor || state.runtimeClosing) {
      return;
    }
    monitorInputWasActive = state.inputActive;
    monitor = { page: initialPage(), selectedIndex: 0, pageChanged: false };
    state.inputActive = true;
    redraw(true);
    void refresh()
      .then(() => {
        if (!monitor) {
          return;
        }
        if (!tasks.size && !delegates.size) {
          exitMonitor();
          log("No background tasks or delegates.");
          return;
        }
        if (!monitor.pageChanged) {
          monitor.page = initialPage();
        }
        monitor.selectedIndex = clampIndex(monitor.selectedIndex);
        startMonitorPolling();
        void pollMonitor();
        redraw(true);
      })
      .catch((error) => {
        if (!monitor || state.runtimeClosing) {
          return;
        }
        exitMonitor();
        log(`Task monitor failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  function exitMonitor() {
    stopMonitorPolling();
    monitor = null;
    state.inputActive = monitorInputWasActive;
    redraw(true);
  }

  function startMonitorPolling() {
    if (monitorTimer) {
      return;
    }
    monitorTimer = setInterval(() => {
      void pollMonitor();
    }, 500);
    monitorTimer.unref?.();
  }

  function stopMonitorPolling() {
    if (!monitorTimer) {
      return;
    }
    clearInterval(monitorTimer);
    monitorTimer = null;
  }

  async function pollMonitor() {
    if (!monitor || monitor.page !== "background" || monitorPollInFlight || state.runtimeClosing) {
      return;
    }
    const available = pageItems("background");
    if (!available.length) {
      return;
    }
    monitor.selectedIndex = clampIndex(monitor.selectedIndex);
    const selected = available[monitor.selectedIndex];
    if (!selected?.bg_id) {
      return;
    }
    monitorPollInFlight = true;
    try {
      const result = await request("background.output", {
        bg_id: selected.bg_id,
        max_output_chars: 20000,
      });
      if (result?.task && typeof result.task === "object") {
        tasks.set(selected.bg_id, {
          ...selected,
          ...result.task,
          command: selected.command || "",
        });
        updateCount();
        redraw();
      }
    } catch {
      // Periodic list refresh reconciles expired tasks without interrupting input.
    } finally {
      monitorPollInFlight = false;
    }
  }

  function moveSelection(delta) {
    if (!monitor) {
      return;
    }
    const count = pageItems(monitor.page).length;
    if (!count) {
      return;
    }
    const current = clampIndex(monitor.selectedIndex);
    monitor.selectedIndex = (current + delta + count) % count;
    void pollMonitor();
    redraw();
  }

  function switchPage(delta) {
    if (!monitor) {
      return;
    }
    const current = PAGES.indexOf(monitor.page);
    monitor.page = PAGES[(current + delta + PAGES.length) % PAGES.length];
    monitor.pageChanged = true;
    monitor.selectedIndex = clampIndex(monitor.selectedIndex);
    void pollMonitor();
    redraw(true);
  }

  function handleInput(key) {
    const modified = key.ctrl || key.alt || key.shift;
    if (!modified && key.name === "escape") {
      exitMonitor();
      return true;
    }
    if (key.ctrl && key.name === "b") {
      exitMonitor();
      return true;
    }
    if (!modified && key.name === "left") {
      switchPage(-1);
      return true;
    }
    if (!modified && key.name === "right") {
      switchPage(1);
      return true;
    }
    if (modified) {
      return true;
    }
    if (key.name === "up" || key.text === "k") {
      moveSelection(-1);
      return true;
    }
    if (key.name === "down" || key.text === "j") {
      moveSelection(1);
      return true;
    }
    return true;
  }

  function frame(width) {
    const page = monitor?.page || initialPage();
    const list = pageItems(page);
    const selectedIndex = clampIndex(monitor?.selectedIndex, page);
    const text = page === "delegates"
      ? delegateMonitorText(list, selectedIndex, list[selectedIndex], Math.max(20, Number(width) - 4))
      : backgroundMonitorText(list, selectedIndex, list[selectedIndex], Math.max(20, Number(width) - 4));
    const lines = text.split("\n");
    const selectedRow = list.length ? 2 + selectedIndex : Math.max(0, lines.length - 1);
    return {
      lines,
      cursorRow: Math.min(selectedRow, Math.max(0, lines.length - 1)),
      cursorColumn: 0,
      focusRow: Math.min(selectedRow, Math.max(0, lines.length - 1)),
    };
  }

  function stop() {
    stopRefresh();
    stopMonitorPolling();
    monitor = null;
    pendingCommands.clear();
    tasks.clear();
    delegates.clear();
  }

  function pageItems(page) {
    return page === "delegates" ? [...delegates.values()] : [...tasks.values()];
  }

  function initialPage() {
    return tasks.size ? "background" : "delegates";
  }

  function otherPage(page) {
    return page === "delegates" ? "background" : "delegates";
  }

  function clampIndex(index, page = monitor?.page || "background") {
    const count = pageItems(page).length;
    if (!count) {
      return 0;
    }
    return Math.min(count - 1, Math.max(0, Number(index) || 0));
  }

  return {
    refresh,
    recordCommand,
    recordResult,
    recordDelegateRequest,
    recordDelegateResult,
    clearDelegates,
    enterMonitor,
    exitMonitor,
    handleInput,
    clear,
    stop,
    frame,
    isMonitoring: () => Boolean(monitor),
    moveSelection,
  };
}

function parseObject(value) {
  if (value && typeof value === "object") {
    return value;
  }
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
