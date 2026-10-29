import { Container } from "@cloudflare/containers";
import { handleRequest } from "./service.js";

const DIRECTORY_PORT = 8080;

export class Phonebook extends Container<Env> {
  override defaultPort = DIRECTORY_PORT;
  override sleepAfter = "10m";
  override enableInternet = false;
  override pingEndpoint = "/healthz";
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
