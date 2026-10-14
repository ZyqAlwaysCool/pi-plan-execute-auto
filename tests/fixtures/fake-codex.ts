import { chmod, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Platform package names published by `@openai/codex` for the supported hosts. */
export function codexPlatformPackage(): string | undefined {
  if (process.platform === "linux") return process.arch === "arm64" ? "@openai/codex-linux-arm64" : "@openai/codex-linux-x64";
  if (process.platform === "darwin") return process.arch === "arm64" ? "@openai/codex-darwin-arm64" : "@openai/codex-darwin-x64";
  return undefined;
}

/** Vendor triples used inside the platform package. */
export function codexVendorTriple(): string | undefined {
  if (process.platform === "linux") return process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
  if (process.platform === "darwin") return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  return undefined;
}

export interface FakeCodexInstall {
  /** PATH directory containing the `codex` entry point. */
  pathDir: string;
  /** Platform vendor tree that npm installs expose next to the native binary. */
  vendorRoot: string;
  /** Fake native app-server executable inside the vendor tree. */
  binary: string;
}

/**
 * Materialize the npm layout the plugin resolves: an executable `codex` shim on
 * PATH plus the platform package's `vendor/<triple>/bin/codex` app-server and its
 * bundled `codex-path/` tools. Returns real paths so assertions match the
 * canonical values the sandbox uses.
 */
export async function writeFakeCodexInstall(root: string): Promise<FakeCodexInstall> {
  const platformPackage = codexPlatformPackage();
  const triple = codexVendorTriple();
  if (!platformPackage || !triple) throw new Error(`Unsupported test platform: ${process.platform}/${process.arch}`);
  const packageRoot = join(root, "node_modules", "@openai", "codex");
  const launcher = join(packageRoot, "bin", "codex.js");
  await mkdir(dirname(launcher), { recursive: true });
  await writeFile(launcher, "#!/usr/bin/env node\nprocess.exit(0);\n");
  await chmod(launcher, 0o755);

  const platformRoot = join(packageRoot, "node_modules", "@openai", platformPackage.slice("@openai/".length));
  const vendorRoot = join(platformRoot, "vendor", triple);
  const binary = join(vendorRoot, "bin", "codex");
  await mkdir(join(vendorRoot, "bin"), { recursive: true });
  await writeFile(binary, "#!/bin/sh\nprintf 'fake-codex:%s\\n' \"$1\"\n");
  await chmod(binary, 0o755);
  await mkdir(join(vendorRoot, "codex-path"), { recursive: true });
  await writeFile(join(vendorRoot, "codex-path", "rg"), "#!/bin/sh\nexit 0\n");
  await chmod(join(vendorRoot, "codex-path", "rg"), 0o755);
  await writeFile(join(platformRoot, "package.json"), JSON.stringify({ name: platformPackage, version: "0.0.0" }));

  const pathDir = join(root, "bin");
  await mkdir(pathDir, { recursive: true });
  await symlink(launcher, join(pathDir, "codex"));
  return { pathDir, vendorRoot: await realpath(vendorRoot), binary: await realpath(binary) };
}
