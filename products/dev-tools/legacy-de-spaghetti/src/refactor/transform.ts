/** Text-level Extract Function: build the new function and the call site, preserving formatting. */

import ts from "typescript";

import { type FunctionLike, indentAt, indentUnit, isTsFile } from "../core/ast.ts";
import { type Candidate, isMethodLike } from "./candidates.ts";

export interface ExtractionPlan {
  name: string;
  /** One-line description for the doc comment. */
  summary?: string;
  /** Remove the heading comment at the call site (it moves into the doc comment). */
  consumeHeading: boolean;
  /** TS only: parameter types by name. */
  paramTypes?: Record<string, string | undefined>;
}

function anchorStatement(fn: FunctionLike): ts.Node {
  let node: ts.Node = fn;
  while (node.parent && !(ts.isSourceFile(node.parent) || ts.isBlock(node.parent) || ts.isModuleBlock(node.parent) ||
         ts.isCaseClause(node.parent) || ts.isDefaultClause(node.parent))) {
    node = node.parent;
  }
  return node;
}

function lineStart(text: string, pos: number): number {
  return text.lastIndexOf("\n", pos - 1) + 1;
}

function hasMultilineTemplate(statements: ts.Statement[], sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if ((ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.getText(sf).includes("\n")) found = true;
    ts.forEachChild(n, visit);
  };
  statements.forEach(visit);
  return found;
}

function reindent(code: string, from: string, to: string): string {
  return code
    .split("\n")
    .map((line, i) => {
      if (i === 0) return to + line;
      if (!line.trim()) return "";
      return to + (line.startsWith(from) ? line.slice(from.length) : line.replace(/^[ \t]+/, ""));
    })
    .join("\n");
}

export function applyExtraction(sf: ts.SourceFile, fn: FunctionLike, c: Candidate, plan: ExtractionPlan): string {
  const text = sf.getFullText();
  const unit = indentUnit(text);
  const a = c.analysis;
  const ts_ = isTsFile(sf.fileName);
  const method = isMethodLike(fn);
  const isStatic = method && Boolean(ts.getModifiers(fn as ts.MethodDeclaration)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword));

  const params = a.params.map((p) => (ts_ && plan.paramTypes?.[p] ? `${p}: ${plan.paramTypes[p]}` : p)).join(", ");
  const returned = [...a.returnsDeclared.map((r) => r.name), ...a.returnsAssigned];
  const returnStmt = returned.length === 0 ? "" : returned.length === 1 ? `return ${returned[0]};` : `return { ${returned.join(", ")} };`;

  // ---- new function text ----
  const segIndent = indentAt(text, c.start);
  const segText = text.slice(c.start, c.end);
  const keepAsIs = hasMultilineTemplate(c.statements, sf);
  const anchor = method ? fn : anchorStatement(fn);
  const outerIndent = indentAt(text, anchor.getStart(sf));
  const bodyIndent = outerIndent + unit;
  const body = keepAsIs ? `${bodyIndent}${segText}` : reindent(segText, segIndent, bodyIndent);
  const doc = plan.summary ? `${outerIndent}/** ${plan.summary.replace(/\*\//g, "* /")} */\n` : "";
  const asyncKw = a.usesAwait ? "async " : "";
  const header = method
    ? `${ts_ ? "private " : ""}${isStatic ? "static " : ""}${asyncKw}${plan.name}(${params})`
    : `${asyncKw}function ${plan.name}(${params})`;
  const fnText =
    `${doc}${outerIndent}${header} {\n${body}\n` + (returnStmt ? `${bodyIndent}${returnStmt}\n` : "") + `${outerIndent}}`;

  // ---- call site ----
  const callee = method ? `this.${plan.name}` : plan.name;
  const call = `${a.usesAwait ? "await " : ""}${callee}(${a.params.join(", ")})`;
  const lines: string[] = [];
  const decl = a.returnsDeclared;
  const asg = a.returnsAssigned;
  if (returned.length === 0) {
    lines.push(`${call};`);
  } else if (returned.length === 1) {
    lines.push(decl.length ? `${decl[0]!.kind} ${decl[0]!.name} = ${call};` : `${asg[0]} = ${call};`);
  } else if (asg.length === 0 && new Set(decl.map((d) => d.kind)).size === 1) {
    lines.push(`${decl[0]!.kind} { ${decl.map((d) => d.name).join(", ")} } = ${call};`);
  } else if (decl.length === 0) {
    lines.push(`({ ${asg.join(", ")} } = ${call});`);
  } else {
    const tmp = `${plan.name}Result`;
    lines.push(`const ${tmp} = ${call};`);
    for (const d of decl) lines.push(`${d.kind} ${d.name} = ${tmp}.${d.name};`);
    for (const n of asg) lines.push(`${n} = ${tmp}.${n};`);
  }
  const callText = lines.join(`\n${segIndent}`);

  // ---- apply edits from the end of the file backwards ----
  const replaceFrom = plan.consumeHeading && c.headingRange ? c.headingRange.pos : c.start;
  let out = text;
  const edits: { pos: number; end: number; text: string }[] = [];
  if (method) {
    edits.push({ pos: fn.getEnd(), end: fn.getEnd(), text: `\n\n${fnText}` });
  } else {
    const leading = ts.getLeadingCommentRanges(text, anchor.getFullStart());
    const at = lineStart(text, leading?.length ? leading[0]!.pos : anchor.getStart(sf));
    edits.push({ pos: at, end: at, text: `${fnText.replace(/^[ \t]+/, (m) => m)}\n\n` });
  }
  edits.push({ pos: replaceFrom, end: c.end, text: callText });
  edits.sort((x, y) => y.pos - x.pos);
  for (const e of edits) out = out.slice(0, e.pos) + e.text + out.slice(e.end);
  return out;
}
