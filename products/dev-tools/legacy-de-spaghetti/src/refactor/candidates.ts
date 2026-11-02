/**
 * Find runs of statements worth extracting. Legacy functions usually have natural seams:
 * comment headers ("// ---- shipping ----"), blank lines between phases, and big loop or
 * branch bodies. We split statement lists at those seams, try each chunk (and a few
 * merges/trims), and keep the ones data-flow analysis accepts.
 */

import { createHash } from "node:crypto";

import ts from "typescript";

import { type FunctionLike, isFunctionLike, lineOf, logicalLines } from "../core/ast.ts";
import { analyzeSegment, type SegmentAnalysis, unanalyzable } from "./dataflow.ts";

export interface Candidate {
  statements: ts.Statement[];
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  lines: number;
  /** Comment text right above the first statement, if any (used for naming). */
  heading?: string;
  /** Range of that comment, so it can move into the new function's doc comment. */
  headingRange?: { pos: number; end: number };
  analysis: SegmentAnalysis;
  fingerprint: string;
  /** Depth of the statement list (0 = function body). */
  depth: number;
}

export interface CandidateOptions {
  minSegmentLines: number;
  maxExtractedParams: number;
  maxExtractedReturns: number;
}

export interface Rejected {
  startLine: number;
  endLine: number;
  reason: string;
}

export function isMethodLike(fn: FunctionLike): boolean {
  return (ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) &&
    ts.isClassLike(fn.parent);
}

function leadingComment(sf: ts.SourceFile, st: ts.Statement): { text: string; pos: number; end: number } | undefined {
  const ranges = ts.getLeadingCommentRanges(sf.getFullText(), st.getFullStart());
  if (!ranges?.length) return undefined;
  const r = ranges[ranges.length - 1]!;
  const raw = sf.getFullText().slice(r.pos, r.end);
  const text = raw
    .replace(/^\/\*+|\*+\/$/g, "")
    .replace(/^\/\/+/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*?\s?/, ""))
    .join(" ")
    .replace(/[-=*#~_]{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || /^(eslint|prettier|@ts-|istanbul|jshint|global )/.test(text)) return undefined;
  return { text, pos: ranges[0]!.pos, end: r.end };
}

function hasBlankLineBefore(sf: ts.SourceFile, prev: ts.Statement, st: ts.Statement): boolean {
  const between = sf.getFullText().slice(prev.getEnd(), st.getStart(sf));
  return /\n[ \t]*\r?\n/.test(between);
}

function statementLists(fn: FunctionLike): { list: readonly ts.Statement[]; depth: number }[] {
  const out: { list: readonly ts.Statement[]; depth: number }[] = [];
  if (!fn.body || !ts.isBlock(fn.body)) return out;
  const visit = (n: ts.Node, depth: number) => {
    if (n !== fn.body && (isFunctionLike(n) || ts.isClassLike(n))) return;
    if (ts.isBlock(n)) out.push({ list: n.statements, depth });
    ts.forEachChild(n, (c) => visit(c, ts.isBlock(n) ? depth + 1 : depth));
  };
  visit(fn.body, 0);
  return out;
}

function fingerprint(sf: ts.SourceFile, statements: ts.Statement[]): string {
  const text = statements.map((s) => s.getText(sf)).join("\n");
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

export function findCandidates(
  fn: FunctionLike,
  sf: ts.SourceFile,
  opts: CandidateOptions,
): { candidates: Candidate[]; rejected: Rejected[]; blocked?: string } {
  const blocked = unanalyzable(fn);
  if (blocked) return { candidates: [], rejected: [], blocked };
  if (!fn.body || !ts.isBlock(fn.body)) return { candidates: [], rejected: [], blocked: "has an expression body" };
  const text = sf.getFullText();
  const bodyLines = logicalLines(text, fn.body.getStart(sf), fn.body.getEnd());
  const method = isMethodLike(fn);

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  const rejected: Rejected[] = [];

  const consider = (statements: ts.Statement[], depth: number) => {
    if (statements.length === 0) return;
    const first = statements[0]!;
    const last = statements[statements.length - 1]!;
    const start = first.getStart(sf);
    const end = last.getEnd();
    const key = `${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    const lines = logicalLines(text, start, end);
    if (lines < opts.minSegmentLines) return;
    if (depth === 0 && lines >= bodyLines - 2) return; // extracting the whole body just moves the mess
    const analysis = analyzeSegment(fn, statements, method);
    const range = { startLine: lineOf(sf, start), endLine: lineOf(sf, end) };
    if (!analysis.ok) {
      rejected.push({ ...range, reason: analysis.reason ?? "not extractable" });
      return;
    }
    const returns = analysis.returnsDeclared.length + analysis.returnsAssigned.length;
    if (analysis.params.length > opts.maxExtractedParams) {
      rejected.push({ ...range, reason: `would need ${analysis.params.length} parameters` });
      return;
    }
    if (returns > opts.maxExtractedReturns) {
      rejected.push({ ...range, reason: `would need to return ${returns} values` });
      return;
    }
    // A block spanning several commented sections shouldn't be named after only the first one.
    const spansSections = statements.slice(1).some((st) => leadingComment(sf, st) !== undefined);
    const heading = spansSections ? undefined : leadingComment(sf, first);
    candidates.push({
      statements,
      start,
      end,
      ...range,
      lines,
      ...(heading ? { heading: heading.text, headingRange: { pos: heading.pos, end: heading.end } } : {}),
      analysis,
      fingerprint: fingerprint(sf, statements),
      depth,
    });
  };

  for (const { list, depth } of statementLists(fn)) {
    // Split at seams.
    const chunks: ts.Statement[][] = [];
    let current: ts.Statement[] = [];
    list.forEach((st, i) => {
      const seam = i > 0 && (leadingComment(sf, st) !== undefined || hasBlankLineBefore(sf, list[i - 1]!, st));
      if (seam && current.length) {
        chunks.push(current);
        current = [];
      }
      current.push(st);
    });
    if (current.length) chunks.push(current);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      consider(chunk, depth);
      // Without its trailing return / leading guard, a chunk is often extractable.
      if (chunk.length > 1 && ts.isReturnStatement(chunk[chunk.length - 1]!)) consider(chunk.slice(0, -1), depth);
      if (chunk.length > 1) consider(chunk.slice(1), depth);
      // Merge small neighbouring chunks into one phase.
      const next = chunks[i + 1];
      if (next && logicalLines(text, chunk[0]!.getStart(sf), chunk[chunk.length - 1]!.getEnd()) < opts.minSegmentLines * 2) {
        consider([...chunk, ...next], depth);
      }
    }
    // A list with no seams at all: try the whole list (nested blocks) and halves.
    if (chunks.length === 1 && list.length > 3) {
      if (depth > 0) consider([...list], depth);
      const mid = Math.floor(list.length / 2);
      consider(list.slice(0, mid), depth);
      consider(list.slice(mid), depth);
    }
  }

  // Prefer big, self-contained phases with narrow interfaces; then shallower ones.
  const score = (c: Candidate) =>
    c.lines - 3 * (c.analysis.params.length + c.analysis.returnsDeclared.length + c.analysis.returnsAssigned.length) -
    2 * c.depth + (c.heading ? 4 : 0);
  candidates.sort((a, b) => score(b) - score(a));
  return { candidates, rejected };
}
