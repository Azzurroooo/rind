import { rm } from "node:fs/promises";
import { connectSharedRuntime } from "../../../rind-runtime-client/shared-runtime.js";

// Interactive Rind windows share one Runtime per RIND_HOME. Tests that start
// a window in a temporary home stop that Runtime before removing the folder,
// or the detached host would keep the folder locked and keep running.
export async function removeRindHome(home) {
  const host = await connectSharedRuntime({ rindHome: home, start: false }).catch(() => null);
  if (host) {
    await host.request("runtime/shutdown").catch(() => {});
    host.close();
    for (let i = 0; i < 40; i++) {
      const still = await connectSharedRuntime({ rindHome: home, start: false }).catch(() => null);
      if (!still) break;
      still.close();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
}
