import type { Contact } from "./models.ts";

const maximumLineOctets = 75;

export function escapeVCard(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,");
}

export function foldVCardLine(line: string): string {
  const rows: string[] = [];
  let current = "";
  let bytes = 0;
  for (const point of line) {
    const length = new TextEncoder().encode(point).length;
    if (bytes + length > maximumLineOctets) {
      rows.push(current);
      current = " ";
      bytes = 1;
    }
    current += point;
    bytes += length;
  }
  rows.push(current);
  return rows.join("\r\n");
}

export function contactVCard(contact: Contact): string {
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `UID:${escapeVCard(contact.id)}`,
    `FN:${escapeVCard(contact.name)}`,
    `ORG:${escapeVCard(contact.name)}`,
    `ADR;TYPE=WORK:;;${escapeVCard(contact.address)};;;;`,
    ...contact.phones.map((phone) => `TEL;TYPE=WORK,VOICE:${phone.e164}`),
  ];
  if (contact.website) lines.push(`URL:${escapeVCard(contact.website)}`);
  lines.push(
    `NOTE:${escapeVCard(`Source: ${contact.sourceUrls.join(" ")}\nLicense: ${contact.license} ${contact.licenseUrl}`)}`,
    "END:VCARD",
  );
  return `${lines.map(foldVCardLine).join("\r\n")}\r\n`;
}
