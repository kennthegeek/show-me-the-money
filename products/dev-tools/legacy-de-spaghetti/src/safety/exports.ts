/** Find the callable entry points a characterization suite can drive: a module's exported functions. */

import ts from "typescript";

import { type FunctionLike, isFunctionLike } from "../core/ast.ts";

export interface ExportTarget {
  /** Name to access on the loaded module. "default" for ESM default, "<module>" when module.exports is the function. */
  exportName: string;
  fn: FunctionLike;
}

export const MODULE_ITSELF = "<module>";

function localFunctions(sf: ts.SourceFile): Map<string, FunctionLike> {
  const map = new Map<string, FunctionLike>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) map.set(st.name.text, st);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && isFunctionLike(d.initializer)) {
          map.set(d.name.text, d.initializer);
        }
      }
    }
  }
  return map;
}

function hasExportModifier(n: ts.Node): boolean {
  return Boolean(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

function hasDefaultModifier(n: ts.Node): boolean {
  return Boolean(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
}

/** `module.exports` or `exports` (optionally `.name`). Returns the property name, "" for the object itself. */
function cjsTarget(expr: ts.Expression): string | undefined {
  const isModuleExports = (e: ts.Expression) =>
    ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "module" && e.name.text === "exports";
  const isExports = (e: ts.Expression) => ts.isIdentifier(e) && e.text === "exports";
  if (isModuleExports(expr)) return "";
  if (ts.isPropertyAccessExpression(expr) && (isModuleExports(expr.expression) || isExports(expr.expression))) {
    return expr.name.text;
  }
  return undefined;
}

export function discoverExports(sf: ts.SourceFile): ExportTarget[] {
  const locals = localFunctions(sf);
  const out = new Map<string, FunctionLike>();
  const resolve = (e: ts.Expression | undefined): FunctionLike | undefined => {
    if (!e) return undefined;
    if (isFunctionLike(e)) return e;
    if (ts.isIdentifier(e)) return locals.get(e.text);
    return undefined;
  };

  for (const st of sf.statements) {
    // ESM declarations
    if (ts.isFunctionDeclaration(st) && st.body && hasExportModifier(st)) {
      out.set(hasDefaultModifier(st) ? "default" : (st.name?.text ?? "default"), st);
    }
    if (ts.isVariableStatement(st) && hasExportModifier(st)) {
      for (const d of st.declarationList.declarations) {
        const fn = resolve(d.initializer);
        if (fn && ts.isIdentifier(d.name)) out.set(d.name.text, fn);
      }
    }
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause) && !st.moduleSpecifier) {
      for (const spec of st.exportClause.elements) {
        const local = (spec.propertyName ?? spec.name).text;
        const fn = locals.get(local);
        if (fn) out.set(spec.name.text, fn);
      }
    }
    if (ts.isExportAssignment(st) && !st.isExportEquals) {
      const fn = resolve(st.expression);
      if (fn) out.set("default", fn);
    }
    if (ts.isExportAssignment(st) && st.isExportEquals) {
      const fn = resolve(st.expression);
      if (fn) out.set(MODULE_ITSELF, fn);
    }

    // CommonJS
    if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression)) {
      const { left, right, operatorToken } = st.expression;
      if (operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
      const target = cjsTarget(left);
      if (target === undefined) continue;
      if (target !== "") {
        const fn = resolve(right);
        if (fn) out.set(target, fn);
        continue;
      }
      // module.exports = ...
      const direct = resolve(right);
      if (direct) {
        out.set(MODULE_ITSELF, direct);
        continue;
      }
      if (ts.isObjectLiteralExpression(right)) {
        for (const p of right.properties) {
          if (ts.isShorthandPropertyAssignment(p)) {
            const fn = locals.get(p.name.text);
            if (fn) out.set(p.name.text, fn);
          } else if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
            const fn = resolve(p.initializer);
            if (fn) out.set(p.name.text, fn);
          } else if (ts.isMethodDeclaration(p) && p.body && ts.isIdentifier(p.name)) {
            out.set(p.name.text, p);
          }
        }
      }
    }
  }
  return [...out.entries()].map(([exportName, fn]) => ({ exportName, fn }));
}
