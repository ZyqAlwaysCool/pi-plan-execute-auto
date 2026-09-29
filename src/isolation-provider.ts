import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  createSandboxedBackend,
  findBubblewrap,
  findMacOSSandboxExec,
  runSandboxedCommand,
  verifySandboxBoundary,
  type SandboxOptions,
  type SandboxedBackend,
  type SandboxedCommandOptions,
} from "./sandbox.js";
import type { GitCommandResult } from "./types.js";

const execFile = promisify(execFileCallback);

export interface LinuxIsolationPreflight {
  provider: "linux-bubblewrap";
  bubblewrap: string;
  userNamespaces: true;
  networkPolicy: "normal";
}

export interface MacOSIsolationPreflight {
  provider: "macos-seatbelt";
  sandboxExec: string;
  networkPolicy: "normal";
}

export type IsolationPreflight = LinuxIsolationPreflight | MacOSIsolationPreflight;

export interface IsolationProvider {
  readonly id: "platform-native";
  preflight(): Promise<IsolationPreflight>;
  createBackend(options: SandboxOptions): Promise<SandboxedBackend>;
  verifyBoundary(options: SandboxOptions): Promise<void>;
  runAcceptanceCommand(options: SandboxedCommandOptions): Promise<GitCommandResult>;
}

class PlatformNativeIsolationProvider implements IsolationProvider {
  readonly id = "platform-native" as const;

  async preflight(): Promise<IsolationPreflight> {
    if (process.platform === "linux") {
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
      return { provider: "linux-bubblewrap", bubblewrap, userNamespaces: true, networkPolicy: "normal" };
    }

    if (process.platform === "darwin") {
      const sandboxExec = findMacOSSandboxExec();
      try {
        await execFile(
          sandboxExec,
          ["-p", '(version 1) (allow default)', "/usr/bin/true"],
          { timeout: 10_000, maxBuffer: 16 * 1024 },
        );
      } catch (error) {
        throw new Error(
          "macOS Seatbelt sandbox-exec is present but cannot launch a sandboxed process. " +
          "Execution & Review fails closed instead of running agents without OS filesystem isolation. " +
          `Probe failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { provider: "macos-seatbelt", sandboxExec, networkPolicy: "normal" };
    }

    throw new Error(
      `Unsupported host platform: ${process.platform}. pi-plan-execute-auto currently supports Linux/WSL and macOS.`,
    );
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

export const defaultIsolationProvider: IsolationProvider = new PlatformNativeIsolationProvider();
