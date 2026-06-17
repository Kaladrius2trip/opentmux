#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import { createServer } from "node:net";
import { env, platform, exit, argv } from "node:process";
import { existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ZombieReaper } from "../zombie-reaper";
import { loadConfig } from "../utils/config-loader";

// Load config
const config = loadConfig();
const OPENCODE_PORT_START =
  config.port || parseInt(env.OPENCODE_PORT || "4096", 10);
const OPENCODE_PORT_MAX = OPENCODE_PORT_START + (config.max_ports || 10);
const LOG_FILE = "/tmp/opentmux.log";

function log(...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] ${args.join(" ")}\n`;
  try {
    appendFileSync(LOG_FILE, message);
  } catch {}
}

function findOpencodeBin(): string | null {
  try {
    const cmd = platform === "win32" ? "where opencode" : "which -a opencode";
    const output = execSync(cmd, { encoding: "utf-8" }).trim().split("\n");

    const currentScript = argv[1];

    for (const bin of output) {
      const normalizedBin = bin.trim();
      if (normalizedBin.includes("opentmux") || normalizedBin === currentScript)
        continue;
      if (normalizedBin) return normalizedBin;
    }
  } catch (e) {}

  const commonPaths = [
    join(
      homedir(),
      ".opencode",
      "bin",
      platform === "win32" ? "opencode.exe" : "opencode",
    ),
    join(homedir(), "AppData", "Local", "opencode", "bin", "opencode.exe"),
    "/usr/local/bin/opencode",
    "/usr/bin/opencode",
  ];

  for (const p of commonPaths) {
    if (existsSync(p)) return p;
  }

  return null;
}

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(port, "127.0.0.1");
    server.on("listening", () => {
      server.close();
      resolve(true);
    });
    server.on("error", () => {
      resolve(false);
    });
  });
}

async function findAvailablePort(): Promise<number | null> {
  for (let port = OPENCODE_PORT_START; port <= OPENCODE_PORT_MAX; port++) {
    if (await checkPort(port)) return port;
  }
  return null;
}

function readExplicitPort(args: readonly string[]): number | null {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--port") {
      const value = args[index + 1];
      const port = value ? Number.parseInt(value, 10) : NaN;
      return Number.isFinite(port) ? port : null;
    }
    if (arg.startsWith("--port=")) {
      const port = Number.parseInt(arg.slice("--port=".length), 10);
      return Number.isFinite(port) ? port : null;
    }
  }
  return null;
}

function hasTmux(): boolean {
  try {
    execSync("tmux -V", { stdio: "ignore" });
    return true;
  } catch (e) {
    return false;
  }
}

async function main() {
  // Check if running as a script (node script.js) or a compiled binary
  // In script mode: argv[0]=node, argv[1]=script, argv[2]=arg1 -> slice(2)
  // In binary mode: argv[0]=binary, argv[1]=arg1 -> slice(1)
  // Use regex to securely match only actual node/bun executables
  const isRuntime = /\/?(node|bun)(\.exe)?$/i.test(argv[0]);

  // In script mode, argv[1] is the script file path.
  // In compiled/binary mode, argv[0] is the binary, and argv[1] is the first user argument.
  // If we are running via node/bun, we are ALWAYS in script mode for this wrapper.
  const args = isRuntime ? argv.slice(2) : argv.slice(1);

  // Check for opentmux-specific flags first
  if (args.includes("--reap") || args.includes("-reap")) {
    await ZombieReaper.reapAll();
    exit(0);
  }

  // Define known CLI commands that should NOT trigger a tmux session
  // These are commands that either:
  // 1. Run quickly and exit (CLI tools)
  // 2. Are server/daemon processes that manage their own lifecycle
  // 3. Are help/version flags
  const NON_TUI_COMMANDS = [
    // Core CLI commands
    "auth",
    "config",
    "plugins",
    "update",
    "upgrade",
    "completion",
    "stats",
    "run",
    "exec",
    "doctor",
    "debug",
    "clean",
    "uninstall",

    // Agent/Session management
    "agent",
    "attach",
    "session",
    "export",
    "import",
    "github",
    "pr",

    // Server commands (usually run in fg, don't need tmux wrapper)
    "serve",
    "web",
    "acp",
    "mcp",
    "models",

    // Flags
    "--version",
    "-v",
    "--help",
    "-h",
  ];

  const isCliCommand = args.length > 0 && NON_TUI_COMMANDS.includes(args[0]);
  const isInteractiveMode = args.length === 0;

  // For CLI commands, bypass tmux
  if (isCliCommand) {
    const opencodeBin = findOpencodeBin();
    if (!opencodeBin) {
      console.error(
        'Error: Could not find "opencode" binary in PATH or common locations.',
      );
      exit(1);
    }

    const bypassArgs = [...args];
    const hasPrintLogs = args.includes("--print-logs");
    if (!hasPrintLogs && !args.some((arg) => arg.startsWith("--log-level"))) {
      bypassArgs.push("--log-level", "ERROR");
    }

    const child = spawn(opencodeBin, bypassArgs, {
      stdio: ["inherit", "inherit", "pipe"],
      env: process.env,
    });

    child.stderr?.on("data", (data) => {
      const lines = data.toString().split("\n");
      const filtered = lines.filter(
        (line: string) =>
          !/^INFO\s+.*service=models\.dev.*refreshing/.test(line),
      );
      process.stderr.write(filtered.join("\n"));
    });

    child.on("close", (code) => {
      exit(code ?? 0);
    });
    return;
  }

  log("=== OpenCode Tmux Wrapper Started ===");
  log("Process argv:", JSON.stringify(argv));
  log("Current directory:", process.cwd());

  const opencodeBin = findOpencodeBin();
  log("Found opencode binary:", opencodeBin);

  if (!opencodeBin) {
    console.error(
      'Error: Could not find "opencode" binary in PATH or common locations.',
    );
    log("ERROR: opencode binary not found");
    exit(1);
  }

  const explicitPort = readExplicitPort(args);
  const port = explicitPort ?? (await findAvailablePort());
  log("Found available port:", port);

  if (!port) {
    console.error(
      `Error: No available ports found in range ${OPENCODE_PORT_START}-${OPENCODE_PORT_MAX}.`,
    );
    console.error("Tip: stop an existing OpenCode server or pass an explicit --port.");
    log("ERROR: No available ports");
    exit(1);
  }

  const env2 = { ...process.env };
  env2.OPENCODE_PORT = port.toString();

  log("User args:", JSON.stringify(args));

  const childArgs = explicitPort === null ? ["--port", port.toString(), ...args] : [...args];
  log("Final childArgs:", JSON.stringify(childArgs));

  const inTmux = !!env2.TMUX;
  const tmuxAvailable = hasTmux();

  log("In tmux?", inTmux);
  log("Tmux available?", tmuxAvailable);

  if (inTmux || !tmuxAvailable) {
    log("Running directly (in tmux or no tmux available)");

    const child = spawn(opencodeBin, childArgs, {
      stdio: "inherit",
      env: env2,
    });

    child.on("error", (err) => {
      log("ERROR spawning child:", err.message);
    });

    child.on("close", (code) => {
      log("Child exited with code:", code);
      exit(code ?? 0);
    });

    process.on("SIGINT", () => child.kill("SIGINT"));
    process.on("SIGTERM", () => child.kill("SIGTERM"));
  } else {
    console.log("🚀 Launching tmux session...");
    log("Launching tmux session");

    const escapedBin = opencodeBin.includes(" ")
      ? `'${opencodeBin}'`
      : opencodeBin;
    const escapedArgs = childArgs.map((arg) => {
      if (arg.includes(" ") || arg.includes('"') || arg.includes("'")) {
        return `'${arg.replace(/'/g, "'\\''")}'`;
      }
      return arg;
    });

    const shellCommand = `${escapedBin} ${escapedArgs.join(" ")} || { echo "Exit code: $?"; echo "Press Enter to close..."; read; }`;

    log("Shell command for tmux:", shellCommand);

    const tmuxArgs = ["new-session", shellCommand];

    log("Tmux args:", JSON.stringify(tmuxArgs));

    const child = spawn("tmux", tmuxArgs, { stdio: "inherit", env: env2 });

    child.on("error", (err) => {
      log("ERROR spawning tmux:", err.message);
    });

    child.on("close", (code) => {
      log("Tmux exited with code:", code);
      exit(code ?? 0);
    });
  }
}

main().catch((err) => {
  // Handle AbortError gracefully (user cancelled)
  if (err.name === "AbortError" || err.code === 20) {
    exit(0);
  }

  log("FATAL ERROR:", err.message, err.stack);
  console.error(err);
  exit(1);
});
