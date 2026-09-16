const SPEEDS = [0.5, 1, 2, 4];
const SPINNER_MS = 120;

// Timing per step kind at 1× (ms). tickMs animates a reveal cursor, settleMs
// delays a tool outcome, afterMs is the pause after a step settles, waitKey
// holds for a keypress.
const TIMING = {
  shell: { tickMs: 24, afterMs: 300 },
  "shell-out": { tickMs: 40, afterMs: 80 },
  startup: { afterMs: 400 },
  type: { tickMs: 35, afterMs: 250 },
  submit: { afterMs: 250 },
  result: { afterMs: 500 },
  tool: { settleMs: 700, afterMs: 400 },
  assistant: { tickMs: 25, afterMs: 400 },
  menu: { tickMs: 450, afterMs: 700 },
  "turn-done": { afterMs: 500 },
  exit: { afterMs: 400 },
  note: { waitKey: true, afterMs: 200 },
};

export function createTourPlayer({ topics, startPageId = "", stage, schedule = setTimeout, cancel = clearTimeout, onRender = () => {} }) {
  const pages = topics.flatMap((topic) => topic.pages);
  const startPageIndex = Math.max(0, pages.findIndex((page) => page.id === startPageId));

  let view = startPageId ? "page" : "catalog";
  let selected = startPageIndex;
  let pageIndex = startPageIndex;
  let stepIndex = 0;
  let subPhase = "after";
  let playing = true;
  let speed = 1;
  let frame = 0;
  let elapsedMs = 0;
  let settled = true;

  let stepTimer = null;
  let stepTimerKind = null;
  let spinnerTimer = null;

  let resolveFinished;
  const finished = new Promise((resolve) => {
    resolveFinished = resolve;
  });

  function page() {
    return pages[pageIndex];
  }

  function steps() {
    return page().steps;
  }

  function current() {
    return steps()[stepIndex];
  }

  function timing(kind) {
    return TIMING[kind] || { afterMs: 300 };
  }

  function delay(ms) {
    return Math.max(1, Math.round(ms / speed));
  }

  function emit() {
    onRender();
  }

  function clearStepTimer() {
    if (stepTimer !== null) {
      cancel(stepTimer);
      stepTimer = null;
      stepTimerKind = null;
    }
  }

  function scheduleStep(kind, ms) {
    clearStepTimer();
    stepTimerKind = kind;
    stepTimer = schedule(() => {
      stepTimer = null;
      fire(kind);
    }, ms);
  }

  function scheduleSpinner() {
    if (spinnerTimer !== null) {
      return;
    }
    spinnerTimer = schedule(() => {
      spinnerTimer = null;
      if (view !== "page" || !playing) {
        return;
      }
      if (stage.snapshot().rind?.composer?.running) {
        frame += 1;
        elapsedMs += SPINNER_MS;
        emit();
      }
      scheduleSpinner();
    }, SPINNER_MS);
  }

  function fire(kind) {
    if (kind === "tick") {
      if (stage.tick()) {
        scheduleStep("tick", delay(timing(current().kind).tickMs));
      } else {
        settleCurrent();
      }
      emit();
      return;
    }
    if (kind === "settle") {
      settleCurrent();
      return;
    }
    if (kind === "after") {
      playStep(stepIndex + 1);
    }
  }

  function settleCurrent() {
    stage.settleStep(current());
    settled = true;
    emit();
    if (stepIndex >= steps().length - 1) {
      enterEnd();
      return;
    }
    subPhase = "after";
    if (playing) {
      scheduleStep("after", delay(timing(current().kind).afterMs || 0));
    }
  }

  function playStep(index) {
    clearStepTimer();
    stepIndex = index;
    settled = false;
    const step = current();
    stage.beginStep(step);
    emit();
    const timingSpec = timing(step.kind);
    if (timingSpec.waitKey) {
      subPhase = "waiting";
      return;
    }
    if (timingSpec.tickMs) {
      subPhase = "anim";
      if (playing) {
        scheduleStep("tick", delay(timingSpec.tickMs));
      }
      return;
    }
    if (timingSpec.settleMs) {
      subPhase = "settling";
      if (playing) {
        scheduleStep("settle", delay(timingSpec.settleMs));
      }
      return;
    }
    settleCurrent();
  }

  function enterEnd() {
    clearStepTimer();
    subPhase = "end";
    emit();
  }

  function start() {
    if (view === "page") {
      stage.reset();
      playStep(0);
    }
    scheduleSpinner();
    emit();
  }

  function pause() {
    if (!playing) {
      return;
    }
    playing = false;
    clearStepTimer();
    emit();
  }

  function resume() {
    if (playing) {
      return;
    }
    playing = true;
    if (view === "page" && subPhase !== "waiting" && subPhase !== "end") {
      const timingSpec = timing(current().kind);
      if (subPhase === "anim") {
        scheduleStep("tick", delay(timingSpec.tickMs));
      } else if (subPhase === "settling") {
        scheduleStep("settle", delay(timingSpec.settleMs));
      } else {
        scheduleStep("after", delay(timingSpec.afterMs || 0));
      }
    }
    scheduleSpinner();
    emit();
  }

  function advanceFromWait() {
    stage.settleStep(current());
    settled = true;
    emit();
    if (stepIndex >= steps().length - 1) {
      enterEnd();
      return;
    }
    playStep(stepIndex + 1);
  }

  function skipForward() {
    clearStepTimer();
    if (!settled) {
      stage.settleStep(current());
      settled = true;
      emit();
    }
    if (stepIndex >= steps().length - 1) {
      enterEnd();
      return;
    }
    playStep(stepIndex + 1);
  }

  function stepBack() {
    clearStepTimer();
    stage.rebuildTo(steps(), stepIndex - 1);
    stepIndex = Math.max(0, stepIndex - 1);
    settled = true;
    if (timing(current().kind).waitKey) {
      subPhase = "waiting";
    } else {
      subPhase = "after";
      if (playing) {
        scheduleStep("after", delay(timing(current().kind).afterMs || 300));
      }
    }
    emit();
  }

  function skipAnimation() {
    if (subPhase === "waiting") {
      advanceFromWait();
      return;
    }
    if (subPhase === "end") {
      nextPage();
      return;
    }
    if (settled) {
      skipForward();
      return;
    }
    clearStepTimer();
    stage.settleStep(current());
    settled = true;
    emit();
    if (stepIndex >= steps().length - 1) {
      enterEnd();
      return;
    }
    subPhase = "after";
    if (playing) {
      scheduleStep("after", delay(timing(current().kind).afterMs || 0));
    }
  }

  function changeSpeed(direction) {
    const index = SPEEDS.indexOf(speed);
    speed = SPEEDS[(index + direction + SPEEDS.length) % SPEEDS.length];
    emit();
  }

  function replay() {
    clearStepTimer();
    playing = true;
    stage.reset();
    playStep(0);
    scheduleSpinner();
    emit();
  }

  function openPage(index) {
    pageIndex = index;
    selected = index;
    view = "page";
    stage.reset();
    playStep(0);
    scheduleSpinner();
    emit();
  }

  function nextPage() {
    if (pageIndex + 1 >= pages.length) {
      toCatalog();
      return;
    }
    openPage(pageIndex + 1);
  }

  function toCatalog() {
    clearStepTimer();
    view = "catalog";
    selected = pageIndex;
    stage.reset();
    emit();
  }

  function finish() {
    clearStepTimer();
    resolveFinished();
  }

  function key(event) {
    if (!event) {
      return;
    }
    if (event.kind === "text") {
      // parseTerminalKey reports plain letters and space as text; the tour
      // has no editor, so its letter commands arrive this way.
      const mapped = { " ": "space", q: "q", r: "r" }[event.text];
      if (!mapped || (mapped === "r" && view !== "page")) {
        return;
      }
      event = { kind: "key", name: mapped, ctrl: false, alt: false, shift: false };
    }
    if (event.ctrl && event.name === "c") {
      finish();
      return;
    }
    if (view === "catalog") {
      if (event.name === "up") {
        selected = (selected - 1 + pages.length) % pages.length;
        emit();
      } else if (event.name === "down") {
        selected = (selected + 1) % pages.length;
        emit();
      } else if (event.name === "enter") {
        openPage(selected);
      } else if (event.name === "q" || event.name === "escape") {
        finish();
      }
      return;
    }
    switch (event.name) {
      case "space":
        if (subPhase === "waiting") {
          advanceFromWait();
        } else if (subPhase === "end") {
          nextPage();
        } else if (playing) {
          pause();
        } else {
          resume();
        }
        break;
      case "right":
        if (subPhase === "waiting") {
          advanceFromWait();
        } else if (subPhase === "end") {
          nextPage();
        } else {
          skipForward();
        }
        break;
      case "left":
        stepBack();
        break;
      case "enter":
        skipAnimation();
        break;
      case "up":
        changeSpeed(1);
        break;
      case "down":
        changeSpeed(-1);
        break;
      case "r":
        if (subPhase === "end") {
          replay();
        }
        break;
      case "q":
      case "escape":
        toCatalog();
        break;
    }
  }

  return {
    key,
    start,
    finished,
    state() {
      return {
        view,
        topics,
        selected,
        page: page(),
        pageIndex,
        pageCount: pages.length,
        stepIndex,
        stepCount: steps().length,
        speed,
        paused: !playing,
        phase: subPhase,
        frame,
        elapsedMs,
      };
    },
  };
}
