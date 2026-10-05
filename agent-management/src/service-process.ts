import { execFile } from "node:child_process";

// Services started before serviceShutdown existed cannot be asked to stop.
// They are found by their command line: the script they run and the data
// folder they were started for. Callers only end such a process after the
// service itself reported that nothing is running.
export async function findServiceProcesses(script: string, sameHome: (config: { home?: string; rindHome?: string }) => boolean): Promise<number[]> {
  const list = await new Promise<string>(resolve => {
    const done = (_error: unknown, stdout: string) => resolve(stdout || "");
    if (process.platform === "win32") {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"], { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, done);
    } else execFile("ps", ["-axo", "pid=,args="], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, done);
  });
  return matchServiceProcesses(list, script, sameHome);
}

// "pid<whitespace>command line" lines -> pids of matching services.
export function matchServiceProcesses(list: string, script: string, sameHome: (config: { home?: string; rindHome?: string }) => boolean): number[] {
  // Compare the last three path segments, e.g. agent-management/dist/server.js.
  const tail = script.split(/[\\/]/).slice(-3).join("/").toLowerCase();
  const pids: number[] = [];
  for (const line of list.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match || Number(match[1]) === process.pid) continue;
    const command = match[2];
    if (!command.replace(/\\+/g, "/").toLowerCase().includes(tail)) continue;
    // The configuration is a JSON argument, quoted for the shell (\" around strings).
    const json = command.slice(command.indexOf("{"), command.lastIndexOf("}") + 1).replace(/\\"/g, "\"");
    const field = (name: string) => {
      const found = json.match(new RegExp('"' + name + '":"((?:[^"\\\\]|\\\\.)*)"'));
      if (!found) return undefined;
      try { return JSON.parse('"' + found[1] + '"') as string; } catch { return found[1]; }
    };
    if (sameHome({ home: field("home"), rindHome: field("rindHome") })) pids.push(Number(match[1]));
  }
  return pids;
}
