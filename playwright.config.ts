import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results/playwright",
  fullyParallel: false,
  forbidOnly: true,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL,
    colorScheme: "light",
    locale: "zh-CN",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  expect: {
    timeout: 10_000,
  },
  projects: [
    {
      name: "desktop-1024",
      use: { viewport: { width: 1024, height: 768 } },
    },
    {
      name: "desktop-1280",
      use: { viewport: { width: 1280, height: 800 } },
    },
    {
      name: "desktop-1440",
      use: { viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3100",
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
