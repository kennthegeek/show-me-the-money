/**
 * Input synthesis for characterization tests.
 *
 * Legacy code rarely has types, so we infer the *shape* each parameter is used as, from
 * how the body touches it: property chains (order.customer.tier), array methods and
 * for-of loops (order.items[].qty), comparisons with literals (tier === "gold",
 * qty > 10), typeof checks, arithmetic, defaults and (when present) TS annotations,
 * including interfaces declared in the same file. Then we generate a base case plus
 * one-factor-at-a-time variations that hit the boundaries the code itself compares
 * against, which is what exercises its branches.
 */

import ts from "typescript";

import type { FunctionLike } from "../core/ast.ts";
import { encode, fingerprint, type Encoded } from "./serialize.ts";

type Prim = string | number | boolean | null;
type Kind = "number" | "string" | "boolean" | "array" | "object" | "function";

export interface Shape {
  kinds: Set<Kind>;
  /** Used as a condition (if (x), !x, x && …) — a boolean unless other evidence says otherwise. */
  truthy?: boolean;
  literals: Prim[];
  props: Map<string, Shape>;
  element?: Shape;
  name: string;
}

function newShape(name: string): Shape {
  return { kinds: new Set(), literals: [], props: new Map(), name };
}

const ARRAY_METHODS = new Set([
  "map", "forEach", "filter", "reduce", "reduceRight", "some", "every", "find", "findIndex", "findLast", "push",
  "pop", "shift", "unshift", "slice", "splice", "join", "includes", "indexOf", "sort", "concat", "flatMap", "flat",
  "reverse", "at", "entries", "keys", "values",
]);
const STRING_METHODS = new Set([
  "toUpperCase", "toLowerCase", "trim", "trimStart", "trimEnd", "split", "startsWith", "endsWith", "replace",
  "replaceAll", "padStart", "padEnd", "charAt", "charCodeAt", "substring", "substr", "match", "localeCompare", "repeat",
  "normalize",
]);
const NUMBER_METHODS = new Set(["toFixed", "toPrecision"]);
const ELEMENT_CALLBACK = new Set(["map", "forEach", "filter", "some", "every", "find", "findIndex", "findLast", "flatMap", "sort"]);

type Path = { root: number; path: string[] };

export interface ParamShapes {
  names: string[];
  shapes: Shape[];
  optional: boolean[];
}

