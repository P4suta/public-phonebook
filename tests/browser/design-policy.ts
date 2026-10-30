import type { Page } from "@playwright/test";

export interface DesignAudit {
  readonly rules: number;
  readonly elements: number;
  readonly runtimeRules: number;
  readonly violations: readonly string[];
}

export async function auditDesign(page: Page): Promise<DesignAudit> {
  return page.evaluate(() => {
    const violations: string[] = [];
    const host = document.createElement("div");
    host.hidden = true;
    document.body.appendChild(host);
    const probe = document.createElement("div");
    host.attachShadow({ mode: "closed" }).appendChild(probe);
    const colors = [
      "color",
      "background-color",
      "border-top-color",
      "border-right-color",
      "border-bottom-color",
      "border-left-color",
      "outline-color",
      "text-decoration-color",
      "fill",
      "stroke",
    ];
    const effects = [
      "box-shadow",
      "text-shadow",
      "filter",
      "backdrop-filter",
      "background-image",
      "mask-image",
      "-webkit-mask-image",
    ];
    const allowed = new Set([
      "rgb(0, 0, 0)",
      "rgb(255, 255, 255)",
      "rgba(0, 0, 0, 0)",
      "color(srgb 0 0 0)",
      "color(srgb 1 1 1)",
      "color(srgb 0 0 0 / 0)",
      "none",
    ]);
    function resolve(property: string, value: string): string {
      probe.style.setProperty(property, value);
      const resolved = getComputedStyle(probe).getPropertyValue(property);
      probe.style.removeProperty(property);
      return resolved;
    }
    function check(
      style: CSSStyleDeclaration,
      label: string,
      authored: boolean,
    ): void {
      for (const property of colors) {
        const value = style.getPropertyValue(property);
        if (!value) continue;
        let resolved = value;
        if (authored) {
          resolved = resolve("color", value);
        }
        if (!allowed.has(resolved))
          violations.push(`${label}: ${property}=${resolved}`);
      }
      for (const property of effects) {
        let value = style.getPropertyValue(property);
        if (authored && value) {
          value = resolve(property, value);
        }
        if (value && value !== "none")
          violations.push(`${label}: ${property}=${value}`);
      }
      for (const property of ["opacity", "fill-opacity", "stroke-opacity"]) {
        let opacity = style.getPropertyValue(property);
        if (authored && opacity) opacity = resolve(property, opacity);
        if (opacity && Number(opacity) !== 1 && Number(opacity) !== 0)
          violations.push(`${label}: ${property}=${opacity}`);
      }
      let blend = style.getPropertyValue("mix-blend-mode");
      if (authored && blend) blend = resolve("mix-blend-mode", blend);
      if (blend && blend !== "normal")
        violations.push(`${label}: mix-blend-mode=${blend}`);
    }
    let rules = 0;
    function visit(items: CSSRuleList): void {
      for (const rule of items) {
        if (rule instanceof CSSStyleRule) {
          rules += 1;
          check(rule.style, rule.selectorText, true);
        }
        if (rule instanceof CSSGroupingRule) visit(rule.cssRules);
      }
    }
    let runtimeRules = 0;
    for (const sheet of document.styleSheets) {
      if (
        document.querySelector("[data-api-reference]") &&
        sheet.ownerNode instanceof HTMLStyleElement &&
        !sheet.ownerNode.nonce
      ) {
        runtimeRules += sheet.cssRules.length;
        continue;
      }
      visit(sheet.cssRules);
    }
    let elements = 0;
    for (const element of document.body.querySelectorAll("*")) {
      if (element === host || element.getClientRects().length === 0) continue;
      elements += 1;
      check(getComputedStyle(element), element.tagName, false);
      for (const pseudo of ["::before", "::after"]) {
        const style = getComputedStyle(element, pseudo);
        if (style.content !== "none" && style.content !== "normal")
          check(style, `${element.tagName}${pseudo}`, false);
      }
    }
    host.remove();
    return { rules, elements, runtimeRules, violations };
  });
}
