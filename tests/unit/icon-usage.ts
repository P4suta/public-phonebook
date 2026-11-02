import { dirname, join, normalize } from "node:path/posix";
import { parseSync } from "vite";
import { iconNames } from "../../src/ui/icon-catalog.ts";

/**
 * Finds every icon a route can draw by walking the declarations its `Route` reaches.
 * The sprite is only drawn through `<Icon name>`, so the walk resolves each value that reaches that prop or an `icon` prop.
 * It accepts literals, conditionals of them, and props that a component only used as a JSX tag forwards.
 * It reports category icons and `.icon` reads as sites for the caller to resolve, and reports anything else as a problem.
 * The lint configuration forbids type assertions and unchecked `any` values, so an icon name can't enter through either.
 */

const iconModule = "src/ui/icons.tsx";
const catalogModule = "src/ui/icon-catalog.ts";
/** The sprite's inputs choose symbols for every route and draw none. */
const spriteInputs: ReadonlySet<string> = new Set(["src/ui/route-icons.ts"]);
const nameSources: ReadonlySet<string> = new Set([
  "iconNames",
  "categoryIcons",
  "categoryFallbackIcon",
]);
const iconComponent = `${iconModule}#Icon`;
const categoryComponent = `${iconModule}#CategoryIcon`;
const categoryLookup = `${iconModule}#categoryIcon`;
const skippedFields: ReadonlySet<string> = new Set([
  "type",
  "start",
  "end",
  "typeAnnotation",
  "returnType",
  "typeParameters",
  "typeArguments",
  "superTypeArguments",
  "implements",
]);
const typeDeclarations: ReadonlySet<string> = new Set([
  "TSTypeAliasDeclaration",
  "TSInterfaceDeclaration",
  "TSModuleDeclaration",
  "TSDeclareFunction",
]);
const functionTypes: ReadonlySet<string> = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const knownIcons: ReadonlySet<string> = new Set(iconNames);

interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

interface Binding {
  readonly module: string;
  readonly name: string;
}

interface ModuleIndex {
  readonly path: string;
  readonly source: string;
  readonly declarations: ReadonlyMap<string, Node>;
  readonly exports: ReadonlyMap<string, string>;
  readonly imports: ReadonlyMap<string, Binding | null>;
  readonly effects: readonly Node[];
}

interface Scope {
  readonly declaration: string;
  readonly topLevel: boolean;
  readonly props: ReadonlyMap<string, Node | undefined>;
  readonly bindings: ReadonlySet<string>;
}

interface Context {
  readonly module: ModuleIndex;
  readonly declaration: string;
  readonly scopes: readonly Scope[];
}

/** An icon value the walk can't resolve alone, named by its declaration and exact source text. */
export interface IconSite {
  readonly declaration: string;
  readonly expression: string;
}

export interface ComponentUse {
  readonly component: string;
  readonly from: string;
  readonly attributes: Readonly<Record<string, string>>;
}

export interface IconUsage {
  readonly icons: readonly string[];
  readonly categorySites: readonly IconSite[];
  readonly dataSites: readonly IconSite[];
  readonly uses: readonly ComponentUse[];
  readonly problems: readonly string[];
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    "start" in value &&
    typeof value.start === "number" &&
    "end" in value &&
    typeof value.end === "number"
  );
}

function field(node: Node, key: string): unknown {
  const value: unknown = Reflect.get(node, key);
  return value;
}

function child(node: Node, key: string): Node | undefined {
  const value = field(node, key);
  return isNode(value) ? value : undefined;
}

function children(node: Node, key: string): readonly Node[] {
  const value = field(node, key);
  return Array.isArray(value) ? value.filter(isNode) : [];
}

function nodesIn(node: Node): readonly Node[] {
  return Object.keys(node).flatMap((key) => {
    if (skippedFields.has(key)) return [];
    const value = field(node, key);
    if (Array.isArray(value)) return value.filter(isNode);
    return isNode(value) ? [value] : [];
  });
}