export function inferParamShapes(fn: FunctionLike, sf: ts.SourceFile): ParamShapes {
  const types = localTypes(sf);
  const shapes: Shape[] = [];
  const names: string[] = [];
  const optional: boolean[] = [];
  const aliases = new Map<string, Path>();

  fn.parameters.forEach((p, i) => {
    const name = ts.isIdentifier(p.name) ? p.name.text : `arg${i}`;
    const shape = newShape(name);
    names.push(name);
    shapes.push(shape);
    optional.push(Boolean(p.questionToken || p.initializer || p.dotDotDotToken));
    if (ts.isIdentifier(p.name)) aliases.set(p.name.text, { root: i, path: [] });
    else bindPattern(p.name, { root: i, path: [] }, aliases, shapes);
    if (p.type) applyTypeNode(shape, p.type, types, 0);
    if (p.initializer) applyLiteral(shape, p.initializer);
    if (p.dotDotDotToken) shape.kinds.add("array");
  });

  const shapeAt = (ref: Path, create = true): Shape | undefined => {
    let s = shapes[ref.root];
    for (const seg of ref.path) {
      if (!s) return undefined;
      if (seg === "[]") {
        s.kinds.add("array");
        if (!s.element) {
          if (!create) return undefined;
          s.element = newShape(singular(s.name));
        }
        s = s.element;
      } else {
        s.kinds.add("object");
        let next = s.props.get(seg);
        if (!next) {
          if (!create) return undefined;
          next = newShape(seg);
          s.props.set(seg, next);
        }
        s = next;
      }
    }
    return s;
  };

  /** Resolve an expression like `order.items[0].qty` to a parameter path, if it is one. */
  const pathOf = (e: ts.Expression): Path | undefined => {
    if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) return pathOf(e.expression);
    if (ts.isIdentifier(e)) return aliases.get(e.text);
    if (ts.isPropertyAccessExpression(e)) {
      const base = pathOf(e.expression);
      if (!base) return undefined;
      const name = e.name.text;
      if (name === "length") return undefined; // handled separately
      return { root: base.root, path: [...base.path, name] };
    }
    if (ts.isElementAccessExpression(e)) {
      const base = pathOf(e.expression);
      if (!base) return undefined;
      const arg = e.argumentExpression;
      if (ts.isStringLiteral(arg)) return { root: base.root, path: [...base.path, arg.text] };
      return { root: base.root, path: [...base.path, "[]"] };
    }
    return undefined;
  };

  const visit = (n: ts.Node) => {
    // Aliases: const x = order.items;  const { a, b: c } = order;  var opts = options || {};
    if (ts.isVariableDeclaration(n) && n.initializer) {
      let init = n.initializer;
      if (ts.isBinaryExpression(init) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(init.operatorToken.kind)) {
        init = init.left;
      }
      const ref = pathOf(init);
      if (ref) {
        if (ts.isIdentifier(n.name)) aliases.set(n.name.text, ref);
        else bindPattern(n.name, ref, aliases, shapes, shapeAt);
      }
    }
    // for (const it of order.items) / for (const k in obj)
    if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && ts.isVariableDeclarationList(n.initializer)) {
      const ref = pathOf(n.expression);
      const decl = n.initializer.declarations[0];
      if (ref && decl) {
        if (ts.isForOfStatement(n)) {
          const elem = { root: ref.root, path: [...ref.path, "[]"] };
          shapeAt(elem);
          if (ts.isIdentifier(decl.name)) aliases.set(decl.name.text, elem);
          else bindPattern(decl.name, elem, aliases, shapes, shapeAt);
        } else {
          shapeAt(ref)?.kinds.add("object");
        }
      }
    }
    // order.items.forEach(item => ...), reduce((acc, item) => ...)
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text;
      const ref = pathOf(n.expression.expression);
      if (ref) {
        const target = shapeAt(ref);
        if (ARRAY_METHODS.has(method)) target?.kinds.add("array");
        else if (STRING_METHODS.has(method)) target?.kinds.add("string");
        else if (NUMBER_METHODS.has(method)) target?.kinds.add("number");
        const cb = n.arguments[0];
        if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
          const idx = method === "reduce" || method === "reduceRight" ? 1 : ELEMENT_CALLBACK.has(method) ? 0 : -1;
          const param = idx >= 0 ? cb.parameters[idx] : undefined;
          if (param) {
            const elem = { root: ref.root, path: [...ref.path, "[]"] };
            shapeAt(elem);
            if (ts.isIdentifier(param.name)) aliases.set(param.name.text, elem);
            else bindPattern(param.name, elem, aliases, shapes, shapeAt);
          }
        }
        // Calling a method we don't know means the path itself is an object.
      }
      const owner = pathOf(n.expression);
      if (owner && !ARRAY_METHODS.has(method) && !STRING_METHODS.has(method)) {
        const s = shapeAt(owner);
        s?.kinds.add("function");
      }
    }
    // x.length
    if (ts.isPropertyAccessExpression(n) && n.name.text === "length") {
      const ref = pathOf(n.expression);
      const s = ref && shapeAt(ref);
      if (s && !s.kinds.has("string")) s.kinds.add("array");
    }
    // Property access marks intermediate objects.
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      const ref = pathOf(n);
      if (ref) shapeAt(ref);
    }
    // Comparisons with literals, typeof checks, arithmetic.
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      const cmp = [
        ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
        ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
      ].includes(op);
      if (cmp) {
        for (const [a, b] of [[n.left, n.right], [n.right, n.left]] as const) {
          if (ts.isTypeOfExpression(a) && ts.isStringLiteral(b)) {
            const ref = pathOf(a.expression);
            const s = ref && shapeAt(ref);
            const k = b.text as Kind;
            if (s && ["number", "string", "boolean", "function"].includes(k)) s.kinds.add(k);
            if (s && k === "object") s.kinds.add("object");
            continue;
          }
          const ref = pathOf(a);
          if (ref) {
            const s = shapeAt(ref);
            if (s) applyLiteral(s, b);
          }
        }
      }
      const arith = [
        ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken,
        ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken,
      ].includes(op);
      if (arith) {
        for (const side of [n.left, n.right]) {
          const ref = pathOf(side);
          if (ref) shapeAt(ref)?.kinds.add("number");
        }
      }
    }
    // Truthiness: if (x), x ? a : b, !x, x && y, x || "default"
    const condition = (e: ts.Expression | undefined) => {
      if (!e) return;
      const ref = pathOf(e);
      const s = ref && shapeAt(ref);
      if (s) s.truthy = true;
    };
    if (ts.isIfStatement(n) || ts.isWhileStatement(n)) condition(n.expression);
    if (ts.isConditionalExpression(n)) condition(n.condition);
    if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) condition(n.operand);
    if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind;
      if (k === ts.SyntaxKind.AmpersandAmpersandToken) {
        condition(n.left);
        condition(n.right);
      }
      if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken) {
        const ref = pathOf(n.left);
        const s = ref && shapeAt(ref);
        if (s) {
          applyLiteral(s, n.right);
          s.truthy = true;
        }
      }
    }
    if (ts.isSwitchStatement(n)) {
      const ref = pathOf(n.expression);
      const s = ref && shapeAt(ref);
      if (s) for (const c of n.caseBlock.clauses) if (ts.isCaseClause(c)) applyLiteral(s, c.expression);
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const obj = n.expression.expression;
      if (ts.isIdentifier(obj) && obj.text === "Math") {
        for (const a of n.arguments) {
          const ref = pathOf(a);
          if (ref) shapeAt(ref)?.kinds.add("number");
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return { names, shapes, optional };
}

function bindPattern(
  pattern: ts.BindingName,
  ref: Path,
  aliases: Map<string, Path>,
  shapes: Shape[],
  shapeAt?: (p: Path) => Shape | undefined,
) {
  if (ts.isObjectBindingPattern(pattern)) {
    for (const el of pattern.elements) {
      const key = el.propertyName
        ? ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName)
          ? el.propertyName.text
          : undefined
        : ts.isIdentifier(el.name)
          ? el.name.text
          : undefined;
      if (!key) continue;
      const child = { root: ref.root, path: [...ref.path, key] };
      ensure(shapes, child, shapeAt);
      if (ts.isIdentifier(el.name)) aliases.set(el.name.text, child);
      else bindPattern(el.name, child, aliases, shapes, shapeAt);
    }
  } else if (ts.isArrayBindingPattern(pattern)) {
    const child = { root: ref.root, path: [...ref.path, "[]"] };
    ensure(shapes, child, shapeAt);
    for (const el of pattern.elements) {
      if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) aliases.set(el.name.text, child);
    }
  }
}

