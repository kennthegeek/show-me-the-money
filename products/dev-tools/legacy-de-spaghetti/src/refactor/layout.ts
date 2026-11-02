/**
 * After extraction, lay helpers out in "stepdown" order: the original function first, then
 * its helpers in the order it calls them, so the file reads top-down like a table of contents.
 * Function declarations are hoisted, so moving them below their caller is always safe.
 */

import ts from "typescript";

import { findFunction, type FunctionLike, parse } from "../core/ast.ts";

function memberOrStatement(fn: FunctionLike): ts.Node {
  let node: ts.Node = fn;
  while (node.parent && !(ts.isSourceFile(node.parent) || ts.isBlock(node.parent) || ts.isModuleBlock(node.parent) ||
         ts.isClassLike(node.parent))) {
    node = node.parent;
  }
  return node;
}

function fullRange(text: string, node: ts.Node, sf: ts.SourceFile): { pos: number; end: number } {
  const leading = ts.getLeadingCommentRanges(text, node.getFullStart());
  const start = leading?.length ? leading[0]!.pos : node.getStart(sf);
  return { pos: text.lastIndexOf("\n", start - 1) + 1, end: node.getEnd() };
}

export function stepdown(file: string, text: string, mainName: string, helpers: string[]): string {
  if (helpers.length === 0) return text;
  const sf = parse(file, text);
  const main = findFunction(sf, mainName);
  if (!main) return text;
  const mainNode = memberOrStatement(main);

  const blocks: { name: string; node: ts.Node; range: { pos: number; end: number } }[] = [];
  for (const name of helpers) {
    const fn = findFunction(sf, name);
    if (!fn) return text;
    const node = memberOrStatement(fn);
    if (node.parent !== mainNode.parent) return text; // different scopes: leave as-is
    blocks.push({ name, node, range: fullRange(text, node, sf) });
  }

  // Order of first call inside the main function.
  const body = main.getText(sf);
  const callPos = (n: string) => {
    const m = new RegExp(`(?:this\\.)?\\b${n}\\s*\\(`).exec(body);
    return m ? m.index : Number.MAX_SAFE_INTEGER;
  };
  const ordered = [...blocks].sort((a, b) => callPos(a.name) - callPos(b.name));

  // Remove helper blocks (from the end), then insert them after the main function.
  let out = text;
  for (const b of [...blocks].sort((x, y) => y.range.pos - x.range.pos)) {
    let end = b.range.end;
    while (out[end] === "\n" || out[end] === "\r") end++;
    out = out.slice(0, b.range.pos) + out.slice(end);
  }
  const sf2 = parse(file, out);
  const main2 = findFunction(sf2, mainName);
  if (!main2) return text;
  const insertAt = memberOrStatement(main2).getEnd();
  const chunk = ordered.map((b) => text.slice(b.range.pos, b.range.end)).join("\n\n");
  out = `${out.slice(0, insertAt)}\n\n${chunk}${out.slice(insertAt)}`;
  return out;
}
