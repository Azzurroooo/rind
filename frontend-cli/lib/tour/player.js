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
  result: { afterMs: 1200 },
  "slash-result": { afterMs: 1600 },
  tool: { settleMs: 700, afterMs: 400 },
  assistant: { tickMs: 30, afterMs: 1800 },
  menu: { tickMs: 650, afterMs: 1800 },
  "turn-done": { afterMs: 500 },
  exit: { afterMs: 400 },
  note: { waitKey: true, afterMs: 200 },
};

export function createTourPlayer({ topics, startPageId = "", stage, schedule = setTimeout, cancel = clearTimeout, onRender = () => {}, onPageComplete = () => {} }) {
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
  let closed = false;
  let help = false;
  let resumeAfterHelp = false;
  let scrollOffset = null;
  let scrollLimit = 0;
  let visibleOffset = 0;
  const completed = new Set();

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
    if (kind === "menu" && current()?.menu.kind === "auth-secret") return { tickMs: 80, afterMs: 1800 };
    return TIMING[kind] || { afterMs: 300 };
  }

  function afterDelay() {
    const step = current();
    // Leave a newly introduced caption visible long enough to read it.
    const readingMs = step.note ? Math.min(6500, 1000 + step.note.join(" ").length * 28) : 0;
    return delay(Math.max(timing(step.kind).afterMs || 0, readingMs));
  }

  function clearSpinner() {
    if (spinnerTimer !== null) cancel(spinnerTimer);
    spinnerTimer = null;
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
      stepTimerKind = null;
      if (closed) return;
      fire(kind);
    }, ms);
  }

  function scheduleSpinner() {
    if (spinnerTimer !== null || closed || view !== "page" || !playing || help || ["waiting", "end"].includes(subPhase)) {
      return;
    }
    spinnerTimer = schedule(() => {
      spinnerTimer = null;
      if (closed || view !== "page" || !playing || help || ["waiting", "end"].includes(subPhase)) {
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
      scheduleStep("after", afterDelay());
    }
  }

  function playStep(index) {
    clearStepTimer();
    stepIndex = index;
    scrollOffset = null;
    settled = false;
    const step = current();
    if ((step.kind === "submit" && !stage.snapshot().rind?.composer.running)
      || step.kind === "turn-start" || (step.kind === "consume" && step.mode === "follow_up")) elapsedMs = 0;
    stage.beginStep(step);
    const timingSpec = timing(step.kind);
    if (timingSpec.waitKey) {
      subPhase = "waiting";
      clearSpinner();
      if (stepIndex === steps().length - 1) {
        stage.settleStep(step);
        settled = true;
        enterEnd();
      } else emit();
      return;
    }
    if (timingSpec.tickMs) {
      subPhase = "anim";
      if (playing) {
        scheduleStep("tick", delay(timingSpec.tickMs));
      }
      scheduleSpinner();
      emit();
      return;
    }
    if (timingSpec.settleMs) {
      subPhase = "settling";
      if (playing) {
        scheduleStep("settle", delay(timingSpec.settleMs));
      }
      scheduleSpinner();
      emit();
      return;
    }
    settleCurrent();
    scheduleSpinner();
  }

  function enterEnd() {
    clearStepTimer();
    clearSpinner();
    subPhase = "end";
    if (!completed.has(page().id)) {
      completed.add(page().id);
      onPageComplete(page().id);
    }
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
    clearSpinner();
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
        scheduleStep("after", afterDelay());
      }
    }
    scheduleSpinner();
    emit();
  }

  function advanceFromWait() {
    playing = true;
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
    if (!playing && !settled && subPhase !== "waiting") {
      settleCurrent();
    }
  }

  // Back is a review action: rebuild the previous step and hold there, so a
  // note you just backed away from does not bounce forward again on its own.
  function stepBack() {
    clearStepTimer();
    playing = false;
    clearSpinner();
    stepIndex = Math.max(0, stepIndex - 1);
    stage.rebuildTo(steps(), stepIndex);
    scrollOffset = null;
    settled = true;
    subPhase = timing(current().kind).waitKey ? "waiting" : "after";
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
      scheduleStep("after", afterDelay());
    }
  }

  function changeSpeed(direction) {
    const index = SPEEDS.indexOf(speed);
    speed = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, index + direction))];
    if (stepTimer !== null) {
      const kind = stepTimerKind;
      const spec = timing(current().kind);
      scheduleStep(kind, kind === "after" ? afterDelay() : delay(kind === "tick" ? spec.tickMs : spec.settleMs));
    }
    emit();
  }

  function replay() {
    clearStepTimer();
    playing = true;
    frame = 0;
    elapsedMs = 0;
    stage.reset();
    playStep(0);
    scheduleSpinner();
    emit();
  }

  function openPage(index) {
    pageIndex = index;
    selected = index;
    view = "page";
    playing = true;
    frame = 0;
    elapsedMs = 0;
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
    clearSpinner();
    view = "catalog";
    selected = pageIndex;
    stage.reset();
    emit();
  }

  function finish() {
    if (closed) return;
    closed = true;
    clearStepTimer();
    clearSpinner();
    resolveFinished();
  }

  function key(event) {
    if (!event || closed) {
      return;
    }
    if (event.kind === "text") {
      // parseTerminalKey reports plain letters as text; the tour has no
      // editor, so its letter commands arrive this way — possibly several
      // batched into one chunk.
      for (const char of event.text) {
        const mapped = { " ": "space", q: "q", r: "r", "?": "help" }[char];
        if (!mapped) {
          continue;
        }
        if (mapped === "r" && view !== "page") {
          continue;
        }
        key({ kind: "key", name: mapped, ctrl: false, alt: false, shift: false });
      }
      return;
    }
    if (event.ctrl && event.name === "c") {
      finish();
      return;
    }
    if (event.ctrl || event.alt) return;
    if (help) {
      if (["help", "escape", "enter", "space", "q"].includes(event.name)) {
        help = false;
        if (resumeAfterHelp) resume();
        emit();
      }
      return;
    }
    if (event.name === "help") {
      resumeAfterHelp = playing;
      pause();
      help = true;
      emit();
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
      case "pageup":
        pause();
        scrollOffset = Math.min(scrollLimit, (scrollOffset ?? visibleOffset) + 5);
        emit();
        break;
      case "pagedown":
        pause();
        scrollOffset = Math.max(0, (scrollOffset ?? visibleOffset) - 5);
        emit();
        break;
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
        if (subPhase === "end") {
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
        replay();
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
    pause,
    dispose: finish,
    setScrollLimit(limit, offset = 0) {
      scrollLimit = Math.max(0, limit);
      visibleOffset = offset;
      if (scrollOffset !== null) scrollOffset = Math.min(scrollOffset, scrollLimit);
    },
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
        help,
        scrollOffset,
        completed: [...completed],
      };
    },
  };
}
