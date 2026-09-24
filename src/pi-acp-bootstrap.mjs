// Run only inside the restricted ACP bubblewrap. Copy the selected provider auth into
// Pi's in-memory credential store, then unlink its startup file BEFORE opening ACP.
import { readFileSync, rmSync } from "node:fs";
import { runAcp } from "@automatalabs/pi-acp";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";

console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

const authPath = "/tmp/run/home/.pi/agent/auth.json";
try {
  const selectedCredentials = JSON.parse(readFileSync(authPath, "utf8"));
  rmSync(authPath);
  const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(selectedCredentials), allowModelNetwork: false });
  const { connection, agent } = await runAcp({ deps: { modelRuntime } });
  let shuttingDown = false;
  const shutdown = async (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await agent.dispose(); } catch { code = 1; }
    process.exit(code);
  };
  connection.closed.then(() => shutdown(0), () => shutdown(1));
  process.on("SIGTERM", () => { void shutdown(0); });
  process.on("SIGINT", () => { void shutdown(0); });
  process.stdin.resume();
} catch (error) {
  try { rmSync(authPath, { force: true }); } catch { /* cleanup at sandbox teardown */ }
  console.error("Pi ACP credential bootstrap failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
