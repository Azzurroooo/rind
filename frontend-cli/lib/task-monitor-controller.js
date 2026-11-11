import { taskMonitorFrame } from "./rendering.js";
import { runtimeMethods } from "./runtime-protocol.js";

const ACTIVE = new Set(["starting", "running", "cancelling"]);
const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out", "lost"]);

function summary(task, previous = {}, legacy = false) {
  if (TERMINAL.has(previous.status) && !TERMINAL.has(task.status)) return previous;
  const { stdout, stderr, output, meta, ...fields } = task;
  return {
    ...previous,
    ...fields,
    bg_id: task.task_id || task.bg_id,
    handoff: legacy || Boolean(previous.handoff || task.handoff),
  };
}

function parseObject(value) {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function createTaskMonitorController({ request, state, redraw = () => {}, log = () => {}, notify = log, terminalUi = false }) {
  const tasks = new Map();
  let monitor = null;
  let monitorInputWasActive = false;
  let refreshTimer = null;
  let monitorTimer = null;
  let listInFlight = null;
  let listUpdates = null;
  let readInFlight = false;
  let preview = null;
  let generation = 0;
  let selectionVersion = 0;
  let listLoading = false;
  let listError = "";
  let orderedItems = null;

  const supportsTasks = () => state.sessionInfo?.capabilities?.includes("rind/tasks") === true;
  const items = () => orderedItems ??= [...tasks.values()]
    .filter((task) => ACTIVE.has(task.status) && (task.handoff || supportsTasks()))
    .sort((a, b) => Number(Boolean(a.handoff)) - Number(Boolean(b.handoff))
      || (Number(b.started_at) || 0) - (Number(a.started_at) || 0)
      || String(a.bg_id).localeCompare(String(b.bg_id)));
  const selected = () => tasks.get(monitor?.selectedId) || items()[0] || null;
  const backgroundCount = () => [...tasks.values()].filter((task) => task.handoff && ACTIVE.has(task.status)).length;

  function nearest(before, after, id) {
    if (after.some((item) => item.bg_id === id)) return id;
    const index = Math.max(0, before.findIndex((item) => item.bg_id === id));
    return after[Math.min(index, after.length - 1)]?.bg_id || null;
  }

  function reconcileMonitor(oldItems, { allowAutoExit = true } = {}) {
    if (!monitor) return;
    const nextItems = items();
    if (allowAutoExit && !nextItems.length && !listLoading && !listError) {
      exitMonitor();
      return;
    }
    const previousId = monitor.selectedId;
    monitor.selectedId = nearest(oldItems, nextItems, previousId);
    if (monitor.selectedId !== previousId) {
      monitor.previewOffset = 0;
      selectionVersion += 1;
      preview = null;
      if (monitor.selectedId) void readPreview();
    } else if (preview?.id !== monitor.selectedId) {
      preview = null;
    }
    redraw();
  }

  function upsert(task, legacy = false, { allowAutoExit = true } = {}) {
    const id = String(task?.task_id || task?.bg_id || "").trim();
    if (!id) return;
    const oldItems = monitor ? items() : [];
    const next = summary(task, tasks.get(id), legacy);
    if (TERMINAL.has(next.status) || !ACTIVE.has(next.status)) {
      tasks.delete(id);
    } else {
      tasks.set(id, next);
    }
    orderedItems = null;
    reconcileMonitor(oldItems, { allowAutoExit });
    updateCount();
  }

  function evictOriginCall(callId) {
    const target = String(callId || "").trim();
    if (!target) return;
    listUpdates?.add(`call:${target}`);
    let removed = false;
    const oldItems = monitor ? items() : [];
    for (const [id, item] of tasks.entries()) {
      if (!item.handoff && item.origin_tool_call_id === target) {
        tasks.delete(id);
        removed = true;
      }
    }
    if (!removed) return;
    orderedItems = null;
    reconcileMonitor(oldItems);
    updateCount();
  }

  function recordTask(event) {
    const task = event?.task;
    if (!task?.task_id || (event.session_id && event.session_id !== state.sessionInfo?.session_id)) return;
    listUpdates?.add(task.task_id);
    if (task.origin_tool_call_id && TERMINAL.has(task.status)) {
      listUpdates?.add(`call:${task.origin_tool_call_id}`);
    }
    const previous = tasks.get(task.task_id);
    const oldStatus = previous?.status;
    const isHandoff = Boolean(task.handoff || previous?.handoff);
    upsert(task);
    const current = tasks.get(task.task_id);
    if (monitor && monitor.selectedId === task.task_id && current) {
      if (event.type === "task_output") {
        if (!readInFlight && !monitor.previewOffset) {
          preview = { id: task.task_id, stdout: String(task.stdout || ""), stderr: String(task.stderr || ""), limited: true };
          redraw();
        }
      } else if (!preview) {
        void readPreview();
      }
    }
    if (!terminalUi && event.type === "task_updated" && isHandoff && oldStatus !== task.status) {
      notify(`Task ${task.task_id}: ${task.status}${task.notify ? ` (${task.notify})` : ""}`);
    }
  }

  async function controlSelected(action) {
    if (!supportsTasks() || !monitor) return;
    const task = selected();
    if (!task) return;
    if (action === "release" && task.handoff) return;
    if (action === "cancel" && !task.handoff) return;
    const currentGeneration = generation;
    const sessionId = state.sessionInfo?.session_id;
    try {
      const result = await request(
        action === "release" ? runtimeMethods.taskReleaseWait : runtimeMethods.taskCancel,
        { task_id: task.bg_id },
      );
      if (generation !== currentGeneration || state.sessionInfo?.session_id !== sessionId) return;
      if (action === "release" && result?.released) {
        await refresh();
        if (generation === currentGeneration && monitor) void readPreview();
      }
      if (result?.task_id) recordTask({ type: "task_updated", task: result });
    } catch (error) {
      if (generation !== currentGeneration) return;
      notify(`Task control failed: ${error instanceof Error ? error.message : String(error)}`, { level: "error" });
    }
  }

  function refresh() {
    if (!terminalUi || state.runtimeClosing) return Promise.resolve();
    if (listInFlight) return listInFlight;
    const currentGeneration = generation;
    listLoading = true;
    listError = "";
    const updates = new Set();
    listUpdates = updates;
    const promise = (async () => {
      let token = null;
      const seen = new Set();
      const listedIds = new Set();
      let completedAllPages = false;
      try {
        do {
          const response = await request(
            supportsTasks() ? runtimeMethods.taskList : runtimeMethods.backgroundList,
            token ? { page_token: token } : {},
          );
          if (generation !== currentGeneration) return;
          const oldItems = monitor ? items() : [];
          let changed = false;
          for (const task of Array.isArray(response?.tasks) ? response.tasks : []) {
            const id = String(task?.task_id || task?.bg_id || "").trim();
            if (!id) continue;
            listedIds.add(id);
            const originId = task?.origin_tool_call_id ? `call:${task.origin_tool_call_id}` : "";
            if (!updates.has(id) && !(originId && updates.has(originId))) {
              const next = summary(task, tasks.get(id), !supportsTasks());
              if (TERMINAL.has(next.status) || !ACTIVE.has(next.status)) {
                changed = tasks.delete(id) || changed;
              } else {
                tasks.set(id, next);
                changed = true;
              }
            }
          }
          if (changed) {
            orderedItems = null;
            reconcileMonitor(oldItems, { allowAutoExit: false });
            updateCount();
          }
          token = supportsTasks() ? response?.next_page_token || null : null;
          if (token && seen.has(token)) throw new Error("Repeated task page token");
          if (token) seen.add(token);
        } while (token);
        completedAllPages = true;
      } catch (error) {
        if (generation === currentGeneration) {
          listError = `Task list incomplete: ${error instanceof Error ? error.message : String(error)}`;
        }
      } finally {
        if (generation === currentGeneration) {
          listLoading = false;
          listUpdates = null;
          if (completedAllPages) {
            const oldItems = monitor ? items() : [];
            let pruned = false;
            for (const id of Array.from(tasks.keys())) {
              if (!listedIds.has(id) && !updates.has(id)) {
                tasks.delete(id);
                pruned = true;
              }
            }
            if (pruned) orderedItems = null;
            updateCount();
            if (monitor) {
              reconcileMonitor(oldItems, { allowAutoExit: pruned || updates.size > 0 });
            }
          }
          if (monitor) redraw();
        }
      }
    })().finally(() => { if (listInFlight === promise) listInFlight = null; });
    listInFlight = promise;
    return promise;
  }

  function updateCount() {
    const count = backgroundCount();
    if (Number(state.sessionInfo?.background_count) !== count) {
      state.sessionInfo = { ...state.sessionInfo, background_count: count };
      redraw();
    }
    if (count && !supportsTasks() && !refreshTimer && !state.runtimeClosing) {
      refreshTimer = setInterval(() => { void refresh(); }, 1000);
      refreshTimer.unref?.();
    } else if (!count && refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function clear() {
    generation += 1;
    selectionVersion += 1;
    listInFlight = null;
    listUpdates = null;
    tasks.clear();
    orderedItems = null;
    preview = null;
    listLoading = false;
    listError = "";
    if (monitor) {
      monitor.selectedId = null;
      monitor.previewOffset = 0;
    }
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    updateCount();
  }

  function recordResult(event) {
    if (event?.tool_call_id) {
      evictOriginCall(event.tool_call_id);
    }
    const parsed = parseObject(event?.result);
    const data = parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
    if (!data?.task_id && !data?.bg_id) return;
    if (supportsTasks() && data.task_id) {
      recordTask({ ...event, type: "task_updated", task: data });
      return;
    }
    upsert(data, !supportsTasks());
    if (monitor?.selectedId === (data.task_id || data.bg_id)) void readPreview();
  }

  function enterMonitor() {
    if (monitor || state.runtimeClosing) return;
    monitorInputWasActive = state.inputActive;
    monitor = { selectedId: items()[0]?.bg_id || null, previewOffset: 0 };
    const openedMonitor = monitor;
    state.inputActive = true;
    const refreshing = refresh();
    redraw(true);
    void refreshing.then(() => {
      if (monitor !== openedMonitor) return;
      const currentItems = items();
      if (!currentItems.length && !listError) {
        exitMonitor();
        notify("No background tasks. Press Left from an empty prompt for team tasks.");
        return;
      }
      monitor.selectedId ??= currentItems[0]?.bg_id || null;
      if (!supportsTasks() && !monitorTimer) {
        monitorTimer = setInterval(() => { void readPreview(); }, 500);
        monitorTimer.unref?.();
      }
      void readPreview();
      redraw();
    });
  }

  function exitMonitor() {
    if (monitorTimer) clearInterval(monitorTimer);
    monitorTimer = null;
    selectionVersion += 1;
    preview = null;
    monitor = null;
    state.inputActive = monitorInputWasActive;
    redraw(true);
  }

  async function readPreview() {
    if (!monitor || state.runtimeClosing || readInFlight) return;
    const id = selected()?.bg_id;
    if (!id) return;
    const currentGeneration = generation;
    const version = selectionVersion;
    readInFlight = true;
    try {
      const response = await request(
        supportsTasks() ? runtimeMethods.taskRead : runtimeMethods.backgroundOutput,
        { [supportsTasks() ? "task_id" : "bg_id"]: id, max_output_chars: 20000 },
      );
      const task = supportsTasks() ? response : response?.task;
      if (
        generation === currentGeneration &&
        monitor &&
        monitor.selectedId === id &&
        selectionVersion === version &&
        task &&
        typeof task === "object"
      ) {
        upsert(task, !supportsTasks());
        if (monitor && monitor.selectedId === id && tasks.has(id)) {
          preview = {
            id,
            stdout: String(task.stdout || task.output || ""),
            stderr: String(task.stderr || ""),
            limited: Boolean(task.meta?.truncated || task.meta?.output_incomplete || task.truncated),
            expired: Boolean(task.meta?.output_incomplete),
          };
          redraw();
        }
      }
    } catch (error) {
      if (generation === currentGeneration && monitor?.selectedId === id && selectionVersion === version) {
        preview = { id, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) };
        redraw();
      }
    } finally {
      readInFlight = false;
      if (monitor && (generation !== currentGeneration || selectionVersion !== version)) {
        void readPreview();
      }
    }
  }

  function selectionChanged() {
    monitor.previewOffset = 0;
    selectionVersion += 1;
    preview = null;
    void readPreview();
    redraw();
  }

  function moveSelection(delta) {
    if (!monitor) return;
    const currentItems = items();
    if (!currentItems.length) return;
    const index = Math.max(0, currentItems.findIndex((item) => item.bg_id === monitor.selectedId));
    const next = ((index + delta) % currentItems.length + currentItems.length) % currentItems.length;
    monitor.selectedId = currentItems[next].bg_id;
    selectionChanged();
  }

  function handleInput(key) {
    if (!monitor) return true;
    const modified = key.ctrl || key.alt || key.shift;
    if ((!modified && key.name === "escape") || (key.ctrl && key.name === "b")) { exitMonitor(); return true; }
    if (modified) return true;
    if (key.text === "r") { void controlSelected("release"); return true; }
    if (key.text === "c") { void controlSelected("cancel"); return true; }
    if (key.name === "up" || key.text === "k") { moveSelection(-1); return true; }
    if (key.name === "down" || key.text === "j") { moveSelection(1); return true; }
    if (key.name === "pageup") { monitor.previewOffset += 6; redraw(); return true; }
    if (key.name === "pagedown") { monitor.previewOffset = Math.max(0, monitor.previewOffset - 6); redraw(); return true; }
    if (key.name === "end") { monitor.previewOffset = 0; redraw(); return true; }
    return true;
  }

  function frame(width, height = 24) {
    const currentItems = items();
    const current = selected();
    const index = Math.max(0, currentItems.findIndex((item) => item.bg_id === current?.bg_id));
    return taskMonitorFrame({
      backgroundCount: backgroundCount(),
      items: currentItems,
      index,
      selected: current,
      preview: preview?.id === current?.bg_id ? preview : null,
      previewOffset: monitor?.previewOffset || 0,
      loading: listLoading,
      error: listError,
      width,
      height,
    });
  }

  function stop() {
    generation += 1;
    selectionVersion += 1;
    if (refreshTimer) clearInterval(refreshTimer);
    if (monitorTimer) clearInterval(monitorTimer);
    refreshTimer = null;
    monitorTimer = null;
    monitor = null;
    preview = null;
    tasks.clear();
    orderedItems = null;
  }

  return {
    recordTask,
    refresh,
    recordResult,
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
