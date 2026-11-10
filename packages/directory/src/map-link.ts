const mapSearch = "https://www.google.com/maps/search/?api=1&query=";

/** The Google Maps URLs guide limits each URL to 2,048 characters. */
export const mapUrlLimit = 2048;

/**
 * Searches Google Maps for a facility by its name and address, the format that the Maps URLs guide recommends for one place's details.
 * It falls back to the address alone when the name doesn't fit the URL limit, and gives no link when neither fits.
 */
export function mapSearchUrl(name: string, address: string): string | null {
  for (const query of [`${name},${address}`, address]) {
    const url = `${mapSearch}${encodeURIComponent(query)}`;
    if (url.length <= mapUrlLimit) return url;
  }
  return null;
}
