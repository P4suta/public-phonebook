import type { Contact } from "@public-phonebook/directory/models";
import { notFound } from "@tanstack/react-router";
import { DirectoryError, getContact } from "./client.ts";

export async function getRouteContact(id: string): Promise<Contact> {
  try {
    return await getContact(id);
  } catch (error) {
    if (error instanceof DirectoryError && error.code === "not_found")
      throw notFound();
    throw error;
  }
}
