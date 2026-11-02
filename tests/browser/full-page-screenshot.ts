import type { Page, TestInfo } from "@playwright/test";

/** Firefox can't draw a screenshot side longer than this many device pixels. */
const largestScreenshotSide = 32_767;

/** Saves the whole page as top-to-bottom tiles that every engine can draw, however long the page grows. */
export async function recordFullPage(
  page: Page,
  info: TestInfo,
  name: string,
): Promise<void> {
  const { width, height, scale } = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    scale: devicePixelRatio,
  }));
  const tile = Math.floor(largestScreenshotSide / scale);
  const count = Math.ceil(height / tile);
  for (let index = 0; index < count; index += 1) {
    const top = index * tile;
    await page.screenshot({
      path: info.outputPath(
        count === 1 ? `${name}.png` : `${name}-${index + 1}.png`,
      ),
      fullPage: true,
      clip: { x: 0, y: top, width, height: Math.min(tile, height - top) },
    });
  }
}
