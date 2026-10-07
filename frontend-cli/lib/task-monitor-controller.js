import { taskMonitorFrame } from "./rendering.js";
import { runtimeMethods } from "./runtime-protocol.js";

const ACTIVE = new Set(["starting", "running", "cancelling"]);
const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out", "lost"]);

function summary(task, previous = {}, legacy = false) {
  if (TERMINAL.has(previous.status) && !TERMINAL.has(task.status)) return previous;
  const { stdout, stderr, output, meta, ...fields } = task;
  return { ...previous, ...fields, bg_id: task.task_id || task.bg_id,
    handoff: legacy || Boolean(previous.handoff || task.handoff) };
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

export function createTaskMonitorController({ request, state, redraw = () => {}, log = () => {}, terminalUi = false }) {
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
  let backgroundItems = null;
  let foregroundItems = null;
  const supportsTasks = () => state.sessionInfo?.capabilities?.includes("rind/tasks") === true;
  const backgrounds = () => backgroundItems ??= [...tasks.values()].filter((task) => task.handoff)
    .sort((a, b) => Number(ACTIVE.has(b.status)) - Number(ACTIVE.has(a.status))
      || (Number(b.started_at) || 0) - (Number(a.started_at) || 0)
      || String(a.bg_id).localeCompare(String(b.bg_id)));
  const foregrounds = () => foregroundItems ??= supportsTasks() ? [...tasks.values()].filter((task) => !task.handoff && ACTIVE.has(task.status))
    .sort((a, b) => (Number(b.started_at) || 0) - (Number(a.started_at) || 0)
      || String(a.bg_id).localeCompare(String(b.bg_id))) : [];
  const selectedBackground = () => tasks.get(monitor?.backgroundId) || backgrounds()[0];
  const selectedForeground = () => tasks.get(monitor?.foregroundId) || foregrounds()[0];

  function nearest(before, after, id, key) {
    if (after.some((item) => item[key] === id)) return id;
    const index = Math.max(0, before.findIndex((item) => item[key] === id));
    return after[Math.min(index, after.length - 1)]?.[key] || null;
  }

  function upsert(task, legacy = false) {
    const id = String(task?.task_id || task?.bg_id || "").trim();
    if (!id) return;
    const oldBackgrounds = monitor ? backgrounds() : [];
    const oldForegrounds = monitor ? foregrounds() : [];
    const next = summary(task, tasks.get(id), legacy);
    if (supportsTasks() && TERMINAL.has(next.status) && !next.handoff) tasks.delete(id);
    else tasks.set(id, next);
    backgroundItems = null;
    foregroundItems = null;
    if (monitor) {
      if (monitor.followId === id && next.handoff) {
        monitor.backgroundId = id;
        monitor.focus = "list";
        monitor.followId = null;
        selectionVersion += 1;
        monitor.previewOffset = 0;
      } else {
        monitor.backgroundId = nearest(oldBackgrounds, backgrounds(), monitor.backgroundId, "bg_id");
      }
      monitor.foregroundId = nearest(oldForegrounds, foregrounds(), monitor.foregroundId, "bg_id");
      if (monitor.focus === "foreground" && !foregrounds().length) monitor.focus = "list";
      if (monitor.focus === "list" && !backgrounds().length && foregrounds().length) monitor.focus = "foreground";
      if (preview?.id !== monitor.backgroundId) preview = null;
      redraw();
    }
    updateCount();
  }

  function recordTask(event) {
    const task = event?.task;
    if (!task?.task_id || (event.session_id && event.session_id !== state.sessionInfo?.session_id)) return;
    listUpdates?.add(task.task_id);
    const oldStatus = tasks.get(task.task_id)?.status;
    upsert(task);
    const current = tasks.get(task.task_id);
    if (monitor?.page === "background" && monitor.focus === "list" && monitor.backgroundId === task.task_id && current?.handoff) {
      if (event.type === "task_output" && !TERMINAL.has(current.status)) {
        if (!readInFlight && !monitor.previewOffset) {
          preview = { id: task.task_id, stdout: String(task.stdout || ""), stderr: String(task.stderr || ""), limited: true };
          redraw();
        }
      } else if (TERMINAL.has(current.status) && !TERMINAL.has(oldStatus)) {
        selectionVersion += 1;
        void readPreview();
      } else if (!preview && event.type !== "task_output") {
        void readPreview();
      }
    }
    if (!terminalUi && event.type === "task_updated" && oldStatus !== task.status) {
      log(`Task ${task.task_id}: ${task.status}${task.notify ? ` (${task.notify})` : ""}`);
    }
  }

  async function controlSelected(action) {
    if (!supportsTasks() || monitor?.page !== "background") return;
    const foreground = monitor.focus === "foreground";
    if (foreground && action !== "release") return;
    const task = foreground ? selectedForeground() : selectedBackground();
    if (!task) return;
    const currentGeneration = generation;
    const sessionId = state.sessionInfo?.session_id;
    if (foreground) monitor.followId = task.bg_id;
    try {
      const result = await request(action === "release" ? runtimeMethods.taskReleaseWait : runtimeMethods.taskCancel,
        { task_id: task.bg_id });
      if (generation !== currentGeneration || state.sessionInfo?.session_id !== sessionId) return;
      if (foreground && result?.released) {
        await refresh();
        if (generation === currentGeneration) void readPreview();
      } else if (monitor?.followId === task.bg_id) {
        monitor.followId = null;
      }
      if (result?.task_id) recordTask({ type: "task_updated", task: result });
    } catch (error) {
      if (generation !== currentGeneration) return;
      if (monitor?.followId === task.bg_id) monitor.followId = null;
      log(`Task control failed: ${error instanceof Error ? error.message : String(error)}`);
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
      try {
        do {
          const response = await request(supportsTasks() ? runtimeMethods.taskList : runtimeMethods.backgroundList,
            token ? { page_token: token } : {});
          if (generation !== currentGeneration) return;
          for (const task of Array.isArray(response?.tasks) ? response.tasks : []) {
            if (!updates.has(task.task_id || task.bg_id)) upsert(task, !supportsTasks());
          }
          token = supportsTasks() ? response?.next_page_token || null : null;
          if (token && seen.has(token)) throw new Error("Repeated task page token");
          if (token) seen.add(token);
        } while (token);
      } catch (error) {
        if (generation === currentGeneration) listError = `Task list incomplete: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        if (generation === currentGeneration) {
          listLoading = false;
          listUpdates = null;
          if (monitor) redraw();
        }
      }
    })().finally(() => { if (listInFlight === promise) listInFlight = null; });
    listInFlight = promise;
    return promise;
  }

  function updateCount() {
    const backgroundCount = [...tasks.values()].filter((task) => task.handoff && ACTIVE.has(task.status)).length;
    if (Number(state.sessionInfo?.background_count) !== backgroundCount) {
      state.sessionInfo = { ...state.sessionInfo, background_count: backgroundCount };
      redraw();
    }
    if (backgroundCount && !supportsTasks() && !refreshTimer && !state.runtimeClosing) {
      refreshTimer = setInterval(() => { void refresh(); }, 1000);
      refreshTimer.unref?.();
    } else if (!backgroundCount && refreshTimer) {
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
    backgroundItems = null;
    foregroundItems = null;
    preview = null;
    listLoading = false;
    listError = "";
    if (monitor) {
      monitor.backgroundId = null;
      monitor.foregroundId = null;
      monitor.followId = null;
      monitor.previewOffset = 0;
    }
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    updateCount();
  }

  function recordResult(event) {
    const parsed = parseObject(event?.result);
    const data = parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
    if (!data?.task_id && !data?.bg_id) return;
    if (supportsTasks() && data.task_id) {
      recordTask({ ...event, type: "task_updated", task: data });
      return;
    }
    upsert(data, !supportsTasks());
    if (monitor?.backgroundId === (data.task_id || data.bg_id)) void readPreview();
  }

  function enterMonitor() {
    if (monitor || state.runtimeClosing) return;
    monitorInputWasActive = state.inputActive;
    monitor = { page: "background", pageChanged: false, backgroundId: backgrounds()[0]?.bg_id || null,
      foregroundId: foregrounds()[0]?.bg_id || null,
      focus: foregrounds().length ? "foreground" : "list", previewOffset: 0, followId: null };
    const openedMonitor = monitor;
    state.inputActive = true;
    redraw(true);
    void refresh().then(() => {
      if (monitor !== openedMonitor) return;
      if (!tasks.size && !listError) {
        exitMonitor();
        log("No background tasks. Press Left from an empty prompt for team tasks.");
        return;
      }
      if (!monitor.pageChanged) {
        monitor.page = "background";
        monitor.focus = foregrounds().length ? "foreground" : "list";
      }
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
    if (!monitor || monitor.page !== "background" || monitor.focus !== "list" || state.runtimeClosing || readInFlight) return;
    const id = selectedBackground()?.bg_id;
    if (!id) return;
    const currentGeneration = generation;
    const version = selectionVersion;
    readInFlight = true;
    try {
      const response = await request(supportsTasks() ? runtimeMethods.taskRead : runtimeMethods.backgroundOutput,
        { [supportsTasks() ? "task_id" : "bg_id"]: id, max_output_chars: 20000 });
      const task = supportsTasks() ? response : response?.task;
      if (generation === currentGeneration && monitor?.page === "background" && monitor.focus === "list"
        && monitor.backgroundId === id && selectionVersion === version && task && typeof task === "object") {
        upsert(task, !supportsTasks());
        preview = { id, stdout: String(task.stdout || task.output || ""), stderr: String(task.stderr || ""),
          limited: Boolean(task.meta?.truncated || task.meta?.output_incomplete || task.truncated),
          expired: Boolean(task.meta?.output_incomplete) };
        redraw();
      }
    } catch (error) {
      if (generation === currentGeneration && monitor?.backgroundId === id && selectionVersion === version) {
        preview = { id, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) };
        redraw();
      }
    } finally {
      readInFlight = false;
      if (monitor?.page === "background" && monitor.focus === "list"
        && (generation !== currentGeneration || selectionVersion !== version)) void readPreview();
    }
  }

  function selectionChanged() {
    monitor.pageChanged = true;
    monitor.previewOffset = 0;
    selectionVersion += 1;
    preview = null;
    void readPreview();
    redraw();
  }

  function moveSelection(delta) {
    if (!monitor) return;
    // Waiting tasks precede handed-off tasks in one continuous navigation order.
    const waiting = foregrounds();
    const items = [...waiting, ...backgrounds()];
    if (!items.length) return;
    const field = monitor.focus === "foreground" ? "foregroundId" : "backgroundId";
    const key = "bg_id";
    const index = Math.max(0, items.findIndex((item) => item[key] === monitor[field]));
    const next = ((index + delta) % items.length + items.length) % items.length;
    monitor.focus = next < waiting.length ? "foreground" : "list";
    monitor[next < waiting.length ? "foregroundId" : "backgroundId"] = items[next].bg_id;
    selectionChanged();
  }

  function handleInput(key) {
    if (!monitor) return true;
    const modified = key.ctrl || key.alt || key.shift;
    if ((!modified && key.name === "escape") || (key.ctrl && key.name === "b")) { exitMonitor(); return true; }
    if (!modified && key.name === "tab" && monitor.page === "background" && foregrounds().length && backgrounds().length) {
      monitor.focus = monitor.focus === "foreground" ? "list" : "foreground";
      selectionChanged();
      return true;
    }
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
    const page = "background";
    const items = backgrounds();
    const selected = selectedBackground();
    const index = Math.max(0, items.findIndex((item) => item.bg_id === selected?.bg_id));
    const foregroundItems = page === "background" ? foregrounds() : [];
    const foreground = selectedForeground();
    const foregroundIndex = foregroundItems.findIndex((item) => item === foreground);
    return taskMonitorFrame({ page, backgroundCount: backgrounds().length,
      items, index, selected, foreground, foregroundIndex, foregroundCount: foregroundItems.length,
      focus: monitor?.focus || "list", preview: preview?.id === selected?.bg_id ? preview : null,
      previewOffset: monitor?.previewOffset || 0, loading: listLoading, error: listError, width, height });
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
    backgroundItems = null;
    foregroundItems = null;
  }

  return { recordTask, refresh, recordResult,
    enterMonitor, exitMonitor, handleInput, clear, stop, frame, isMonitoring: () => Boolean(monitor), moveSelection };
}
