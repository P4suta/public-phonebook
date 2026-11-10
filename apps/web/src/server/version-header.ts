export const versionHeader = "x-dial-version";

export interface VersionBindings {
  readonly CF_VERSION_METADATA?: { readonly id: string };
}

type Handler<Bindings, Context> = (
  request: Request,
  bindings: Bindings,
  context?: Context,
) => Promise<Response>;

function labeled(response: Response, version: string): Response {
  try {
    response.headers.set(versionHeader, version);
    return response;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const copy = new Response(response.body, response);
    copy.headers.set(versionHeader, version);
    return copy;
  }
}

export function withVersionHeader<Bindings extends VersionBindings, Context>(
  handler: Handler<Bindings, Context>,
): Handler<Bindings, Context> {
  return async (request, bindings, context) => {
    const response = await handler(request, bindings, context);
    const version = bindings.CF_VERSION_METADATA?.id;
    return version ? labeled(response, version) : response;
  };
}