function nameOf(node: Node | undefined): string | undefined {
  const value = node && field(node, "name");
  return typeof value === "string" ? value : undefined;
}

function computed(node: Node): boolean {
  return field(node, "computed") === true;
}

function stringOf(node: Node | undefined): string | undefined {
  if (node?.type === "Literal") {
    const value = field(node, "value");
    return typeof value === "string" ? value : undefined;
  }
  const [quasi] = node ? children(node, "quasis") : [];
  if (
    node?.type !== "TemplateLiteral" ||
    !quasi ||
    children(node, "expressions").length > 0
  )
    return undefined;
  const value = field(quasi, "value");
  const cooked =
    typeof value === "object" && value !== null && "cooked" in value
      ? value.cooked
      : undefined;
  return typeof cooked === "string" ? cooked : undefined;
}

function patternNames(pattern: Node | undefined): readonly string[] {
  switch (pattern?.type) {
    case "Identifier":
      return [nameOf(pattern) ?? ""];
    case "ObjectPattern":
      return children(pattern, "properties").flatMap((property) =>
        patternNames(
          child(
            property,
            property.type === "RestElement" ? "argument" : "value",
          ),
        ),
      );
    case "ArrayPattern":
      return children(pattern, "elements").flatMap(patternNames);
    case "AssignmentPattern":
      return patternNames(child(pattern, "left"));
    case "RestElement":
      return patternNames(child(pattern, "argument"));
    default:
      return [];
  }
}

function mentionsIconName(node: Node | undefined): boolean {
  if (!node) return false;
  if (
    node.type === "TSTypeReference" &&
    nameOf(child(node, "typeName")) === "IconName"
  )
    return true;
  return Object.keys(node).some((key) => {
    const value = field(node, key);
    return Array.isArray(value)
      ? value.filter(isNode).some(mentionsIconName)
      : isNode(value) && mentionsIconName(value);
  });
}

function indexModule(path: string, source: string): ModuleIndex {
  const parsed = parseSync(path, source, {
    lang: path.endsWith(".tsx") ? "tsx" : "ts",
  });
  if (parsed.errors.length > 0)
    throw new Error(
      `${path} doesn't parse: ${parsed.errors.map((error) => error.message).join("; ")}`,
    );
  const declarations = new Map<string, Node>();
  const exports = new Map<string, string>();
  const imports = new Map<string, Binding | null>();
  const effects: Node[] = [];
  const target = (specifier: string): string | null =>
    specifier.startsWith(".")
      ? normalize(join(dirname(path), specifier))
      : null;
  const declare = (statement: Node): readonly string[] => {
    if (statement.type === "VariableDeclaration")
      return children(statement, "declarations").flatMap((declarator) => {
        const names = patternNames(child(declarator, "id"));
        for (const name of names) declarations.set(name, declarator);
        return names;
      });
    const name = nameOf(child(statement, "id"));
    if (name) declarations.set(name, statement);
    return name ? [name] : [];
  };
  for (const statement of children(parsed.program, "body")) {
    if (typeDeclarations.has(statement.type)) continue;
    if (statement.type === "ImportDeclaration") {
      if (field(statement, "importKind") === "type") continue;
      const module = target(stringOf(child(statement, "source")) ?? "");
      for (const specifier of children(statement, "specifiers")) {
        if (field(specifier, "importKind") === "type") continue;
        const imported =
          specifier.type === "ImportNamespaceSpecifier"
            ? "*"
            : specifier.type === "ImportDefaultSpecifier"
              ? "default"
              : (nameOf(child(specifier, "imported")) ?? "");
        imports.set(
          nameOf(child(specifier, "local")) ?? "",
          module === null ? null : { module, name: imported },
        );
      }
    } else if (statement.type === "ExportNamedDeclaration") {
      const declaration = child(statement, "declaration");
      if (declaration && !typeDeclarations.has(declaration.type))
        for (const name of declare(declaration)) exports.set(name, name);
      const from = stringOf(child(statement, "source"));
      for (const specifier of children(statement, "specifiers")) {
        const local = nameOf(child(specifier, "local")) ?? "";
        const exported = nameOf(child(specifier, "exported")) ?? local;
        if (from === undefined) exports.set(exported, local);
        else {
          const module = target(from);
          const alias = `${exported} from ${from}`;
          imports.set(alias, module === null ? null : { module, name: local });
          exports.set(exported, alias);
        }
      }
    } else if (statement.type === "ExportDefaultDeclaration") {
      const declaration = child(statement, "declaration");
      if (declaration) declarations.set("default", declaration);
      exports.set("default", "default");
    } else if (statement.type === "ExportAllDeclaration")
      throw new Error(`${path} re-exports a whole module`);
    else if (declare(statement).length === 0) effects.push(statement);
  }
  return { path, source, declarations, exports, imports, effects };
}

