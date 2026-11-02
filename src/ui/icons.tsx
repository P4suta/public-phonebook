import type { ReactElement } from "react";
import type { Category } from "../core/catalog.ts";
import { foundation } from "./foundations.ts";
import {
  categoryFallbackIcon,
  categoryIcons,
  type IconName,
  iconIdPrefix,
  iconSymbols,
} from "./icon-catalog.ts";

const mappedCategoryIcons: Readonly<Partial<Record<Category, IconName>>> =
  categoryIcons;

/** Defines each icon a page can draw once in the document, so icons need no request and keep working offline. */
export function IconSprite({
  className,
  names,
}: {
  readonly className: string;
  readonly names: readonly IconName[];
}): ReactElement {
  return (
    <svg
      className={className}
      width={0}
      height={0}
      aria-hidden="true"
      data-icon-sprite=""
      dangerouslySetInnerHTML={{
        __html: names.map((name) => iconSymbols[name]).join(""),
      }}
    />
  );
}

/** Draws a Figma master from the sprite in the surrounding text color. */
export function Icon({
  name,
  size = foundation.control.icon,
  className,
}: {
  readonly name: IconName;
  readonly size?: number;
  readonly className?: string;
}): ReactElement {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      aria-hidden="true"
      data-icon={name}
    >
      <use href={`#${iconIdPrefix}${name}`} />
    </svg>
  );
}

/** Resolves a category's master the way the iPhone app does, including its fallback. */
export function categoryIcon(category: Category): IconName {
  return mappedCategoryIcons[category] ?? categoryFallbackIcon;
}

export function CategoryIcon({
  category,
}: {
  readonly category: Category;
}): ReactElement {
  return (
    <Icon
      name={categoryIcon(category)}
      size={foundation.control.categoryIcon}
    />
  );
}
