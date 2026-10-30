import type { ReactElement } from "react";
import type { Category } from "../core/catalog.ts";
import { categoryIcons } from "./category-icons.ts";

export function CategoryIcon({
  category,
}: {
  readonly category: Category;
}): ReactElement {
  if (category === "dental")
    return <img src="/icons/tooth.svg" alt="" width={16} height={16} />;
  const Icon = categoryIcons[category];
  return <Icon size={16} aria-hidden="true" />;
}