function ensure(shapes: Shape[], ref: Path, shapeAt?: (p: Path) => Shape | undefined) {
  if (shapeAt) {
    shapeAt(ref);
    return;
  }
  let s = shapes[ref.root]!;
  for (const seg of ref.path) {
    if (seg === "[]") {
      s.kinds.add("array");
      s.element ??= newShape(singular(s.name));
      s = s.element;
    } else {
      s.kinds.add("object");
      if (!s.props.has(seg)) s.props.set(seg, newShape(seg));
      s = s.props.get(seg)!;
    }
  }
}

function applyLiteral(s: Shape, e: ts.Expression) {
  if (ts.isNumericLiteral(e)) {
    s.kinds.add("number");
    s.literals.push(Number(e.text));
  } else if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) {
    s.kinds.add("number");
    s.literals.push(-Number(e.operand.text));
  } else if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
    s.kinds.add("string");
    s.literals.push(e.text);
  } else if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) {
    s.kinds.add("boolean");
  } else if (e.kind === ts.SyntaxKind.NullKeyword) {
    s.literals.push(null);
  } else if (ts.isArrayLiteralExpression(e)) {
    s.kinds.add("array");
  } else if (ts.isObjectLiteralExpression(e)) {
    s.kinds.add("object");
  }
}

type TypeTable = Map<string, ts.TypeNode | ts.InterfaceDeclaration>;

