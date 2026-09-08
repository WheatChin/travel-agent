import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

type RuntimeLog = {
  consoleErrors: string[];
  pageErrors: string[];
  failedResponses: string[];
  failedRequests: string[];
  remoteRequests: string[];
};

function observeRuntime(page: Page): RuntimeLog {
  const log: RuntimeLog = {
    consoleErrors: [],
    pageErrors: [],
    failedResponses: [],
    failedRequests: [],
    remoteRequests: [],
  };

  page.on("console", (message) => {
    if (message.type() === "error") log.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => log.pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname !== "127.0.0.1" &&
      url.hostname !== "localhost"
    ) {
      log.remoteRequests.push(request.url());
    }
  });
  page.on("requestfailed", (request) => {
    log.failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      log.failedResponses.push(`${response.status()} ${response.url()}`);
    }
  });

  return log;
}

function expectCleanRuntime(log: RuntimeLog) {
  expect(log.consoleErrors, "browser console errors").toEqual([]);
  expect(log.pageErrors, "uncaught page errors").toEqual([]);
  expect(log.failedResponses, "HTTP responses with status >= 400").toEqual([]);
  expect(log.failedRequests, "failed browser requests").toEqual([]);
  expect(log.remoteRequests, "unexpected remote network requests").toEqual([]);
}

async function openWorkspace(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("trip-library")).toBeVisible();
  await page.getByRole("button", { name: "打开北京三日文化之旅" }).click();
  await expect(page.getByTestId("itinerary-workspace")).toBeVisible();
}

async function expectNoHorizontalPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    bodyScrollWidth: document.body.scrollWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.bodyScrollWidth, "body horizontal overflow").toBeLessThanOrEqual(
    dimensions.innerWidth,
  );
  expect(dimensions.documentScrollWidth, "document horizontal overflow").toBeLessThanOrEqual(
    dimensions.innerWidth,
  );
}

async function expectPanelsDoNotOverlap(page: Page) {
  const boxes = await page.evaluate((panelSelectors) => {
    const panels = panelSelectors.flatMap((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return [];
      const box = element.getBoundingClientRect();
      return [{ selector, left: box.left, right: box.right, top: box.top, bottom: box.bottom }];
    });
    return { panels, viewport: { width: window.innerWidth, height: window.innerHeight } };
  }, [".detail-panel", ".conversation-panel"]);

  for (const panel of boxes.panels) {
    expect(panel.left, `${panel.selector} extends past the left viewport edge`).toBeGreaterThanOrEqual(0);
    expect(panel.right, `${panel.selector} extends past the right viewport edge`).toBeLessThanOrEqual(
      boxes.viewport.width,
    );
    expect(panel.top, `${panel.selector} extends above the viewport`).toBeGreaterThanOrEqual(0);
    expect(panel.bottom, `${panel.selector} extends below the viewport`).toBeLessThanOrEqual(
      boxes.viewport.height,
    );
  }

  for (let first = 0; first < boxes.panels.length; first += 1) {
    for (let second = first + 1; second < boxes.panels.length; second += 1) {
      const a = boxes.panels[first];
      const b = boxes.panels[second];
      const intersectionWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const intersectionHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      expect(
        intersectionWidth > 1 && intersectionHeight > 1,
        `${a.selector} overlaps ${b.selector}`,
      ).toBe(false);
    }
  }
}

async function saveScreenshot(page: Page, projectName: string, name: string) {
  const artifactDirectory = path.join(
    process.cwd(),
    "docs",
    "reviews",
    "artifacts",
    "phase1",
  );
  await mkdir(artifactDirectory, { recursive: true });
  await page.screenshot({
    path: path.join(artifactDirectory, `${projectName}-${name}.png`),
    fullPage: true,
    animations: "disabled",
    caret: "initial",
  });
}

test("library and labelled map shortcut open the requested projection", async ({ page }) => {
  const runtime = observeRuntime(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "我的行程" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "北京三日文化之旅" })).toBeVisible();
  await expect(page.getByText("北京 · 3 天 · 版本 1")).toBeVisible();

  await page.getByRole("button", { name: "打开地图视图" }).click();
  await expect(page.getByTestId("map-shell")).toBeVisible();
  await expect(page.getByText("地图服务未连接")).toBeVisible();
  await expect(page.getByText("布局不代表真实坐标，也未绘制路线。", { exact: false })).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
  expectCleanRuntime(runtime);
});

