import assert from "node:assert/strict";
import {mkdtemp, writeFile, rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {pathToFileURL} from "node:url";
const repoRoot = path.resolve(process.argv[2]);
const {startSharedServer} = await import(pathToFileURL(path.join(repoRoot, "rind-runtime-client/shared-server.js")));
const {connectSharedRuntime} = await import(pathToFileURL(path.join(repoRoot, "rind-runtime-client/shared-runtime.js")));
const rindHome = await mkdtemp(path.join(os.tmpdir(), "rind-host-review-"));
const options={repoRoot,rindHome,python:"/home/azzurro/code/agent/rind/.venv/bin/python"};
let host, connection, fresh;
try {
  await writeFile(path.join(rindHome,"settings.json"), JSON.stringify({provider:"openai-compatible",model:"fixture",apiKey:"fixture",baseUrl:"http://127.0.0.1:1/v1"}));
  host=await startSharedServer(options);
  connection=await connectSharedRuntime({...options,start:false});
  const {pid}=await connection.request("runtime/observe");
  process.kill(pid,"SIGKILL");
  let endpointStopped=false;
  for (let i=0;i<100;i++) {
    await new Promise(resolve=>setTimeout(resolve,20));
    try { const probe=await connectSharedRuntime({...options,start:false}); probe.close(); }
    catch { endpointStopped=true;break; }
  }
  connection.close();
  await host.close();
  host=null;
  fresh=await startSharedServer(options);
  const probe=await connectSharedRuntime({...options,start:false});
  const newWorker=await probe.request("runtime/observe");
  probe.close();
  assert.notEqual(newWorker.pid,pid);
  console.log(JSON.stringify({endpointStopped,freshWorkerStarted:true}));
} finally {
  connection?.close();
  await fresh?.close();
  await host?.close();
  await rm(rindHome,{recursive:true,force:true});
}
