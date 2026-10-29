import { DurableObject } from "cloudflare:workers";
import { DirectoryRuntime } from "./container-runtime.js";
import { handleRequest } from "./service.js";

export class Phonebook extends DurableObject<Env> {
  readonly #directory: DirectoryRuntime;
  readonly #restored: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (!ctx.container) throw new Error("The directory container is missing");
    this.#directory = new DirectoryRuntime(ctx.container);
    this.#restored = ctx.blockConcurrencyWhile(() => this.#directory.restore());
  }

  override async fetch(request: Request): Promise<Response> {
    await this.#restored;
    return this.#directory.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, {
      assets: (value) => env.ASSETS.fetch(value),
      origin: (value) =>
        env.PHONEBOOK.getByName("public-directory").fetch(value),
    });
  },
} satisfies ExportedHandler<Env>;
