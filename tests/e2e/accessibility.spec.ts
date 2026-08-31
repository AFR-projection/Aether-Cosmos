import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const publicRoutes = ["/login", "/register"] as const;
const locales = ["en", "id", "zh-CN"] as const;

for (const locale of locales) {
  for (const route of publicRoutes) {
    test(`${route} has no WCAG A/AA violations in ${locale}`, async ({ context, page }) => {
      await context.addCookies([{
        name: "locale",
        value: locale,
        url: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
        sameSite: "Lax",
      }]);
      await page.goto(route);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page.locator("main")).toBeVisible();

      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });
  }
}

test("login remains keyboard-usable at 200% zoom", async ({ page }) => {
  await page.goto("/login");
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
});
