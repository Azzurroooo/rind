import { useCallback, useMemo, useRef, useState } from "react";
import { createEventCoalescer } from "../lib/streamController.js";
import { createConnectionController } from "../state/connection.js";
import { conversationView } from "../state/conversationReducer.js";
import { buildCommands } from "../lib/commands.js";
import { useToast } from "../components/overlays/Toast.jsx";
import { useAppState } from "./useAppState.js";
import { useShellLayout } from "./useShellLayout.js";
import { useThemeState } from "./useThemeState.js";
import { useRuntimeClient } from "./useRuntimeClient.js";
import { useGlobalKeys } from "./useGlobalKeys.js";
import { createHelpers } from "./helpers.js";
import { createConnectionActions } from "./connectionActions.js";
import { createSessionActions } from "./sessionActions.js";
import { createTurnActions } from "./turnActions.js";
import { createCommandActions } from "./commandActions.js";

// Runtime wiring for the shell: state, the one runtime client, and the action
// factories. Factories are rebuilt every render and reach each other through
// ctx.call, so async callbacks always see the latest render's state.
export function useAppController() {
  const state = useAppState();
  const call = useRef({});
  const layout = useShellLayout();
  const theme = useThemeState();
  const toast = useToast();
  const [fileRequest, setFileRequest] = useState(null);
  const coalescer = useMemo(() => createEventCoalescer({ dispatch: state.dispatchConversation }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const controller = useMemo(() => createConnectionController({ dispatch: state.dispatchConnection }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const commandList = useMemo(() => buildCommands({}, state.info.commands), [state.info.commands]);

  const ctx = { ...state, coalescer, controller, layout, theme, toast, commandList, call };
  const helpers = createHelpers(ctx);
  const connection = createConnectionActions(ctx);
  const session = createSessionActions(ctx);
  const turn = createTurnActions(ctx);
  const command = createCommandActions(ctx);
  call.current = {
    ...helpers,
    ...connection,
    ...session,
    ...turn,
    ...command,
    toggleSidebar: layout.toggleSidebar,
    drawerOpen: () => Boolean(layout.drawer),
  };

  const view = conversationView(state.conversation);
  useRuntimeClient(ctx);
  useGlobalKeys(ctx, view.active);

  const request = useCallback((method, params = {}) => state.refs.client.current?.request(method, params), []); // eslint-disable-line react-hooks/exhaustive-deps

  // A tool row's path opens the Files tab and previews that file.
  const openFile = useCallback((path) => {
    if (!path) return;
    setFileRequest((current) => ({ path, seq: (current?.seq || 0) + 1 }));
    layout.openInspector("files");
  }, [layout]);

  return { ctx, actions: call.current, view, request, fileRequest, openFile };
}
