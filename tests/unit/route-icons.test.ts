import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { categoryDefinitions } from "../../src/core/catalog.ts";
import {
  categoryFallbackIcon,
  categoryIcons,
} from "../../src/ui/icon-catalog.ts";
import { categoryIcon } from "../../src/ui/icons.tsx";
import { pageIcons, routeIcons } from "../../src/ui/route-icons.ts";
import { serviceInformation } from "../../src/ui/service-information.ts";
import {
  declarationSource,
  type IconSite,
  type IconUsage,
  iconUsage,
} from "./icon-usage.ts";

const routesDirectory = "src/routes";
const rootModule = "src/routes/__root.tsx";
const rootId = "__root__";
const contactModule = "src/routes/contacts.$id.tsx";
const everyCategory = [...Object.values(categoryIcons), categoryFallbackIcon];

/** The contact page draws only the category of the contact its loader returns, which `pageIcons` adds. */
const loaderCategories: ReadonlyMap<string, IconSite> = new Map([
  [
    "/contacts/$id",
    {
      declaration: "src/ui/components.tsx#ContactCard",
      expression: "contact.category",
    },
  ],
]);
/** Both information pages pass an entry of `serviceInformation`, so a link's icon is one of its links' icons. */
const serviceLinkRead: IconSite = {
  declaration: "src/ui/information-page.tsx#InformationPage",
  expression: "link.icon",
};
const serviceLinkIcons = serviceInformation.flatMap((information) =>
  information.links.map((link) => link.icon),
);

function sameSite(site: IconSite, pinned: IconSite | undefined): boolean {
  return (
    site.declaration === pinned?.declaration &&
    site.expression === pinned.expression
  );
}

function readSource(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function routeId(module: string): string {
  if (module === rootModule) return rootId;
  const id = /createFileRoute\("([^"]+)"\)/u.exec(
    readSource(module) ?? "",
  )?.[1];
  if (!id) throw new Error(`${module} declares no file route`);
  return id;
}

const usages: ReadonlyMap<string, IconUsage> = new Map(
  readdirSync(routesDirectory)
    .filter((file) => file.endsWith(".tsx"))
    .map((file) => `${routesDirectory}/${file}`)
    .map((module) => [routeId(module), iconUsage(readSource, module)]),
);

function usageOf(id: string): IconUsage {
  const usage = usages.get(id);
  if (!usage) throw new Error(`No route ${id}`);
  return usage;
}

/** Resolves a route's category and data sites, so its result is every icon the route can draw. */
function drawable(id: string, usage: IconUsage): readonly string[] {
  const names = new Set(usage.icons);
  if (
    usage.categorySites.some(
      (site) => !sameSite(site, loaderCategories.get(id)),
    )
  )
    for (const name of everyCategory) names.add(name);
  if (usage.dataSites.some((site) => sameSite(site, serviceLinkRead)))
    for (const name of serviceLinkIcons) names.add(name);
  return [...names].sort();
}

