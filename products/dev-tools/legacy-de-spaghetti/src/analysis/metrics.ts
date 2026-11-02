/** Per-function complexity metrics and the "spaghetti score". */

import { readFileSync } from "node:fs";

import ts from "typescript";

import type { Thresholds } from "../config.ts";
import {
  collectFunctions,
  forEachOwnNode,
  type FunctionLike,
  functionName,
  isFunctionLike,
  lineOf,
  logicalLines,
  parse,
} from "../core/ast.ts";

export interface FunctionMetrics {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  /** Physical lines spanned. */
  span: number;
  /** Non-blank, non-comment lines (including nested callbacks). */
  lines: number;
  complexity: number;
  maxDepth: number;
  params: number;
  /** 0 (clean) … 100 (pure spaghetti). */
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  violations: string[];
}

export interface FileMetrics {
  file: string;
  lines: number;
  functions: FunctionMetrics[];
  parseError?: string;
}

/** McCabe cyclomatic complexity of the function's own body (nested functions are measured separately). */
export function cyclomatic(fn: ts.Node): number {
  let c = 1;
  forEachOwnNode(fn, (n) => {
    switch (n.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CatchClause:
        c++;
        break;
      case ts.SyntaxKind.CaseClause:
        c++;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const op = (n as ts.BinaryExpression).operatorToken.kind;
        if (
          op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken ||
          op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
          op === ts.SyntaxKind.BarBarEqualsToken ||
          op === ts.SyntaxKind.QuestionQuestionEqualsToken
        ) {
          c++;
        }
        break;
      }
    }
  });
  return c;
}

const NESTING = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.CatchClause,
]);

/** Deepest control-flow nesting inside the function (an `else if` chain counts as one level). */
export function maxNesting(fn: FunctionLike): number {
  let max = 0;
  const visit = (n: ts.Node, depth: number) => {
    if (n !== fn && isFunctionLike(n)) return;
    let d = depth;
    const isElseIf = ts.isIfStatement(n) && ts.isIfStatement(n.parent) && n.parent.elseStatement === n;
    if (NESTING.has(n.kind) && !isElseIf && !ts.isCatchClause(n)) {
      d = depth + 1;
      max = Math.max(max, d);
    }
    ts.forEachChild(n, (c) => visit(c, d));
  };
  if (fn.body) visit(fn.body, 0);
  return max;
}

/** Weighted, saturating score: each dimension contributes up to its weight as it exceeds the threshold. */
export function spaghettiScore(m: Pick<FunctionMetrics, "lines" | "complexity" | "maxDepth" | "params">, t: Thresholds): number {
  const ratio = (v: number, limit: number) => Math.max(0, v / limit - 0.5); // starts counting at half the limit
  const sat = (x: number) => 1 - Math.exp(-x); // 0 → 0, large → 1
  const s =
    40 * sat(ratio(m.lines, t.maxLines)) +
    35 * sat(ratio(m.complexity, t.maxComplexity)) +
    18 * sat(ratio(m.maxDepth, t.maxDepth)) +
    7 * sat(ratio(m.params, t.maxParams));
  return Math.round(Math.min(100, s));
}

export function grade(score: number): FunctionMetrics["grade"] {
  if (score < 15) return "A";
  if (score < 30) return "B";
  if (score < 45) return "C";
  if (score < 60) return "D";
  return "F";
}

export function measureFunction(fn: FunctionLike, sf: ts.SourceFile, t: Thresholds): FunctionMetrics {
  const text = sf.getFullText();
  const start = fn.getStart(sf);
  const base = {
    lines: logicalLines(text, start, fn.getEnd()),
    complexity: cyclomatic(fn),
    maxDepth: maxNesting(fn),
    params: fn.parameters.length,
  };
  const violations: string[] = [];
  if (base.lines > t.maxLines) violations.push(`${base.lines} lines > ${t.maxLines}`);
  if (base.complexity > t.maxComplexity) violations.push(`complexity ${base.complexity} > ${t.maxComplexity}`);
  if (base.maxDepth > t.maxDepth) violations.push(`nesting ${base.maxDepth} > ${t.maxDepth}`);
  if (base.params > t.maxParams) violations.push(`${base.params} params > ${t.maxParams}`);
  const score = spaghettiScore(base, t);
  return {
    name: functionName(fn, sf),
    file: sf.fileName,
    startLine: lineOf(sf, start),
    endLine: lineOf(sf, fn.getEnd()),
    span: lineOf(sf, fn.getEnd()) - lineOf(sf, start) + 1,
    ...base,
    score,
    grade: grade(score),
    violations,
  };
}

export function analyzeSource(file: string, text: string, t: Thresholds): FileMetrics {
  const sf = parse(file, text);
  return {
    file,
    lines: logicalLines(text, 0, text.length),
    functions: collectFunctions(sf).map((fn) => measureFunction(fn, sf, t)),
  };
}

export function analyzeFile(file: string, t: Thresholds): FileMetrics {
  try {
    return analyzeSource(file, readFileSync(file, "utf8"), t);
  } catch (e) {
    return { file, lines: 0, functions: [], parseError: (e as Error).message };
  }
}
