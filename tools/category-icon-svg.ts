import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { categoryDefinitions } from "../src/core/catalog.ts";
import { categoryIcons } from "../src/ui/category-icons.ts";

const iconSize = 24;
const strokeWidth = 2;
const svg = categoryDefinitions.flatMap((category) => {
  if (category.id === "dental") return [];
  const icon = categoryIcons[category.id];
  return [
    {
      id: category.id,
      label: category.label,
      icon: category.icon,
      svg: renderToStaticMarkup(
        createElement(icon, { size: iconSize, strokeWidth, color: "#000000" }),
      ),
    },
  ];
});
console.info(JSON.stringify(svg));
