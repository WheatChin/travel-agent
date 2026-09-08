// @vitest-environment node

import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "..");
const startScript = path.join(projectRoot, "scripts", "start.ps1");
const verifyScript = path.join(projectRoot, "scripts", "verify.ps1");
const temporaryDirectories: string[] = [];

function runPowerShell(script: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
    { cwd: options.cwd, env: options.env, encoding: "utf8", timeout: 15_000 },
  );
}

function makeFakeProject(scriptName: "start.ps1" | "verify.ps1", npmBody: string) {
  const root = mkdtempSync(path.join(tmpdir(), "travel delivery space "));
  temporaryDirectories.push(root);
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "node_modules"));
  writeFileSync(path.join(root, "scripts", scriptName), readFileSync(path.join(projectRoot, "scripts", scriptName)));
  writeFileSync(path.join(root, "npm.cmd"), npmBody);
  writeFileSync(path.join(root, "npx.cmd"), "@exit /b 0\r\n");
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Windows delivery scripts", () => {
  it("rejects invalid mode, host, and port arguments", () => {
    expect(runPowerShell(startScript, ["-Mode", "preview"]).status).not.toBe(0);
    expect(runPowerShell(startScript, ["-Host", "example.com"]).status).not.toBe(0);
    expect(runPowerShell(startScript, ["-Port", "0"]).status).not.toBe(0);
  });

  it("fails clearly without killing an occupied listener", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");

    const result = runPowerShell(startScript, ["-Port", String(address.port)]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("already occupied");
    expect(server.listening).toBe(true);
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("resolves a project path containing spaces independently of caller cwd and propagates command failure", () => {
    const root = makeFakeProject(
      "start.ps1",
      "@echo off\r\ncd > \"%DELIVERY_LOG%\"\r\nexit /b 7\r\n",
    );
    const logPath = path.join(root, "working-directory.txt");
    const result = runPowerShell(path.join(root, "scripts", "start.ps1"), ["-Port", "32191"], {
      cwd: tmpdir(),
      env: { ...process.env, PATH: `${root};${process.env.PATH}`, DELIVERY_LOG: logPath },
    });

    expect(result.status).not.toBe(0);
    expect(readFileSync(logPath, "utf8").trim().toLowerCase()).toBe(root.toLowerCase());
    expect(`${result.stdout}${result.stderr}`).toContain("exit code 7");
  });

  it("runs verification in order and stops at the first failed gate", () => {
    const root = makeFakeProject(
      "verify.ps1",
      "@echo off\r\necho %*>>\"%DELIVERY_LOG%\"\r\nif \"%1 %2\"==\"run lint\" exit /b 9\r\nexit /b 0\r\n",
    );
    const logPath = path.join(root, "verification.log");
    const result = runPowerShell(path.join(root, "scripts", "verify.ps1"), [], {
      cwd: tmpdir(),
      env: { ...process.env, PATH: `${root};${process.env.PATH}`, DELIVERY_LOG: logPath },
    });

    expect(result.status).not.toBe(0);
    expect(readFileSync(logPath, "utf8").trim().split(/\r?\n/)).toEqual(["run typecheck", "run lint"]);
    expect(`${result.stdout}${result.stderr}`).toContain("Verification stopped");
  });

  it("keeps browser installation explicit and includes every required verification gate", () => {
    const source = readFileSync(verifyScript, "utf8");
    expect(source).toContain("[switch]$InstallBrowser");
    expect(source).toContain('@("run", "typecheck")');
    expect(source).toContain('@("run", "lint")');
    expect(source).toContain('@("test")');
    expect(source).toContain('@("run", "build")');
    expect(source).toContain('@("run", "test:e2e")');
  });
});
