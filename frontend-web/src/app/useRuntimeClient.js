import { useEffect, useMemo } from "react";
import { createRuntimeClient } from "../runtimeClient.js";
import { hasStoredCredential } from "../ticket.js";

// One runtime client per App mount. Its callbacks delegate through ctx.call,
// so they always run the latest render's actions.
export function useRuntimeClient(ctx) {
  const { endpoint, refs, coalescer } = ctx;
  const client = useMemo(() => createRuntimeClient({
    url: endpoint,
    credentialProvider: (url) => ctx.call.current.acquireCredential(url),
    onEvent: (message) => ctx.call.current.handleEvent(message),
    onStatus: (status) => ctx.call.current.handleStatus(status),
    onOpen: () => ctx.call.current.handleOpen(),
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  refs.client.current = client;

  useEffect(() => {
    if (!hasStoredCredential(endpoint)) return undefined;
    client.connect().catch(() => {
      // Statuses carry the outcome; auth failures route back to the login card.
    });
    return () => client.disconnect();
  }, [client, endpoint]);

  useEffect(() => () => coalescer.dispose(), [coalescer]);
  return client;
}
