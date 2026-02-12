import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : 16, // Parallel execution now works with factory pattern
  timeout: 30000, // 30s per test
  reporter: process.env.CI ? "list" : "html",
  // Use platform-agnostic snapshot names (no -darwin/-linux suffix)
  snapshotPathTemplate:
    "{testDir}/{testFileDir}/{testFileName}-snapshots/{arg}{ext}",
  use: {
    baseURL: "http://localhost:8080",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Use default Chromium everywhere for consistent screenshot rendering
        // Run `npm run test:e2e:docker` locally for CI-identical results
      },
    },
  ],
  // Run examples server before tests
  // Supports EXAMPLE=<folder> env var to run a single example (e.g., EXAMPLE=say-server npm run test:e2e)
  webServer: {
    command: "npm run examples:start",
    url: "http://localhost:8080",
    // Always start fresh servers to avoid stale state issues
    reuseExistingServer: false,
    // 3 minutes to allow uv to download Python dependencies on first run
    timeout: 180000,
    // Pass through EXAMPLE env var to filter to a single server
    env: {
      ...process.env,
      EXAMPLE: process.env.EXAMPLE ?? "",
    },
  },
  // Snapshot configuration
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.06,
      animations: "disabled",
    },
  },
});
