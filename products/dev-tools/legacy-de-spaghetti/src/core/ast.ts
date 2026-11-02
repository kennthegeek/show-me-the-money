/** Parsing and function-discovery helpers built on the TypeScript compiler API (works for JS too). */

import { extname } from "node:path";

import ts from "typescript";

export type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

export function scriptKind(file: string): ts.ScriptKind {
  switch (extname(file).toLowerCase()) {
    case ".ts":
    case ".mts":
    case ".cts":
      return ts.ScriptKind.TS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.JS;
  }
}

export function isTsFile(file: string): boolean {
  const k = scriptKind(file);
  return k === ts.ScriptKind.TS || k === ts.ScriptKind.TSX;
}

export function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
}

/** Syntax errors only (no type checking). */
export function syntaxErrors(sf: ts.SourceFile): string[] {
  const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  return diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

export function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

export function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function propName(name: ts.PropertyName | ts.BindingName | undefined, sf: ts.SourceFile): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(sf);
}

/** Best-effort human name for a function node: `foo`, `Class.method`, `module.exports.bar`. */
export function functionName(fn: FunctionLike, sf: ts.SourceFile): string {
  const owner = (n: ts.Node): string | undefined => {
    const cls = n.parent;
    if (cls && (ts.isClassDeclaration(cls) || ts.isClassExpression(cls))) {
      return cls.name?.text ?? "<class>";
    }
    return undefined;
  };
  if (ts.isConstructorDeclaration(fn)) return `${owner(fn) ?? "<class>"}.constructor`;
  if (ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) {
    const cls = owner(fn);
    const n = propName(fn.name, sf) ?? "<method>";
    return cls ? `${cls}.${n}` : n;
  }
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text;
  if (ts.isFunctionDeclaration(fn) && ts.getModifiers(fn)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return "default";
  const p = fn.parent;
  if (ts.isVariableDeclaration(p)) return propName(p.name, sf) ?? "<anonymous>";
  if (ts.isPropertyAssignment(p)) return propName(p.name, sf) ?? "<anonymous>";
  if (ts.isPropertyDeclaration(p)) return `${owner(p) ?? ""}${owner(p) ? "." : ""}${propName(p.name, sf)}`;
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return p.left.getText(sf);
  if (ts.isExportAssignment(p)) return "default";
  return `<anonymous:${lineOf(sf, fn.getStart(sf))}>`;
}

/** All function-like nodes in a file, outermost first. */
export function collectFunctions(sf: ts.SourceFile): FunctionLike[] {
  const out: FunctionLike[] = [];
  const visit = (n: ts.Node) => {
    if (isFunctionLike(n) && n.body) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export function findFunction(sf: ts.SourceFile, name: string): FunctionLike | undefined {
  const fns = collectFunctions(sf);
  return (
    fns.find((f) => functionName(f, sf) === name) ??
    fns.find((f) => functionName(f, sf).split(".").pop() === name)
  );
}

/** Visit children but do not descend into nested functions or classes. */
export function forEachOwnNode(root: ts.Node, cb: (n: ts.Node) => void): void {
  const visit = (n: ts.Node) => {
    cb(n);
    if (n !== root && (isFunctionLike(n) || ts.isClassLike(n))) return;
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(root, visit);
}

/** Text of the line(s) indentation at `pos`. */
export function indentAt(text: string, pos: number): string {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const m = /^[ \t]*/.exec(text.slice(lineStart));
  return m ? m[0] : "";
}

/** Detect the file's indentation unit (2 spaces, 4 spaces, tab). */
export function indentUnit(text: string): string {
  const counts = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = /^( +|\t+)\S/.exec(line);
    if (!m) continue;
    const ws = m[1]!;
    if (ws.startsWith("\t")) counts.set("\t", (counts.get("\t") ?? 0) + 1);
    else if (ws.length % 4 === 0) counts.set("    ", (counts.get("    ") ?? 0) + 1);
    else if (ws.length % 2 === 0) counts.set("  ", (counts.get("  ") ?? 0) + 1);
  }
  const two = counts.get("  ") ?? 0;
  const four = counts.get("    ") ?? 0;
  const tab = counts.get("\t") ?? 0;
  if (tab > two + four) return "\t";
  // Files indented with 2 spaces also have many lines at multiples of 4.
  return two > 0 ? "  " : four > 0 ? "    " : "  ";
}

export function nodeLines(sf: ts.SourceFile, node: ts.Node): number {
  return lineOf(sf, node.getEnd()) - lineOf(sf, node.getStart(sf)) + 1;
}

/** Non-blank, non-comment lines in [start, end). */
export function logicalLines(text: string, start: number, end: number): number {
  const slice = text.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""));
  let n = 0;
  for (const raw of slice.split("\n")) {
    const line = raw.trim();
    if (line && !line.startsWith("//")) n++;
  }
  return n;
}

const RESERVED = new Set(
  ("break case catch class const continue debugger default delete do else enum export extends false finally for " +
    "function if import in instanceof new null return super switch this throw true try typeof var void while with " +
    "yield let static implements interface package private protected public await arguments eval undefined NaN Infinity")
    .split(" "),
);

export function isValidIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !RESERVED.has(name);
}

/** Every identifier text used anywhere in the file (for unique-name generation). */
export function allIdentifiers(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n)) names.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}