/** Collects the names a function binds in its own body, without entering nested functions. */
function bodyBindings(node: Node, names: Set<string>): void {
  if (functionTypes.has(node.type)) {
    if (node.type === "FunctionDeclaration")
      names.add(nameOf(child(node, "id")) ?? "");
    return;
  }
  if (node.type === "VariableDeclarator")
    for (const name of patternNames(child(node, "id"))) names.add(name);
  if (node.type === "CatchClause")
    for (const name of patternNames(child(node, "param"))) names.add(name);
  if (node.type === "ClassDeclaration")
    names.add(nameOf(child(node, "id")) ?? "");
  for (const item of nodesIn(node)) bodyBindings(item, names);
}

class RouteWalk {
  readonly #load: (path: string) => ModuleIndex;
  readonly #icons = new Set<string>();
  readonly #categorySites: IconSite[] = [];
  readonly #dataSites: IconSite[] = [];
  readonly #uses: ComponentUse[] = [];
  readonly #problems: string[] = [];
  readonly #visited = new Set<string>();
  readonly #forwarders = new Set<string>();
  readonly #values = new Set<string>();

  constructor(load: (path: string) => ModuleIndex) {
    this.#load = load;
  }

  usage(): IconUsage {
    for (const forwarder of this.#forwarders)
      if (this.#values.has(forwarder))
        this.#problems.push(
          `${forwarder} forwards an icon prop, so it may only appear as a JSX tag`,
        );
    return {
      icons: [...this.#icons].sort(),
      categorySites: this.#categorySites,
      dataSites: this.#dataSites,
      uses: this.#uses,
      problems: this.#problems,
    };
  }

  reachExport(module: string, exported: string): void {
    if (spriteInputs.has(module)) return;
    const index = this.#load(module);
    if (exported === "*") {
      for (const name of index.declarations.keys())
        this.reachLocal(index, name);
      return;
    }
    const local = index.exports.get(exported);
    if (local === undefined)
      this.#problems.push(`${module} has no export ${exported}`);
    else this.reachLocal(index, local);
  }

  reachLocal(index: ModuleIndex, name: string): void {
    const key = `${index.path}#${name}`;
    if (this.#visited.has(key)) return;
    this.#visited.add(key);
    const effects = `${index.path}#`;
    if (!this.#visited.has(effects)) {
      this.#visited.add(effects);
      for (const statement of index.effects)
        this.#walk(statement, { module: index, declaration: "", scopes: [] });
    }
    const imported = index.imports.get(name);
    if (imported !== undefined) {
      if (imported) this.reachExport(imported.module, imported.name);
      return;
    }
    const node = index.declarations.get(name);
    if (!node) {
      this.#problems.push(`${index.path} doesn't declare ${name}`);
      return;
    }
    const context = { module: index, declaration: name, scopes: [] };
    const init =
      node.type === "VariableDeclarator" ? child(node, "init") : node;
    if (init && functionTypes.has(init.type)) {
      if (init !== node) this.#walkPattern(child(node, "id"), context);
      this.#function(init, context, true);
    } else this.#walk(node, context);
  }

  #at(context: Context, node: Node): string {
    const line = context.module.source.slice(0, node.start).split("\n").length;
    return `${context.module.path}:${line}`;
  }

  #text(context: Context, node: Node): string {
    return context.module.source.slice(node.start, node.end);
  }

  #declaration(context: Context): string {
    return `${context.module.path}#${context.declaration}`;
  }