test("one version and day, Visit, and Leg selections persist across projections", async ({ page }) => {
  const runtime = observeRuntime(page);
  await openWorkspace(page);

  await expect(page.getByRole("heading", { name: "北京三日文化之旅" })).toBeVisible();
  await expect(page.getByText("北京 · 3 天 · 版本 1")).toBeVisible();
  const projection = page.getByRole("region", { name: "行程列表" });
  await page.getByTestId("day-tab-3").click();
  await expect
    .poll(() => projection.evaluate((element) => Math.round(element.scrollTop)))
    .toBeGreaterThan(0);
  await page.getByTestId("day-tab-0").click();
  await expect
    .poll(() => projection.evaluate((element) => Math.round(element.scrollTop)))
    .toBe(0);
  await page.getByTestId("day-tab-2").click();
  await expect(page.getByTestId("day-tab-2")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#day-1")).toBeAttached();
  await expect(page.locator("#day-2")).toBeAttached();
  await expect(page.locator("#day-3")).toBeAttached();
  await expect(page.getByRole("heading", { name: "第 2 天 · 坛庙与老城" })).toBeVisible();

  await page.getByTestId("visit-visit_temple-of-heaven").click();
  await expect(page.getByTestId("visit-visit_temple-of-heaven")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("complementary", { name: "地点详情" })).toContainText("天坛公园");
  await expect(page.getByRole("complementary", { name: "地点详情" })).toContainText("09:00–11:30");

  await page.getByTestId("view-map").click();
  await expect(page.getByTestId("day-tab-2")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("marker-visit_temple-of-heaven")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("complementary", { name: "地点详情" })).toContainText("天坛公园");

  await page.getByRole("button", { name: "收起规划对话" }).click();
  await expect(page.getByTestId("conversation-panel")).toBeHidden();
  await page.getByTestId("view-list").click();
  await expect(page.getByTestId("visit-visit_temple-of-heaven")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByTestId("leg-leg_temple-of-heaven-to-qianmen").click();
  await expect(page.getByRole("complementary", { name: "行程段详情" })).toContainText(
    "公共交通",
  );
  await expect(page.getByRole("complementary", { name: "行程段详情" })).toContainText(
    "路线几何未接入",
  );

  await page.getByTestId("view-map").click();
  await expect(page.getByRole("complementary", { name: "行程段详情" })).toBeVisible();
  await page.getByTestId("open-conversation").click();
  await expect(page.getByTestId("conversation-panel")).toBeVisible();
  await expect(page.getByRole("complementary", { name: "行程段详情" })).toBeVisible();
  await expectPanelsDoNotOverlap(page);
  await expectNoHorizontalPageOverflow(page);
  expectCleanRuntime(runtime);
});

test("fixture pending, rejected, cancelled, and phase states retain version 1", async ({ page }) => {
  const runtime = observeRuntime(page);
  await page.goto("/");
  const scenario = page.getByLabel("演示状态");

  for (const [value, notice] of [
    ["pending", "修改等待中；当前仍为版本 1。"],
    ["failed", "修改被拒绝；版本 1 已保留。"],
    ["cancelled", "修改已取消；版本 1 已保留。"],
  ] as const) {
    await scenario.selectOption(value);
    if (!(await page.getByTestId("itinerary-workspace").isVisible().catch(() => false))) {
      await page.getByRole("button", { name: "打开北京三日文化之旅" }).click();
    }
    await expect(page.getByRole("status").filter({ hasText: notice })).toBeVisible();
    await expect(page.getByText("北京 · 3 天 · 版本 1")).toBeVisible();
    await page.getByTestId("day-tab-2").click();
    await expect(page.getByTestId("visit-visit_temple-of-heaven")).toBeVisible();
  }

  await scenario.selectOption("failed");
  await page.getByTestId("visit-visit_temple-of-heaven").click();
  await page.getByTestId("open-edit-dialog").click();
  await page.getByRole("button", { name: "提交演示命令" }).click();
  await expect(page.getByTestId("edit-outcome")).toContainText(
    "演示命令被拒绝：计划时段冲突。当前版本已保留。",
  );
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.getByText("北京 · 3 天 · 版本 1")).toBeVisible();

  await scenario.selectOption("status");
  await expect(page.getByRole("status").filter({ hasText: "固定阶段演示" })).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
  expectCleanRuntime(runtime);
});

test("empty library and image failure are explicit accessible fixture states", async ({ page }) => {
  const runtime = observeRuntime(page);
  await page.goto("/");
  const scenario = page.getByLabel("演示状态");

  await scenario.selectOption("empty");
  await expect(page.getByTestId("empty-library")).toContainText("还没有行程");
  await expect(page.getByTestId("empty-library").getByRole("button", { name: "创建行程" })).toBeVisible();

  await scenario.selectOption("image-failure");
  await expect(page.getByRole("img", { name: "故宫博物院建筑（图片暂不可用）" })).toBeVisible();
  await page.getByRole("button", { name: "打开北京三日文化之旅" }).click();
  await expect(page.getByRole("img", { name: /图片暂不可用/ })).toHaveCount(6);
  await expect(page.getByText("图片暂不可用", { exact: true })).toHaveCount(6);
  await expectNoHorizontalPageOverflow(page);
  expectCleanRuntime(runtime);
});

test("conversation is toggleable and rejects unsupported free-form generation", async ({ page }) => {
  const runtime = observeRuntime(page);
  await openWorkspace(page);

  const conversation = page.getByRole("complementary", { name: "规划对话" });
  await expect(conversation).toContainText("固定夹具，尚未连接实时服务");
  await page.getByLabel("输入规划消息").fill("替我生成一个上海周末行程");
  await page.getByRole("button", { name: "发送演示消息" }).click();
  await expect(conversation).toContainText("当前阶段不支持任意对话生成行程");
  await expect(conversation).toContainText("固定演示 · 不会调用模型");

  await page.getByRole("button", { name: "收起规划对话" }).click();
  await expect(conversation).toBeHidden();
  await page.getByRole("button", { name: "打开规划对话" }).click();
  await expect(conversation).toBeVisible();
  expectCleanRuntime(runtime);
});

test("dialog traps keyboard focus, closes with Escape, and restores its trigger", async ({ page }) => {
  const runtime = observeRuntime(page);
  await page.goto("/");

  const trigger = page.getByTestId("create-trip-button");
  await trigger.focus();
  await trigger.press("Enter");
  const dialog = page.getByRole("dialog", { name: "创建行程" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "关闭对话框" })).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "记录演示输入" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "关闭对话框" })).toBeFocused();

  const destination = page.getByLabel("目的地");
  await destination.fill("上海");
  await expect(destination).toBeFocused();
  await expect(destination).toHaveValue("上海");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expectCleanRuntime(runtime);
});

