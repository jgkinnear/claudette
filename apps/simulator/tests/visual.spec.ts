import { expect, test, type Page } from "@playwright/test";
import { scenarios } from "@claudette/protocol";
import { lookFor } from "@claudette/lvgl-ui/sprites";

// Drives the real LVGL UI (WebAssembly) through every demo scenario.
// Run `pnpm build:sim` (or `pnpm --filter @claudette/simulator wasm`) first.

type Debug = {
  pump(ms?: number): void;
  tap(x: number, y: number, holdMs?: number): void;
  hit(x: number, y: number): string;
  look(seed: string): string;
};

async function open(page: Page, query: string) {
  await page.goto(`/?motion=reduce&layout=list&${query}`);
  await page.waitForFunction(() => "claudette" in window);
  // Capture at the panel's native 320×480.
  await page.evaluate(() => document.getElementById("device")!.style.setProperty("--zoom", "1"));
  await pump(page, 800);
}

const pump = (page: Page, ms: number) =>
  page.evaluate((m) => (window as unknown as { claudette: Debug }).claudette.pump(m), ms);
const tap = (page: Page, x: number, y: number, hold = 80) =>
  page.evaluate(([a, b, h]) => (window as unknown as { claudette: Debug }).claudette.tap(a!, b!, h!), [x, y, hold]);
const activeScreen = (page: Page) =>
  page.evaluate(() => (window as unknown as { claudette: Debug }).claudette.hit(1, 1).match(/act=(\w+)/)![1]);

for (const sc of scenarios) {
  test(`scenario: ${sc.id}`, async ({ page }) => {
    await open(page, `scenario=${sc.id}`);
    await expect(page.locator("#screen")).toHaveScreenshot(`${sc.id}.png`);
  });
}

test("tapping a session opens its detail, Back returns", async ({ page }) => {
  await open(page, "scenario=needs-you");
  const home = await activeScreen(page);
  await tap(page, 200, 95);
  await pump(page, 400);
  expect(await activeScreen(page)).not.toBe(home);
  await expect(page.locator("#screen")).toHaveScreenshot("detail-needs-you.png");
  await tap(page, 40, 26);
  await pump(page, 400);
  expect(await activeScreen(page)).toBe(home);
});

test("long-press pins a session", async ({ page }) => {
  await open(page, "scenario=one-working");
  await tap(page, 200, 95, 700);
  await pump(page, 300);
  await expect(page.locator("#screen")).toHaveScreenshot("pinned-toast.png");
});

test("pages: agents and usage", async ({ page }) => {
  await open(page, "scenario=helpers");
  await tap(page, 160, 455);
  await pump(page, 600);
  await expect(page.locator("#screen")).toHaveScreenshot("page-agents.png");
  await tap(page, 266, 455);
  await pump(page, 600);
  await expect(page.locator("#screen")).toHaveScreenshot("page-usage.png");
});

test("settings screen", async ({ page }) => {
  await open(page, "scenario=tour");
  await tap(page, 296, 26);
  await pump(page, 400);
  await expect(page.locator("#screen")).toHaveScreenshot("settings.png");
});

test("device and JS pick the same look for every session", async ({ page }) => {
  await open(page, "scenario=empty");
  const seeds = ["", "s1", "tour-maps", "tour-api", "sFfa9Q-xY_2", "café ✿", ...Array.from({ length: 200 }, (_, i) => `s${i}x${i * 7919}`)];
  const device = await page.evaluate(
    (ids) => ids.map((id) => (window as unknown as { claudette: Debug }).claudette.look(id)),
    seeds,
  );
  const js = seeds.map((id) => {
    const l = lookFor(id);
    return `${l.body},${l.hw},${l.accent},${l.extra}`;
  });
  expect(device).toEqual(js);
});

test("layout toggle switches between list and tiles", async ({ page }) => {
  await open(page, "scenario=many&layout=list");
  await tap(page, 246, 26);
  await pump(page, 2000); // let the toast fade
  await expect(page.locator("#screen")).toHaveScreenshot("tiles-many.png");
  await tap(page, 246, 26);
  await pump(page, 2000);
  await expect(page.locator("#screen")).toHaveScreenshot("many.png");
});
