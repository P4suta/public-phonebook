export function enhanceReference(document: Document): void {
  for (const button of document.querySelectorAll(
    '.scalar-app button[role="none"], .scalar-app button[role="alert"]',
  ))
    button.removeAttribute("role");
  for (const editor of document.querySelectorAll(
    '.code-input-lite__editor[role="combobox"]:not([aria-expanded])',
  ))
    editor.setAttribute("aria-expanded", "false");
  for (const editor of document.querySelectorAll(
    '.cm-content[role="textbox"]:not([aria-label]):not([aria-labelledby])',
  )) {
    const region = editor.closest('[role="region"][aria-label]');
    editor.setAttribute(
      "aria-label",
      `${region?.getAttribute("aria-label") ?? "コード"}のデータ`,
    );
    if (editor.getAttribute("contenteditable") === "false")
      editor.setAttribute("aria-readonly", "true");
  }
  for (const scroller of document.querySelectorAll(
    ".scalar-app .cm-scroller",
  )) {
    if (
      !(scroller instanceof HTMLElement) ||
      scroller.querySelector('[contenteditable="true"]')
    )
      continue;
    if (scroller.tabIndex !== 0) scroller.tabIndex = 0;
    if (scroller.getAttribute("role") !== "region")
      scroller.setAttribute("role", "region");
    if (!scroller.hasAttribute("aria-label"))
      scroller.setAttribute("aria-label", "データのスクロール");
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    '.scalar-app button:is([aria-label="Copy code"],[aria-label="コードをコピー"])[aria-controls]',
  )) {
    const target = button.getAttribute("aria-controls");
    if (target && !document.getElementById(target))
      button.removeAttribute("aria-controls");
  }
  for (const [source, label] of Object.entries({
    "Copy code": "コードをコピー",
    "Wrap lines": "行を折り返す",
  })) {
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      `.scalar-app button[aria-label="${source}"]`,
    ))
      button.setAttribute("aria-label", label);
  }
}
