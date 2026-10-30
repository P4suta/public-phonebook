const maximumSearchLimit = 100;
const maximumPreviewLimit = 3;

export function canFetchNext(
  hasNext: boolean,
  pending: boolean,
  failed: boolean,
): boolean {
  //@ verify
  //@ ensures \result === (hasNext && !pending && !failed)
  return hasNext && !pending && !failed;
}

export type CursorDecision = "accepted" | "snapshot_changed" | "invalid_cursor";

export function cursorDecision(
  snapshotMatches: boolean,
  queryMatches: boolean,
): CursorDecision {
  //@ verify
  //@ ensures (\result === "accepted") === (snapshotMatches && queryMatches)
  //@ ensures (\result === "snapshot_changed") === !snapshotMatches
  //@ ensures (\result === "invalid_cursor") === (snapshotMatches && !queryMatches)
  if (!snapshotMatches) return "snapshot_changed";
  if (!queryMatches) return "invalid_cursor";
  return "accepted";
}

export function compatibleRegion(
  prefecture: string,
  municipality: string,
): boolean {
  //@ verify
  //@ ensures \result === (prefecture === "" || municipality === "" || municipality.startsWith(prefecture))
  return (
    prefecture === "" ||
    municipality === "" ||
    municipality.startsWith(prefecture)
  );
}

export function boundedLimit(limit: number): boolean {
  //@ verify
  //@ ensures \result ==> limit >= 1 && limit <= 100
  //@ ensures limit >= 1 && limit <= 100 ==> \result
  return limit >= 1 && limit <= maximumSearchLimit;
}

export function previewLimit(limit: number): number {
  //@ verify
  //@ requires limit >= 1 && limit <= 100
  //@ ensures \result >= 1 && \result <= 3
  //@ ensures \result === (limit < 3 ? limit : 3)
  return limit < maximumPreviewLimit ? limit : maximumPreviewLimit;
}
