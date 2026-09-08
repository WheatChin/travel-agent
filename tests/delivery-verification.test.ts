// @vitest-environment node

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "..");
const temporaryDirectories: string[] = [];

function makeDeliveryProject(options: { withDependencies: boolean }) {
  const root = mkdtempSync(path.join(tmpdir(), "travel delivery verification "));
  temporaryDirectories.push(root);
  mkdirSync(path.join(root, "scripts"));
  if (options.withDependencies) mkdirSync(path.join(root, "node_modules"));

  copyFileSync(path.join(projectRoot, "scripts", "start.ps1"), path.join(root, "scripts", "start.ps1"));
  copyFileSync(path.join(projectRoot, "scripts", "verify.ps1"), path.join(root, "scripts", "verify.ps1"));
  copyFileSync(path.join(projectRoot, "start.cmd"), path.join(root, "start.cmd"));

  writeFileSync(
    path.join(root, "npm.cmd"),
    "@echo off\r\necho npm %*>>\"%DELIVERY_LOG%\"\r\nexit /b 0\r\n",
  );
  writeFileSync(
    path.join(root, "npx.cmd"),
    "@echo off\r\necho npx %*>>\"%DELIVERY_LOG%\"\r\nexit /b 0\r\n",
  );

  return root;
}

function deliveryEnvironment(root: string, logPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${root};${process.env.PATH}`,
    DELIVERY_LOG: logPath,
  };
}

function runPowerShell(script: string, args: string[], root: string, logPath: string) {
  return spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
    { cwd: tmpdir(), env: deliveryEnvironment(root, logPath), encoding: "utf8", timeout: 15_000 },
  );
}

function readCommands(logPath: string) {
  return readFileSync(logPath, "utf8").trim().split(/\r?\n/);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("local delivery process boundaries", () => {
  it("installs missing dependencies before starting development mode", () => {
    const root = makeDeliveryProject({ withDependencies: false });
    const logPath = path.join(root, "commands.log");

    const result = runPowerShell(path.join(root, "scripts", "start.ps1"), ["-Port", "32192"], root, logPath);

    expect(result.status).toBe(0);
    expect(readCommands(logPath)).toEqual([
      "npm ci",
      "npm run dev -- --hostname 127.0.0.1 --port 32192",
    ]);
  });

  it("builds production output before starting production mode", () => {
    const root = makeDeliveryProject({ withDependencies: true });
    const logPath = path.join(root, "commands.log");

    const result = runPowerShell(
      path.join(root, "scripts", "start.ps1"),
      ["-Mode", "prod", "-Port", "32193"],
      root,
      logPath,
    );

    expect(result.status).toBe(0);
    expect(readCommands(logPath)).toEqual([
      "npm run build",
      "npm run start -- --hostname 127.0.0.1 --port 32193",
    ]);
  });

  it("runs browser installation and every verification gate in full order", () => {
    const root = makeDeliveryProject({ withDependencies: false });
    const logPath = path.join(root, "commands.log");

    const result = runPowerShell(path.join(root, "scripts", "verify.ps1"), ["-InstallBrowser"], root, logPath);

    expect(result.status).toBe(0);
    expect(readCommands(logPath)).toEqual([
      "npm ci",
      "npx playwright install chromium",
      "npm run typecheck",
      "npm run lint",
      "npm test",
      "npm run build",
      "npm run test:e2e",
    ]);
    expect(result.stdout).toContain("All verification steps passed.");
  });

  it("forwards arguments and exit status through the start.cmd wrapper", () => {
    const root = makeDeliveryProject({ withDependencies: true });
    const logPath = path.join(root, "commands.log");

    const result = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        `& '${path.join(root, "start.cmd")}' -Port 32194`,
      ],
      { cwd: tmpdir(), env: deliveryEnvironment(root, logPath), encoding: "utf8", timeout: 15_000 },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readCommands(logPath)).toEqual(["npm run dev -- --hostname 127.0.0.1 --port 32194"]);
  });
});
