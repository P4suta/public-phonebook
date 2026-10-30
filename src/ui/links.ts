const relativeUrlBase = "https://relative.invalid";

export function opensNewTab(href: string): boolean {
  if (!URL.canParse(href, relativeUrlBase)) return false;
  const url = new URL(href, relativeUrlBase);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    (URL.canParse(href) || url.origin !== relativeUrlBase)
  );
}
