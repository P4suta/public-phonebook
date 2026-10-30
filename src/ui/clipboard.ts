import { copyMethod } from "../core/copy-policy.ts";

function copySelection(value: string, selectionClass: string): boolean {
  const focus = document.activeElement;
  const selection = document.getSelection();
  const ranges: Range[] = [];
  if (selection) {
    for (let index = 0; index < selection.rangeCount; index += 1)
      ranges.push(selection.getRangeAt(index).cloneRange());
  }
  const field = document.createElement("textarea");
  field.value = value;
  field.readOnly = true;
  field.tabIndex = -1;
  field.className = selectionClass;
  field.setAttribute("aria-hidden", "true");
  let handled = false;
  function populate(event: ClipboardEvent): void {
    if (!event.clipboardData) return;
    event.clipboardData.setData("text/plain", value);
    event.preventDefault();
    handled = true;
  }
  document.addEventListener("copy", populate, { once: true });
  try {
    document.body.appendChild(field);
    field.focus({ preventScroll: true });
    field.select();
    return document.execCommand("copy") && handled;
  } catch {
    return false;
  } finally {
    document.removeEventListener("copy", populate);
    field.remove();
    if (focus instanceof HTMLElement && focus.isConnected)
      focus.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) {
        if (range.commonAncestorContainer.isConnected)
          selection.addRange(range);
      }
    }
  }
}

export async function copyText(
  value: string,
  trusted: boolean,
  selectionClass: string,
): Promise<boolean> {
  const method = copyMethod(
    trusted,
    navigator.userActivation?.isActive !== false,
    typeof navigator.clipboard?.writeText === "function",
  );
  switch (method) {
    case "blocked":
      return false;
    case "selection":
      return copySelection(value, selectionClass);
    case "clipboard":
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        return false;
      }
  }
}
