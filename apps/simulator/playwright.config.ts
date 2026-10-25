import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  use: { baseURL: "http://localhost:5181", viewport: { width: 1100, height: 900 } },
  // Rendering is deterministic (same LVGL build, reduced motion), so compare pixel-for-pixel.
  expect: { toHaveScreenshot: { maxDiffPixels: 0 } },
  webServer: {
    command: "pnpm exec vite --port 5181 --strictPort",
    url: "http://localhost:5181",
    reuseExistingServer: true,
  },
});