function localTypes(sf: ts.SourceFile): TypeTable {
  const t: TypeTable = new Map();
  for (const st of sf.statements) {
    if (ts.isInterfaceDeclaration(st)) t.set(st.name.text, st);
    if (ts.isTypeAliasDeclaration(st)) t.set(st.name.text, st.type);
  }
  return t;
}

function applyMembers(s: Shape, members: ts.NodeArray<ts.TypeElement>, types: TypeTable, depth: number) {
  s.kinds.add("object");
  for (const m of members) {
    if (ts.isPropertySignature(m) && m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) {
      const child = s.props.get(m.name.text) ?? newShape(m.name.text);
      s.props.set(m.name.text, child);
      if (m.type) applyTypeNode(child, m.type, types, depth + 1);
    }
  }
}

function applyTypeNode(s: Shape, t: ts.TypeNode | ts.InterfaceDeclaration, types: TypeTable, depth: number): void {
  if (depth > 5) return;
  if (ts.isInterfaceDeclaration(t)) return applyMembers(s, t.members, types, depth);
  switch (t.kind) {
    case ts.SyntaxKind.NumberKeyword:
      s.kinds.add("number");
      return;
    case ts.SyntaxKind.StringKeyword:
      s.kinds.add("string");
      return;
    case ts.SyntaxKind.BooleanKeyword:
      s.kinds.add("boolean");
      return;
  }
  if (ts.isLiteralTypeNode(t)) return applyLiteral(s, t.literal as ts.Expression);
  if (ts.isUnionTypeNode(t)) return t.types.forEach((u) => applyTypeNode(s, u, types, depth + 1));
  if (ts.isParenthesizedTypeNode(t)) return applyTypeNode(s, t.type, types, depth);
  if (ts.isArrayTypeNode(t)) {
    s.kinds.add("array");
    s.element ??= newShape(singular(s.name));
    return applyTypeNode(s.element, t.elementType, types, depth + 1);
  }
  if (ts.isTypeLiteralNode(t)) return applyMembers(s, t.members, types, depth);
  if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)) {
    const name = t.typeName.text;
    if ((name === "Array" || name === "ReadonlyArray") && t.typeArguments?.[0]) {
      s.kinds.add("array");
      s.element ??= newShape(singular(s.name));
      return applyTypeNode(s.element, t.typeArguments[0], types, depth + 1);
    }
    const local = types.get(name);
    if (local) applyTypeNode(s, local, types, depth + 1);
  }
}

function singular(name: string): string {
  if (name.endsWith("ies")) return `${name.slice(0, -3)}y`;
  if (name.endsWith("s") && name.length > 3) return name.slice(0, -1);
  return `${name}Item`;
}

// ---------------------------------------------------------------------------------------------
// Value generation
// ---------------------------------------------------------------------------------------------

function nameGuess(name: string): Kind | undefined {
  if (/^(is|has|should|can|enable|disable|allow)[A-Z_]|enabled$|flag$|^debug$|^verbose$/i.test(name)) return "boolean";
  if (/(count|qty|quantity|amount|price|total|num|number|age|size|index|idx|rate|percent|weight|cost|tax|discount|score|limit|max|min|level|days|hours|year|month)$/i.test(name)) return "number";
  if (/^(n|i|j|k|x|y|z)$/.test(name)) return "number";
  if (/(name|type|code|status|email|title|label|key|mode|kind|id|tier|region|country|currency|category|role|state|url|path|text|message|description|sku)$/i.test(name)) return "string";
  if (/(list|items|array|entries|rows|records|lines)$/i.test(name)) return "array";
  if (/(options|opts|config|settings|params|context|ctx|data|payload|props)$/i.test(name)) return "object";
  return undefined;
}

function sampleString(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("email")) return "jane@example.com";
  if (n.includes("country")) return "US";
  if (n.includes("currency")) return "USD";
  if (n.includes("date")) return "2024-01-15";
  if (n.endsWith("id")) return "id-1";
  if (n.includes("name")) return "Jane";
  return `${name}-1`;
}

function uniq<T>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = fingerprint(encode(x));
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function primaryKind(s: Shape): Kind {
  if (s.kinds.has("array")) return "array";
  if (s.props.size > 0 || s.kinds.has("object")) return "object";
  if (s.kinds.has("number")) return "number";
  if (s.kinds.has("string")) return "string";
  if (s.kinds.has("boolean")) return "boolean";
  if (s.kinds.has("function")) return "object";
  const guess = nameGuess(s.name);
  if (s.truthy && (guess === undefined || guess === "boolean")) return "boolean";
  return guess ?? "string";
}

