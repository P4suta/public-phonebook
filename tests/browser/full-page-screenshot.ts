import { writeFile } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";

/** Firefox can't draw a screenshot side longer than this many device pixels. */
const largestScreenshotSide = 32_767;
const nativeFrameTimeoutMs = 5000;

export async function recordViewport(
  page: Page,
  info: TestInfo,
  name: string,
): Promise<void> {
  if (page.context().browser()?.browserType().name() !== "webkit") {
    await page.screenshot({
      path: info.outputPath(`${name}.png`),
      caret: "initial",
    });
    return;
  }
  const viewport = page.viewportSize();
  if (!viewport)
    throw new Error("Native frame capture requires a known viewport");
  await page.evaluate(() => document.fonts.ready);
  const scroll = await page.evaluate(() => ({
    x: scrollX,
    y: scrollY,
    scale: devicePixelRatio,
  }));
  let receive: ((data: Buffer, width: number, height: number) => void) | null =
    null;
  let lastFrame = "none";
  const subscription = await page.screencast.start({
    quality: 100,
    size: {
      width: viewport.width * scroll.scale,
      height: viewport.height * scroll.scale,
    },
    onFrame: ({ data, viewportWidth, viewportHeight }): void => {
      lastFrame = `${viewportWidth}x${viewportHeight}`;
      receive?.(data, viewportWidth, viewportHeight);
    },
  });
  async function frameAt(size: {
    readonly width: number;
    readonly height: number;
  }): Promise<Buffer> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = new Promise<Buffer>((resolve, reject) => {
      receive = (data, width, height): void => {
        if (width === size.width && height === size.height) resolve(data);
      };
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `WebKit produced no frame at ${size.width}x${size.height}; last frame: ${lastFrame}`,
            ),
          ),
        nativeFrameTimeoutMs,
      );
    });
    try {
      const [data] = await Promise.all([frame, page.setViewportSize(size)]);
      return data;
    } finally {
      if (timer) clearTimeout(timer);
      receive = null;
    }
  }
  try {
    await frameAt({
      width: viewport.width + 2,
      height: viewport.height,
    });
    const captured = await frameAt(viewport);
    await writeFile(info.outputPath(`${name}.jpg`), captured);
  } finally {
    receive = null;
    try {
      await page.setViewportSize(viewport);
      await page.evaluate(
        ({ x, y }) => window.scrollTo({ left: x, top: y, behavior: "instant" }),
        scroll,
      );
    } finally {
      await subscription.dispose();
    }
  }
}

/** Saves the whole page as top-to-bottom tiles that every engine can draw, however long the page grows. */
export async function recordFullPage(
  page: Page,
  info: TestInfo,
  name: string,
): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const { width, height, scale } = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    scale: devicePixelRatio,
  }));
  const native = page.context().browser()?.browserType().name() === "webkit";
  const viewport = page.viewportSize();
  const tile =
    native && viewport
      ? viewport.height
      : Math.floor(largestScreenshotSide / scale);
  const count = Math.ceil(height / tile);
  const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  try {
    for (let index = 0; index < count; index += 1) {
      const top = index * tile;
      const part = count === 1 ? name : `${name}-${index + 1}`;
      if (native) {
        await page.evaluate(
          (top) => window.scrollTo({ top, behavior: "instant" }),
          top,
        );
        await recordViewport(page, info, part);
        continue;
      }
      await page.screenshot({
        caret: "initial",
        path: info.outputPath(`${part}.png`),
        fullPage: true,
        clip: { x: 0, y: top, width, height: Math.min(tile, height - top) },
      });
    }
  } finally {
    if (native)
      await page.evaluate(
        ({ x, y }) => window.scrollTo({ left: x, top: y, behavior: "instant" }),
        scroll,
      );
  }
}
