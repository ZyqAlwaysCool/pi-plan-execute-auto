import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  createSandboxedBackend,
  findBubblewrap,
  runSandboxedCommand,
  verifySandboxBoundary,
  type SandboxOptions,
  type SandboxedBackend,
  type SandboxedCommandOptions,
} from "./sandbox.js";
import type { GitCommandResult } from "./types.js";

const execFile = promisify(execFileCallback);

export interface IsolationPreflight {
  provider: "linux-bubblewrap";
  bubblewrap: string;
  userNamespaces: true;
  networkPolicy: "normal";
}

export interface IsolationProvider {
  readonly id: "linux-bubblewrap";
  preflight(): Promise<IsolationPreflight>;
  createBackend(options: SandboxOptions): Promise<SandboxedBackend>;
  verifyBoundary(options: SandboxOptions): Promise<void>;
  runAcceptanceCommand(options: SandboxedCommandOptions): Promise<GitCommandResult>;
}

class LinuxBubblewrapIsolationProvider implements IsolationProvider {
  readonly id = "linux-bubblewrap" as const;

  async preflight(): Promise<IsolationPreflight> {
    const bubblewrap = findBubblewrap();
    try {
      await execFile("unshare", ["-Ur", "true"], { timeout: 10_000, maxBuffer: 16 * 1024 });
    } catch (error) {
      throw new Error(
        "Linux user namespaces are unavailable. Execution & Review needs bubblewrap plus usable user namespaces. " +
        "On Ubuntu/WSL install bubblewrap with: sudo apt-get install bubblewrap. " +
        `Namespace probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { provider: this.id, bubblewrap, userNamespaces: true, networkPolicy: "normal" };
  }

  createBackend(options: SandboxOptions): Promise<SandboxedBackend> {
    return createSandboxedBackend(options);
  }

  verifyBoundary(options: SandboxOptions): Promise<void> {
    return verifySandboxBoundary(options);
  }

  runAcceptanceCommand(options: SandboxedCommandOptions): Promise<GitCommandResult> {
    return runSandboxedCommand(options);
  }
}

export const defaultIsolationProvider: IsolationProvider = new LinuxBubblewrapIsolationProvider();
