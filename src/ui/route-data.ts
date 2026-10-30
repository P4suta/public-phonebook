import { notFound } from "@tanstack/react-router";
import type { Contact } from "../core/models.ts";
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
