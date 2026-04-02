import { test, expect, type Page } from "@playwright/test";

/**
 * PDF Viewer zoom + fullscreen-fit tests.
 *
 * Covers:
 *  - Inline → fullscreen refits the page (the cramped inline scale is dropped)
 *  - Trackpad pinch (wheel + ctrlKey) zooms the page in fullscreen
 *  - Pinch zoom is ignored in inline mode
 */

test.setTimeout(120000);

function getAppFrame(page: Page) {
  return page.frameLocator("iframe").first().frameLocator("iframe").first();
}

async function loadPdfServer(page: Page) {
  await page.goto("/?theme=hide");
  await expect(page.locator("select").first()).toBeEnabled({ timeout: 30000 });
  await page.locator("select").first().selectOption({ label: "PDF Server" });
  await page.click('button:has-text("Call Tool")');
  // Wait for nested app iframe to mount
  const outer = page.frameLocator("iframe").first();
  await expect(outer.locator("iframe")).toBeVisible({ timeout: 30000 });
}

async function waitForPdfRender(page: Page) {
  const app = getAppFrame(page);
  // Canvas reports a non-zero CSS width once renderPage() has sized it.
  // toBeVisible alone isn't enough — the canvas exists at 0×0 before
  // first paint, so a fast test would race the render.
  await expect
    .poll(
      async () => {
        const w = await app
          .locator("#pdf-canvas")
          .evaluate((el: HTMLCanvasElement) => parseFloat(el.style.width));
        return w > 0 ? w : 0;
      },
      { timeout: 30000 },
    )
    .toBeGreaterThan(0);
}

/** Read the current zoom level (e.g. "65%") and return the integer percent. */
async function readZoomPercent(page: Page): Promise<number> {
  const text = await getAppFrame(page).locator("#zoom-level").textContent();
  const m = text?.match(/(\d+)%/);
  if (!m) throw new Error(`Unexpected zoom-level text: ${text}`);
  return parseInt(m[1], 10);
}

test.describe("PDF Viewer — fullscreen fit + pinch zoom", () => {
  // Narrow viewport so the inline iframe is tighter than the natural page
  // width. The default arxiv PDF is ~612pt ≈ 816 CSS px; at 600px viewport
  // the basic-host iframe is well under that → fit-to-width kicks in below
  // 100% inline. Fullscreen widens the iframe to viewport width — still
  // 600px, so we can't observe a *change* from width alone. Instead we
  // observe that the zoom level is the FIT value, not a stale value left
  // over from a previous narrower state.
  test.use({ viewport: { width: 1400, height: 800 } });

  test("entering fullscreen drops the inline shrink-to-fit scale", async ({
    page,
  }) => {
    await loadPdfServer(page);
    await waitForPdfRender(page);
    const app = getAppFrame(page);

    // Squeeze the basic-host page so the inline iframe is narrow. The
    // viewer's containerDimensions handler should refit on this resize.
    await page.setViewportSize({ width: 500, height: 800 });
    // Poll for the refit to land — the host emits containerDimensions on
    // resize, which triggers refitToWidth() async.
    await expect
      .poll(() => readZoomPercent(page), { timeout: 10000 })
      .toBeLessThan(100);
    const inlineZoom = await readZoomPercent(page);

    // Now widen back so fullscreen has room, and click the fullscreen button.
    await page.setViewportSize({ width: 1400, height: 800 });
    await app.locator("#fullscreen-btn").click();
    await expect(app.locator(".main.fullscreen")).toBeVisible({
      timeout: 5000,
    });

    // Zoom should snap to 100% (fullscreen container > natural page width).
    // Before the fix, computeFitToWidthScale returned null when the page
    // already fit at 1.0 → the cramped inline scale stuck.
    await expect.poll(() => readZoomPercent(page), { timeout: 5000 }).toBe(100);
    expect(inlineZoom).toBeLessThan(100); // sanity: we did observe a change
  });

  test("trackpad pinch (wheel + ctrlKey) zooms in fullscreen", async ({
    page,
  }) => {
    await loadPdfServer(page);
    await waitForPdfRender(page);
    const app = getAppFrame(page);

    // Go fullscreen first — pinch is fullscreen-only.
    await app.locator("#fullscreen-btn").click();
    await expect(app.locator(".main.fullscreen")).toBeVisible({
      timeout: 5000,
    });
    // Let the entering-fullscreen refit settle.
    await expect.poll(() => readZoomPercent(page), { timeout: 5000 }).toBe(100);

    // Dispatch a synthetic trackpad pinch on the canvas-container.
    // ctrlKey:true is what Chrome/FF/Edge/Safari emit for trackpad pinch;
    // deltaY < 0 = zoom in. We can't use page.mouse.wheel — it doesn't
    // expose ctrlKey — so dispatch directly inside the iframe.
    await app.locator(".canvas-container").evaluate((el) => {
      el.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -50,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    // The viewer applies a CSS transform live, then commits to a real
    // renderPage() after a 150ms settle timer. Poll for the committed zoom.
    await expect
      .poll(() => readZoomPercent(page), { timeout: 5000 })
      .toBeGreaterThan(100);

    // The CSS transform should be cleared once committed (so the canvas
    // isn't double-scaled — the new render IS the new scale).
    await expect
      .poll(
        () =>
          app
            .locator(".page-wrapper")
            .evaluate((el: HTMLElement) => el.style.transform),
        { timeout: 5000 },
      )
      .toBe("");
  });

  test("trackpad pinch is ignored outside fullscreen", async ({ page }) => {
    await loadPdfServer(page);
    await waitForPdfRender(page);
    const app = getAppFrame(page);

    const before = await readZoomPercent(page);

    await app.locator(".canvas-container").evaluate((el) => {
      el.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -50,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    // No settle timer should have started — zoom stays put.
    await page.waitForTimeout(300);
    expect(await readZoomPercent(page)).toBe(before);
  });
});