describe("the icon walk", () => {
  const catalog = `
    export const iconNames = ["copy"] as const;
    export const categoryIcons = { pharmacy: "pill" } as const;
    export const categoryFallbackIcon = "file";
  `;
  const icons = `
    import { categoryFallbackIcon, categoryIcons } from "./icon-catalog.ts";
    export function Icon({ name }: { readonly name: IconName }) {
      return <svg data-icon={name}><use href={\`#icon-\${name}\`} /></svg>;
    }
    export function categoryIcon(category: string): IconName {
      return Object.hasOwn(categoryIcons, category) ? categoryIcons.pharmacy : categoryFallbackIcon;
    }
    export function CategoryIcon({ category }: { readonly category: string }) {
      return <Icon name={categoryIcon(category)} />;
    }
  `;

  function walk(page: string): IconUsage {
    const sources = new Map([
      ["src/ui/icon-catalog.ts", catalog],
      ["src/ui/icons.tsx", icons],
      [
        "src/routes/page.tsx",
        `
          import { createFileRoute } from "@tanstack/react-router";
          import { categoryIcons } from "../ui/icon-catalog.ts";
          import { CategoryIcon, Icon, categoryIcon } from "../ui/icons.tsx";
          export const Route = createFileRoute("/page")({ component: Page });
          function Button({ icon = "copy" }: { readonly icon?: IconName }) {
            return <Icon name={icon} />;
          }
          ${page}
        `,
      ],
    ]);
    return iconUsage((path) => sources.get(path), "src/routes/page.tsx");
  }

  it("collects both branches of a condition and the icons a forwarding component receives", () => {
    const usage = walk(`
      function Page({ done }: { readonly done: boolean }) {
        return <><Icon name={done ? "check" : "copy"} /><Button icon="send" /></>;
      }
      function Unused() {
        return <Icon name="x" />;
      }
    `);
    expect(usage.problems).toEqual([]);
    expect(usage.icons).toEqual(["check", "copy", "send"]);
  });

  it("admits JSON data without interpreting its text as component source", () => {
    const route = `
      import data from "./labels.json" with { type: "json" };
      import { Icon } from "../ui/icons.tsx";
      export const Route = { component: Page };
      function Page() { return <><Icon name="copy" /><span>{data.label}</span></>; }
    `;
    const sources = new Map([
      ["src/routes/page.tsx", route],
      [
        "src/routes/labels.json",
        JSON.stringify({ label: '<Icon name="send" />' }),
      ],
      ["src/ui/icons.tsx", icons],
      ["src/ui/icon-catalog.ts", catalog],
    ]);
    const read = (path: string): string | undefined => sources.get(path);
    const usage = iconUsage(read, "src/routes/page.tsx");
    expect(usage.problems).toEqual([]);
    expect(usage.icons).toEqual(["copy"]);
    sources.set("src/routes/labels.json", '{ "label": }');
    expect(() => iconUsage(read, "src/routes/page.tsx")).toThrow(SyntaxError);
  });

  it.each([
    [
      "a local constant",
      `function Page() { const name = "send"; return <Icon name={name} />; }`,
      "passes name",
    ],
    [
      "a callback parameter",
      `function Page() { return ["send"].map((name) => <Icon name={name} />); }`,
      "passes name",
    ],
    [
      "a computed value",
      `function Page() { return <Icon name={["se", "nd"].join("") as never} />; }`,
      "which the walk can't resolve",
    ],
    [
      "a call outside CategoryIcon",
      `function Page() { return <Icon name={categoryIcon("pharmacy")} />; }`,
      "computes categoryIcon",
    ],
    [
      "a catalog lookup",
      `function Page() { return <Icon name={categoryIcons.pharmacy} />; }`,
      "categoryIcons produces icon names",
    ],
    [
      "spread props",
      `function Page(props: { readonly icon: IconName }) { return <Button {...props} />; }`,
      "spreading props",
    ],
    [
      "a forwarding component called as a function",
      `function Page() { return <>{Button({ icon: "send" })}<Button icon="send" /></>; }`,
      "forwards an icon prop",
    ],
    [
      "Icon passed as a value",
      `function Page() { return [Icon].length; }`,
      "Icon may only appear as a JSX tag",
    ],
    [
      "a type argument naming IconName",
      `function Page() { const [name] = useState<IconName>("send"); return name; }`,
      "names IconName",
    ],
    [
      "a forwarded prop with another name",
      `function Wrapper({ glyph }: { readonly glyph: IconName }) { return <Icon name={glyph} />; }
       function Page() { return <Wrapper glyph="send" />; }`,
      "passes glyph",
    ],
    [
      "a symbol drawn outside Icon",
      `function Page() { return <svg><use href="#icon-send" /></svg>; }`,
      "only Icon may draw a sprite symbol",
    ],
    [
      "a component reached through a member tag",
      `const parts = { Button };
       function Page() { return <parts.Button icon="send" />; }`,
      "forwards an icon prop",
    ],
    [
      "a type predicate naming IconName",
      `function named(value: string): value is IconName { return value !== ""; }
       function Page() { return named("send"); }`,
      "names IconName",
    ],
  ])("refuses an icon from %s", (_, page, problem) => {
    expect(walk(page).problems.join("\n")).toContain(problem);
  });

  it("reports category icons and icon field reads for the caller to resolve", () => {
    const usage = walk(`
      function Page({ contact, link }: { readonly contact: { readonly category: string }; readonly link: { readonly icon: IconName } }) {
        return <><CategoryIcon category={contact.category} /><Button icon={link.icon} /></>;
      }
    `);
    expect(usage.problems).toEqual([]);
    expect(usage.icons).toEqual(["copy"]);
    expect(usage.categorySites).toEqual([
      {
        declaration: "src/routes/page.tsx#Page",
        expression: "contact.category",
      },
    ]);
    expect(usage.dataSites).toEqual([
      { declaration: "src/routes/page.tsx#Page", expression: "link.icon" },
    ]);
  });
});

