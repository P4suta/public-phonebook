import type { Phonebook } from "./worker.js";

export function requireTypedContainerBinding(
  ctx: ExecutionContext,
): DurableObjectStub<Phonebook> {
  return ctx.exports.Phonebook.getByName("binding-contract");
}