  /** Resolves a top-level name to the declaration it reaches, keyed by module and local name. */
  #resolve(context: Context, name: string): string | undefined {
    const { module } = context;
    if (module.declarations.has(name)) return `${module.path}#${name}`;
    const imported = module.imports.get(name);
    if (!imported) return undefined;
    const local = spriteInputs.has(imported.module)
      ? imported.name
      : (this.#load(imported.module).exports.get(imported.name) ??
        imported.name);
    return `${imported.module}#${local}`;
  }

  #reference(
    context: Context,
    name: string,
    node: Node,
    tag: boolean,
  ): string | undefined {
    const resolved = this.#resolve(context, name);
    if (!resolved) return undefined;
    const [module = "", local = ""] = resolved.split("#");
    const from = context.module.path;
    if (!tag) {
      this.#values.add(resolved);
      if (resolved === iconComponent || resolved === categoryComponent)
        this.#problems.push(
          `${this.#at(context, node)}: ${local} may only appear as a JSX tag`,
        );
      if (resolved === categoryLookup && from !== iconModule)
        this.#problems.push(
          `${this.#at(context, node)}: only CategoryIcon may call categoryIcon`,
        );
      if (
        module === catalogModule &&
        nameSources.has(local) &&
        from !== catalogModule &&
        from !== iconModule
      )
        this.#problems.push(
          `${this.#at(context, node)}: ${local} produces icon names outside the icon modules`,
        );
    }
    const imported = context.module.imports.get(name);
    if (imported) this.reachExport(imported.module, imported.name);
    else this.reachLocal(context.module, name);
    return resolved;
  }

  /** Walks the default values in a binding pattern; the bound names themselves aren't references. */
  #walkPattern(pattern: Node | undefined, context: Context): void {
    if (!pattern) return;
    switch (pattern.type) {
      case "Identifier":
        return;
      case "AssignmentPattern": {
        this.#walkPattern(child(pattern, "left"), context);
        const right = child(pattern, "right");
        if (right) this.#walk(right, context);
        return;
      }
      case "ObjectPattern":
        for (const property of children(pattern, "properties")) {
          const key = child(property, "key");
          if (key && computed(property)) this.#walk(key, context);
          this.#walkPattern(
            child(
              property,
              property.type === "RestElement" ? "argument" : "value",
            ),
            context,
          );
        }
        return;
      case "ArrayPattern":
        for (const element of children(pattern, "elements"))
          this.#walkPattern(element, context);
        return;
      case "RestElement":
        this.#walkPattern(child(pattern, "argument"), context);
        return;
      default:
        this.#walk(pattern, context);
    }
  }

  /** Refuses a type argument or predicate that turns an unchecked value into an icon name. */
  #checkTypes(node: Node, context: Context, types: Node | undefined): void {
    if (mentionsIconName(types))
      this.#problems.push(
        `${this.#at(context, node)}: a type argument or predicate names IconName`,
      );
  }

  #function(node: Node, context: Context, topLevel: boolean): void {
    const returnType = child(node, "returnType");
    const returned = returnType && child(returnType, "typeAnnotation");
    if (returned?.type === "TSTypePredicate")
      this.#checkTypes(node, context, returned);
    const parameters = children(node, "params");
    const props = new Map<string, Node | undefined>();
    const bindings = new Set<string>();
    for (const [position, parameter] of parameters.entries()) {
      const properties =
        position === 0 && parameter.type === "ObjectPattern"
          ? children(parameter, "properties")
          : [parameter];
      for (const property of properties) {
        const value =
          property.type === "Property" && !computed(property)
            ? child(property, "value")
            : undefined;
        const bound =
          value?.type === "AssignmentPattern" ? child(value, "left") : value;
        const key = nameOf(child(property, "key"));
        if (bound?.type === "Identifier" && key && nameOf(bound) === key)
          props.set(
            key,
            value?.type === "AssignmentPattern"
              ? child(value, "right")
              : undefined,
          );
        else for (const name of patternNames(property)) bindings.add(name);
      }
    }
    const body = child(node, "body");
    if (body) bodyBindings(body, bindings);
    const scope = {
      declaration: this.#declaration(context),
      topLevel,
      props,
      bindings,
    };
    const inner = { ...context, scopes: [...context.scopes, scope] };
    for (const parameter of parameters) this.#walkPattern(parameter, inner);
    if (body) this.#walk(body, inner);
  }

  #element(node: Node, context: Context): void {
    const tag = child(node, "name");
    const tagName = nameOf(tag) ?? "";
    let component: string | undefined;
    if (tag?.type === "JSXIdentifier") {
      if (/^[A-Z]/u.test(tagName))
        component = this.#reference(context, tagName, tag, true);
    } else if (tag) this.#walk(tag, context);
    const attributes: Record<string, string> = {};
    for (const attribute of children(node, "attributes")) {
      if (attribute.type === "JSXSpreadAttribute") {
        this.#problems.push(
          `${this.#at(context, attribute)}: spreading props hides icon values`,
        );
        for (const item of nodesIn(attribute)) this.#walk(item, context);
        continue;
      }
      const name = nameOf(child(attribute, "name")) ?? "";
      const value = child(attribute, "value");
      const expression =
        value?.type === "JSXExpressionContainer"
          ? child(value, "expression")
          : value;
      attributes[name] = expression ? this.#text(context, expression) : "";
      if (name === "icon" || (name === "name" && component === iconComponent))
        this.#classify(expression, context, `${tagName} ${name}`);
      if (name === "category" && component === categoryComponent && expression)
        this.#categorySites.push({
          declaration: this.#declaration(context),
          expression: this.#text(context, expression),
        });
      if (value) this.#walk(value, context);
    }
    if (component)
      this.#uses.push({
        component,
        from: this.#declaration(context),
        attributes,
      });
  }

  #classify(value: Node | undefined, context: Context, where: string): void {
    if (!value) {
      this.#problems.push(`${context.module.path}: ${where} has no value`);
      return;
    }
    const at = `${this.#at(context, value)}: ${where}`;
    const literal = stringOf(value);
    if (literal !== undefined) {
      if (knownIcons.has(literal)) this.#icons.add(literal);
      else this.#problems.push(`${at} names no icon: ${literal}`);
      return;
    }
    switch (value.type) {
      case "ParenthesizedExpression":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
        this.#classify(child(value, "expression"), context, where);
        return;
      case "ConditionalExpression":
        this.#classify(child(value, "consequent"), context, where);
        this.#classify(child(value, "alternate"), context, where);
        return;
      case "LogicalExpression":
        if (field(value, "operator") !== "&&")
          this.#classify(child(value, "left"), context, where);
        this.#classify(child(value, "right"), context, where);
        return;
      case "Identifier":
        this.#forward(value, context, at);
        return;
      case "MemberExpression": {
        const property = child(value, "property");
        const key = computed(value) ? stringOf(property) : nameOf(property);
        if (key === "icon")
          this.#dataSites.push({
            declaration: this.#declaration(context),
            expression: this.#text(context, value),
          });
        else
          this.#problems.push(
            `${at} reads ${this.#text(context, value)}, which isn't an icon field`,
          );
        return;
      }
      case "CallExpression": {
        const callee = child(value, "callee");
        const resolved =
          callee?.type === "Identifier"
            ? this.#resolve(context, nameOf(callee) ?? "")
            : undefined;
        if (resolved !== categoryLookup || context.module.path !== iconModule)
          this.#problems.push(`${at} computes ${this.#text(context, value)}`);
        return;
      }
      default:
        this.#problems.push(
          `${at} uses ${this.#text(context, value)}, which the walk can't resolve`,
        );
    }
  }

  /** Accepts a name that a top-level component destructures from its props, so its JSX call sites supply the icon. */
  #forward(identifier: Node, context: Context, at: string): void {
    const name = nameOf(identifier) ?? "";
    for (const scope of context.scopes.toReversed()) {
      if (
        scope.props.has(name) &&
        !scope.bindings.has(name) &&
        scope.topLevel
      ) {
        this.#forwarders.add(scope.declaration);
        const fallback = scope.props.get(name);
        if (fallback) this.#classify(fallback, context, `${at} default`);
        return;
      }
      if (scope.props.has(name) || scope.bindings.has(name)) break;
    }
    this.#problems.push(
      `${at} passes ${name}, which isn't a prop of a top-level component`,
    );
  }

  #walk(node: Node, context: Context): void {
    switch (node.type) {
      case "Identifier":
        this.#reference(context, nameOf(node) ?? "", node, false);
        return;
      case "JSXOpeningElement":
        this.#element(node, context);
        return;
      case "MemberExpression": {
        const object = child(node, "object");
        const property = child(node, "property");
        const namespace =
          object?.type === "Identifier"
            ? context.module.imports.get(nameOf(object) ?? "")
            : undefined;
        if (namespace?.name === "*" && !computed(node)) {
          this.reachExport(namespace.module, nameOf(property) ?? "");
          return;
        }
        if (object) this.#walk(object, context);
        if (property && computed(node)) this.#walk(property, context);
        return;
      }
      case "Property":
      case "MethodDefinition":
      case "PropertyDefinition": {
        const key = child(node, "key");
        const value = child(node, "value");
        if (key && computed(node)) this.#walk(key, context);
        if (value) this.#walk(value, context);
        return;
      }
      case "VariableDeclarator":
      case "AssignmentExpression": {
        const [target, source] =
          node.type === "VariableDeclarator"
            ? [child(node, "id"), child(node, "init")]
            : [child(node, "left"), child(node, "right")];
        this.#walkPattern(target, context);
        if (source) this.#walk(source, context);
        return;
      }
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        this.#function(node, context, false);
        return;
      case "ClassDeclaration":
      case "ClassExpression":
        for (const key of ["superClass", "body"]) {
          const part = child(node, key);
          if (part) this.#walk(part, context);
        }
        return;
      case "CatchClause":
      case "LabeledStatement": {
        const body = child(node, "body");
        if (body) this.#walk(body, context);
        return;
      }
      case "BreakStatement":
      case "ContinueStatement":
      case "JSXClosingElement":
        return;
      case "ImportExpression": {
        const source = child(node, "source");
        const specifier = stringOf(source);
        if (specifier?.startsWith("."))
          this.reachExport(
            normalize(join(dirname(context.module.path), specifier)),
            "*",
          );
        else if (source) this.#walk(source, context);
        return;
      }
      case "CallExpression":
      case "NewExpression":
      case "TSInstantiationExpression":
        this.#checkTypes(node, context, child(node, "typeArguments"));
        break;
      default:
        if (typeDeclarations.has(node.type)) return;
    }
    for (const item of nodesIn(node)) this.#walk(item, context);
  }
}

/** Walks a route module's `Route` declaration over the sources that `read` returns by repository path. */
export function iconUsage(
  read: (path: string) => string | undefined,
  module: string,
  declaration = "Route",
): IconUsage {
  const modules = new Map<string, ModuleIndex>();
  const load = (path: string): ModuleIndex => {
    const known = modules.get(path);
    if (known) return known;
    const source = read(path);
    if (source === undefined) throw new Error(`Missing module ${path}`);
    const index = indexModule(path, source);
    modules.set(path, index);
    return index;
  };
  const walk = new RouteWalk(load);
  walk.reachLocal(load(module), declaration);
  return walk.usage();
}

/** Returns a top-level declaration's source text, so a test can pin a flow the walk doesn't follow. */
export function declarationSource(
  read: (path: string) => string | undefined,
  module: string,
  name: string,
): string {
  const source = read(module);
  if (source === undefined) throw new Error(`Missing module ${module}`);
  const node = indexModule(module, source).declarations.get(name);
  if (!node) throw new Error(`${module} doesn't declare ${name}`);
  return source.slice(node.start, node.end);
}
