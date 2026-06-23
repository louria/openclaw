/** Build-only entry point for the standalone devbox supervisor bundle. */
import { serveCodexSupervisorMcp } from "./mcp-server.js";
import {
  bootstrapCodexSafetyMonitor,
  bootstrapOptionsFromEnvironment,
} from "./monitor-bootstrap.js";

const run =
  process.argv[2] === "bootstrap"
    ? bootstrapCodexSafetyMonitor(bootstrapOptionsFromEnvironment()).then((result) => {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      })
    : serveCodexSupervisorMcp();

run.catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`codex-supervisor-serve: ${message}\n`);
  process.exit(1);
});