describe("route icons", () => {
  it("resolves every icon value on every route", () => {
    for (const [id, usage] of usages) {
      expect({ id, problems: usage.problems }).toEqual({ id, problems: [] });
      expect({
        id,
        unpinned: usage.dataSites.filter(
          (site) => !sameSite(site, serviceLinkRead),
        ),
      }).toEqual({ id, unpinned: [] });
    }
  });

  it("declares exactly the icons each route can draw beyond the shell's", () => {
    const declared = new Map(
      Object.entries(routeIcons).map(([id, names]) => [
        id,
        [...new Set(names)].sort(),
      ]),
    );
    expect([...declared.keys()].sort()).toEqual([...usages.keys()].sort());
    const shell = drawable(rootId, usageOf(rootId));
    expect(declared.get(rootId)).toEqual(shell);
    for (const [id, usage] of usages)
      if (id !== rootId)
        expect({ id, icons: declared.get(id) }).toEqual({
          id,
          icons: drawable(id, usage).filter((name) => !shell.includes(name)),
        });
  });

  it("passes the information pages only entries of the service information", () => {
    const pages = [...usages.values()].flatMap((usage) =>
      usage.uses.filter(
        (use) =>
          use.component === "src/ui/information-page.tsx#InformationPage",
      ),
    );
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages)
      expect(page.attributes.information).toMatch(
        /^serviceInformation\[\d+\]$/u,
      );
  });

  it("draws a contact page's category from the contact its loader returns", () => {
    const usage = usageOf("/contacts/$id");
    expect(usage.categorySites).toEqual([
      loaderCategories.get("/contacts/$id"),
    ]);
    expect(
      usage.uses
        .filter((use) => use.component === "src/ui/components.tsx#ContactCard")
        .map((use) => [use.from, use.attributes.contact]),
    ).toEqual([[`${contactModule}#ContactPage`, "contact"]]);
    expect(
      declarationSource(readSource, contactModule, "ContactPage"),
    ).toContain("const contact = Route.useLoaderData();");
    for (const category of categoryDefinitions)
      expect(
        pageIcons([
          { routeId: rootId },
          { routeId: "/contacts/$id", loaderData: { category: category.id } },
        ]),
      ).toContain(categoryIcon(category.id));
  });

  it("lists a page's icons once each in name order", () => {
    const icons = pageIcons([{ routeId: rootId }, { routeId: "/about" }]);
    expect(icons).toEqual(
      [...new Set([...routeIcons[rootId], ...routeIcons["/about"]])].sort(),
    );
    expect(pageIcons([{ routeId: rootId }])).toEqual(
      [...routeIcons[rootId]].sort(),
    );
  });
});