/** Candidate values for a shape; index 0 is the "typical" value used in the base case. */
export function candidates(s: Shape, depth = 0): unknown[] {
  const kind = primaryKind(s);
  const lits = s.literals;
  switch (kind) {
    case "number": {
      const nums = lits.filter((l): l is number => typeof l === "number");
      const around = nums.flatMap((l) => [l, l + 1, l - 1]);
      const typical = nums.length ? Math.max(...nums) + 1 : /price|cost|amount|total/i.test(s.name) ? 25 : 3;
      return uniq([typical, ...around, 0, -1]).slice(0, 8);
    }
    case "string": {
      const strs = lits.filter((l): l is string => typeof l === "string");
      // "other" hits the fall-through branch of literal comparisons (unknown tier, invalid coupon…).
      return uniq([...(strs.length ? strs : [sampleString(s.name)]), sampleString(s.name), "other", ""]).slice(0, 8);
    }
    case "boolean":
      return [true, false];
    case "array": {
      if (depth > 3) return [[]];
      const elem = s.element ? candidates(s.element, depth + 1) : ["a", "b"];
      const e0 = elem[0];
      const e1 = elem[1] ?? elem[0];
      return uniq([[e0, e1], [], [e0], ...elem.slice(1, 4).map((e) => [e])]);
    }
    case "object": {
      if (depth > 3) return [{}];
      const base: Record<string, unknown> = {};
      const alts: Record<string, unknown[]> = {};
      for (const [k, child] of s.props) {
        const cs = candidates(child, depth + 1);
        base[k] = cs[0];
        alts[k] = cs.slice(1);
      }
      const variants: unknown[] = [base];
      for (const [k, cs] of Object.entries(alts)) {
        for (const c of cs.slice(0, depth === 0 ? 6 : 3)) variants.push({ ...base, [k]: c });
      }
      return uniq(variants);
    }
    default:
      return [null];
  }
}

export interface GeneratedCase {
  args: Encoded[];
  label: string;
}

/**
 * Base case + one-factor-at-a-time variations, interleaved across parameters so a small
 * budget still varies every parameter, plus null/undefined edge cases (legacy code's
 * behaviour on bad input is part of what we must preserve).
 */
export function generateCases(p: ParamShapes, maxCases: number): GeneratedCase[] {
  const perParam = p.shapes.map((s) => candidates(s));
  const base = perParam.map((c) => c[0]);
  const cases: unknown[][] = [base];
  const queues = perParam.map((c) => c.slice(1));
  let progressed = true;
  while (cases.length < maxCases && progressed) {
    progressed = false;
    for (let i = 0; i < queues.length && cases.length < maxCases; i++) {
      const next = queues[i]!.shift();
      if (next === undefined && queues[i]!.length === 0) continue;
      progressed = true;
      const args = [...base];
      args[i] = next;
      cases.push(args);
    }
  }
  for (let i = 0; i < p.shapes.length && cases.length < maxCases; i++) {
    const args = [...base];
    args[i] = p.optional[i] ? undefined : null;
    cases.push(args);
  }
  if (p.shapes.length === 0) return [{ args: [], label: "()" }];

  const seen = new Set<string>();
  const out: GeneratedCase[] = [];
  for (const args of cases) {
    const enc = args.map((a) => encode(a));
    const key = fingerprint(enc);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ args: enc, label: describe(p, args, base) });
  }
  return out.slice(0, maxCases);
}

function describe(p: ParamShapes, args: unknown[], base: unknown[]): string {
  const diffs = args
    .map((a, i) => (fingerprint(encode(a)) === fingerprint(encode(base[i])) ? undefined : `${p.names[i]}=${short(a)}`))
    .filter(Boolean);
  return diffs.length ? diffs.join(", ") : "typical input";
}

function short(v: unknown): string {
  const s = v === undefined ? "undefined" : JSON.stringify(v);
  return s.length > 48 ? `${s.slice(0, 47)}…` : s;
}
