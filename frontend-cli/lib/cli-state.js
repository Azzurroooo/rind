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
      activityLabel: "",
      stats: {},
      totals: null,
      contextStats: null,
      lastTurnUsage: null,
      exitArmed: false,
      exitArmTimer: null,
      lastEventSequence: 0,
      lastTurnId: "",
      activityFrame: 0,
      activityTimer: null,
      activityStartedAt: 0,
      assistantHeaderShown: false,
      outputStarted: false,
      toolDetailsExpanded: false,
      processExitTimer: null,
    },
  };
}
