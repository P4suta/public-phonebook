import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import type { ReactElement } from "react";
import { httpStatus } from "../core/http-status.ts";
import { DirectoryError, getRowLocation } from "../ui/client.ts";
import { BackButton } from "../ui/components.tsx";
import { uiCopy } from "../ui/copy.ts";
import { PrivateReturnNavigation } from "../ui/private-return-navigation.tsx";
import * as css from "../ui/styles.css.ts";
import { validateReturnSearch } from "./contacts.$id.tsx";

const markSnapshotConflict = createIsomorphicFn().server(async () => {
  const { setResponseStatus } = await import("@tanstack/react-start/server");
  setResponseStatus(httpStatus.conflict);
});

async function locateRow(
  snapshot: string,
  row: string,
): Promise<string | null> {
  try {
    return (await getRowLocation(snapshot, row)).id;
  } catch (error) {
    if (error instanceof DirectoryError) {
      if (error.code === "snapshot_changed") return null;
      if (error.code === "not_found" || error.code === "invalid_query")
        throw notFound();
    }
    throw error;
  }
}

export const Route = createFileRoute("/contacts/row/$snapshot/$row")({
  validateSearch: validateReturnSearch,
  loaderDeps: ({ search }) => search,
  loader: async ({ params, deps }) => {
    const id = await locateRow(params.snapshot, params.row);
    if (id === null) {
      await markSnapshotConflict();
      return null;
    }
    throw redirect({
      to: "/contacts/$id",
      params: { id },
      search: deps,
      statusCode: httpStatus.seeOther,
    });
  },
  head: () => ({
    meta: [{ title: `${uiCopy.rowUpdated.title} | Public Phonebook` }],
  }),
  component: SnapshotConflictPage,
});

function SnapshotConflictPage(): ReactElement {
  const { from = "/" } = Route.useSearch();
  return (
    <main id="main" className={css.page}>
      <div className={css.stack}>
        <h1 className={css.heading}>{uiCopy.rowUpdated.title}</h1>
        <p className={css.body}>{uiCopy.rowUpdated.body}</p>
        <PrivateReturnNavigation from={from}>
          {(target) => <BackButton href={target.from} />}
        </PrivateReturnNavigation>
      </div>
    </main>
  );
}
