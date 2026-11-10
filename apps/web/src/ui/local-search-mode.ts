declare const __PHONEBOOK_LOCAL_FORGIVING_SEARCH__: boolean;

export const localForgivingSearch =
  typeof __PHONEBOOK_LOCAL_FORGIVING_SEARCH__ !== "undefined" &&
  __PHONEBOOK_LOCAL_FORGIVING_SEARCH__ &&
  typeof location !== "undefined" &&
  ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
