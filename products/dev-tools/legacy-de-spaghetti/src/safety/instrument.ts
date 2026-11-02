/**
 * Statement-level coverage probes. We insert `__dsHit(id)` before every statement inside
 * function bodies (in a throwaway copy that only the recorder child ever sees) so we know
 * which statements the safety-net inputs actually executed. The refactor engine refuses to
 * extract code the safety net never ran, because "tests pass" means nothing for code
 * they don't reach.
 */

import ts from "typescript";

import { isFunctionLike, parse } from "../core/ast.ts";

export interface Probe {
  id: number;
  start: number; // position in the *original* text
  end: number;
}

export interface Instrumented {
  source: string;
  probes: Probe[];
}

export function instrument(file: string, text: string): Instrumented {
  const sf = parse(file, text);
  const probes: Probe[] = [];
  let insideFunction = 0;

  const visit = (n: ts.Node) => {
    const fn = isFunctionLike(n);
    if (fn) insideFunction++;
    if (
      insideFunction > 0 &&
      isStatementInList(n) &&
      !isDirective(n as ts.Statement) &&
      !ts.isFunctionDeclaration(n) && // hoisted; probing them is meaningless
      !ts.isInterfaceDeclaration(n) &&
      !ts.isTypeAliasDeclaration(n)
    ) {
      probes.push({ id: probes.length, start: n.getStart(sf), end: n.getEnd() });
    }
    ts.forEachChild(n, visit);
    if (fn) insideFunction--;
  };
  visit(sf);

  // Insert from the end so earlier positions stay valid.
  let out = text;
  for (const p of [...probes].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, p.start)}globalThis.__dsHit&&globalThis.__dsHit(${p.id});${out.slice(p.start)}`;
  }
  return { source: out, probes };
}

function isStatementInList(n: ts.Node): boolean {
  if (!ts.isStatement(n) && !ts.isVariableStatement(n)) return false;
  const p = n.parent;
  return Boolean(p && (ts.isBlock(p) || ts.isCaseClause(p) || ts.isDefaultClause(p)));
}

function isDirective(st: ts.Statement): boolean {
  return ts.isExpressionStatement(st) && ts.isStringLiteral(st.expression) && ts.isBlock(st.parent) &&
    st.parent.statements.indexOf(st) === 0;
}

/** Fraction of probes inside [start, end) that were hit (undefined when the range has no probes). */
export function coverageOf(probes: Probe[], hits: Set<number>, start: number, end: number): number | undefined {
  const inside = probes.filter((p) => p.start >= start && p.end <= end);
  if (inside.length === 0) return undefined;
  return inside.filter((p) => hits.has(p.id)).length / inside.length;
}
