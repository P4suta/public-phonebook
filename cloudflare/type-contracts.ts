import type { Phonebook } from "./worker.js";

export function requireTypedContainerBinding(
  env: Env,
): DurableObjectStub<Phonebook> {
  return env.PHONEBOOK.getByName("binding-contract");
}
