import { expect, test } from "./fixtures.ts";

test("the browser enhances the server-rendered search form", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  await page.getByRole("searchbox").fill("国立国会図書館");
  await expect(page.locator("article").first().getByRole("heading")).toHaveText(
    "国立国会図書館",
  );
});
