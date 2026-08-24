export function createCliState() {
  return {
    runtime: {
      status: "idle",
      initialization: null,
      failure: null,
    },
    session: {
      info: {},
      settings: {},
      commands: [],
    },
    turn: {
      active: false,
      id: "",
      interruptRequested: false,
    },
    input: {
      active: false,
      paused: false,
      prefill: "",
      session: null,
      pending: [],
      retrievingModes: new Set(),
    },
    display: {
      activeCompact: false,
      stats: {},
      lastEventSequence: 0,
      activityFrame: 0,
      activityTimer: null,
      activityStartedAt: 0,
      assistantOutputLineOpen: false,
      assistantHeaderShown: false,
      outputStarted: false,
      processExitTimer: null,
    },
  };
}