test("date form cancel and simulated submit do not rewrite the immutable card", async ({ page }) => {
  const runtime = observeRuntime(page);
  await page.goto("/");

  await expect(page.getByText("未设置出行日期", { exact: true })).toBeVisible();
  const dateTrigger = page.getByTestId("edit-date-button");
  await dateTrigger.click();
  const dateInput = page.getByLabel("开始日期");
  await dateInput.fill("2026-10-01");
  await expect(dateInput).toBeFocused();
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.getByText("未设置出行日期", { exact: true })).toBeVisible();

  await dateTrigger.click();
  await expect(page.getByLabel("开始日期")).toHaveValue("");
  await page.getByLabel("开始日期").fill("2026-10-02");
  await page.getByRole("button", { name: "暂存日期" }).click();
  await expect(page.getByRole("status")).toContainText("日期已记录为演示输入");
  await expect(page.getByText("未设置出行日期", { exact: true })).toBeVisible();
  expectCleanRuntime(runtime);
});

test("return navigation and local venue images remain usable", async ({ page }) => {
  const runtime = observeRuntime(page);
  await openWorkspace(page);

  const images = page.locator(".visit-image").filter({ visible: true });
  await expect(images).toHaveCount(6);
  for (let index = 0; index < 6; index += 1) {
    await expect(images.nth(index)).toHaveJSProperty("complete", true);
    expect(await images.nth(index).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  }

  await page.getByTestId("back-to-library").click();
  await expect(page.getByTestId("trip-library")).toBeVisible();
  await expect(page.getByRole("heading", { name: "北京三日文化之旅" })).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
  expectCleanRuntime(runtime);
});

test("capture desktop visual evidence for library, List, detail, and Map", async ({ page }, testInfo) => {
  const runtime = observeRuntime(page);
  await page.goto("/");
  const search = page.getByPlaceholder("搜索目的地或行程");
  await search.fill("不存在的行程");
  await expect(page.getByTestId("empty-library")).toContainText("没有匹配的行程");
  await search.fill("");
  await expect(page.getByRole("heading", { name: "北京三日文化之旅" })).toBeVisible();
  await search.blur();
  await saveScreenshot(page, testInfo.project.name, "library");

  await page.getByRole("button", { name: "打开北京三日文化之旅" }).click();
  await page.getByTestId("day-tab-2").click();
  await saveScreenshot(page, testInfo.project.name, "day2-list");

  await page.getByTestId("visit-visit_temple-of-heaven").click();
  await saveScreenshot(page, testInfo.project.name, "temple-detail");

  await page.getByTestId("view-map").click();
  await saveScreenshot(page, testInfo.project.name, "day2-map");
  await expectPanelsDoNotOverlap(page);
  await expectNoHorizontalPageOverflow(page);
  expectCleanRuntime(runtime);
});
