import { expect, test } from "@playwright/test";

interface Finding {
  rule: string;
  subject: string;
  property: string;
  value: string;
}

function inspectMonochrome(): Finding[] {
  const findings: Finding[] = [];
  const allowed = new Set([
    "black",
    "white",
    "#000",
    "#fff",
    "#000000",
    "#ffffff",
    "rgb(0,0,0)",
    "rgb(255,255,255)",
    "rgba(0,0,0,1)",
    "rgba(255,255,255,1)",
    "rgba(0,0,0,0)",
    "rgba(255,255,255,0)",
    "transparent",
    "currentcolor",
    "inherit",
    "initial",
    "unset",
    "none",
  ]);
  const colorProperties = [
    "color",
    "background-color",
    "border-top-color",
    "border-right-color",
    "border-bottom-color",
    "border-left-color",
    "outline-color",
    "text-decoration-color",
    "caret-color",
    "fill",
    "stroke",
    "stop-color",
    "accent-color",
  ];
  const check = (
    style: CSSStyleDeclaration,
    subject: string,
    authored: boolean,
  ): void => {
    for (const property of colorProperties) {
      const value = style.getPropertyValue(property).trim();
      if (
        value &&
        value !== "auto" &&
        !allowed.has(value.toLowerCase().replaceAll(/\s/g, ""))
      )
        findings.push({ rule: "palette", subject, property, value });
    }
    for (const property of [
      "background-image",
      "border-image-source",
      "mask-image",
      "list-style-image",
    ]) {
      const value = style.getPropertyValue(property);
      if (value.toLowerCase().includes("gradient("))
        findings.push({ rule: "gradient", subject, property, value });
    }
    for (const property of ["box-shadow", "text-shadow"]) {
      const value = style.getPropertyValue(property);
      if (value && !["none", "initial", "unset", "inherit"].includes(value))
        findings.push({ rule: "shadow", subject, property, value });
    }
    const opacity = style.getPropertyValue("opacity");
    if (opacity && Number(opacity) !== 1)
      findings.push({
        rule: "opacity",
        subject,
        property: "opacity",
        value: opacity,
      });
    for (const property of [
      "filter",
      "backdrop-filter",
      "-webkit-backdrop-filter",
    ]) {
      const value = style.getPropertyValue(property);
      if (value && value !== "none")
        findings.push({ rule: "filter", subject, property, value });
    }
    for (const property of ["mix-blend-mode", "background-blend-mode"]) {
      const value = style.getPropertyValue(property);
      if (value && value !== "normal")
        findings.push({ rule: "blend", subject, property, value });
    }
    if (authored) {
      for (const property of Array.from(style)) {
        if (!property.startsWith("--")) continue;
        const value = style.getPropertyValue(property).trim();
        if (
          CSS.supports("color", value) &&
          !allowed.has(value.toLowerCase().replaceAll(/\s/g, ""))
        )
          findings.push({ rule: "palette", subject, property, value });
        if (value.toLowerCase().includes("gradient("))
          findings.push({ rule: "gradient", subject, property, value });
      }
    }
  };
  const visit = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if ("style" in rule && rule.style instanceof CSSStyleDeclaration)
        check(rule.style, rule.cssText.split("{")[0] ?? "rule", true);
      if ("cssRules" in rule && rule.cssRules instanceof CSSRuleList)
        visit(rule.cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch {
      findings.push({
        rule: "unreadable-stylesheet",
        subject: sheet.href ?? "inline stylesheet",
        property: "cssRules",
        value: "unavailable",
      });
    }
  }
  for (const element of Array.from(document.querySelectorAll("body, body *"))) {
    if (!(element instanceof HTMLElement || element instanceof SVGElement))
      continue;
    check(element.style, element.tagName, true);
    if (element.getBoundingClientRect().height === 0) continue;
    check(getComputedStyle(element), element.tagName, false);
    for (const pseudo of ["::before", "::after"]) {
      const style = getComputedStyle(element, pseudo);
      if (style.content && !["none", "normal", '""'].includes(style.content))
        check(style, `${element.tagName}${pseudo}`, false);
    }
  }
  return findings;
}

test("the service name is the page heading and search appears immediately", async ({
  page,
}, info) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Public Phonebook",
  );
  const search = page.getByLabel("施設名か電話番号");
  const bounds = await search.boundingBox();
  expect(bounds?.y).toBeLessThan(260);
  await page.screenshot({
    path: info.outputPath("monochrome-directory.png"),
    fullPage: false,
  });
});

test("authored and rendered styles use black and white without tonal effects", async ({
  page,
}) => {
  for (const path of [
    "/",
    "/?q=試験",
    "/?q=no-such-facility",
    "/contacts/13:dental/source",
    "/contacts/13:library",
    "/data",
    "/api/docs",
    "/?prefecture=48",
    "/missing",
  ]) {
    await page.goto(path);
    const violations = await page.evaluate(inspectMonochrome);
    expect(violations.slice(0, 10)).toEqual([]);
  }
});

test("the design check rejects prohibited colours and effects", async ({
  page,
}) => {
  await page.setContent(
    '<!doctype html><html><body><h1 class="probe">Test service</h1></body></html>',
  );
  const cases = [
    ["color:#777", "palette"],
    ["background:rgb(240,240,240)", "palette"],
    ["border:1px solid red", "palette"],
    ["color:rgba(0,0,0,.5)", "palette"],
    ["background:linear-gradient(black,white)", "gradient"],
    ["border-image:linear-gradient(black,white) 1", "gradient"],
    ["box-shadow:0 1px 3px black", "shadow"],
    ["text-shadow:1px 1px black", "shadow"],
    ["opacity:.5", "opacity"],
    ["filter:contrast(.8)", "filter"],
    ["background-blend-mode:multiply", "blend"],
    ["--shade:#eee;color:var(--shade)", "palette"],
  ];
  for (const [declarations, expected] of cases) {
    const tag = await page.addStyleTag({
      content: `.probe { ${declarations} }`,
    });
    expect(
      (await page.evaluate(inspectMonochrome)).some(
        (finding) => finding.rule === expected,
      ),
    ).toBe(true);
    await tag.evaluate((element: HTMLStyleElement): void => {
      element.remove();
    });
  }
});

test("the design check accepts explicit black and white typography and rules", async ({
  page,
}) => {
  await page.setContent(
    "<!doctype html><html><body><h1>Test service</h1><p>Search contacts</p></body></html>",
  );
  await page.addStyleTag({
    content:
      "body { color:#000; background:#fff; } h1 { font-size:32px; font-weight:700; border-bottom:2px solid black; } p { color:rgb(0,0,0); text-decoration:underline; }",
  });
  expect(await page.evaluate(inspectMonochrome)).toEqual([]);
});
