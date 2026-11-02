/**
 * Scope & data-flow analysis for Extract Function.
 *
 * Given a function F and a contiguous run of statements S inside it, decide whether S can
 * be moved into a new function, and if so which variables become parameters (read from F's
 * locals) and which must be returned (declared in S and used later, or F's locals that S
 * reassigns and F reads elsewhere). The rules are deliberately conservative: anything we
 * can't prove safe (shadowed names, closures that observe reassigned variables, hoisting,
 * early returns, break/continue that leave S, `arguments`, `eval`…) rejects the candidate.
 * Behavioural verification then double-checks every accepted extraction.
 */

import ts from "typescript";

import { type FunctionLike, isFunctionLike } from "../core/ast.ts";

export type BindingKind = "var" | "let" | "const" | "param" | "function" | "class" | "catch";

export interface Binding {
  name: string;
  kind: BindingKind;
  pos: number;
}

export interface SegmentAnalysis {
  ok: boolean;
  reason?: string;
  params: string[];
  /** Declared in the segment and needed after it. */
  returnsDeclared: { name: string; kind: "var" | "let" | "const" }[];
  /** F's locals reassigned in the segment and needed elsewhere. */
  returnsAssigned: string[];
  usesAwait: boolean;
  usesThis: boolean;
}

// ---------------------------------------------------------------------------------------------
// Identifier classification
// ---------------------------------------------------------------------------------------------

function isInTypePosition(n: ts.Node): boolean {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isTypeNode(p) && !ts.isExpressionWithTypeArguments(p)) return !ts.isTypeQueryNode(p);
    if (ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p)) return true;
    if (ts.isStatement(p) || ts.isExpression(p)) {
      if (ts.isExpression(p) && !ts.isTypeNode(p)) return false;
    }
  }
  return false;
}

/** Is this identifier a *use* of a variable (not a property name, label, declaration name or type)? */
export function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isQualifiedName(p) && p.right === id) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) ||
       ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isPropertySignature(p) ||
       ts.isMethodSignature(p) || ts.isEnumMember(p)) && p.name === id) return false;
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isFunctionDeclaration(p) ||
       ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p) ||
       ts.isTypeParameterDeclaration(p)) && p.name === id) return false;
  if ((ts.isLabeledStatement(p) || ts.isBreakStatement(p) || ts.isContinueStatement(p)) && p.label === id) return false;
  if (ts.isMetaProperty(p)) return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p)) return false;
  if (ts.isJsxAttribute(p)) return false;
  if ((ts.isJsxOpeningElement(p) || ts.isJsxClosingElement(p) || ts.isJsxSelfClosingElement(p)) && p.tagName === id) {
    return /^[A-Z]/.test(id.text);
  }
  if (isInTypePosition(id)) return false;
  return true;
}

const ASSIGNMENT_OPS = new Set([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.AsteriskAsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Is this reference the target of an assignment / update / destructuring assignment? */
export function isWrite(id: ts.Identifier): boolean {
  let n: ts.Node = id;
  let p = n.parent;
  // Climb out of destructuring-assignment patterns: [a, b] = …, ({ a, b: c } = …)
  while (p && (ts.isShorthandPropertyAssignment(p) || ts.isPropertyAssignment(p) || ts.isSpreadElement(p) ||
         ts.isSpreadAssignment(p) || ts.isArrayLiteralExpression(p) || ts.isObjectLiteralExpression(p) ||
         ts.isParenthesizedExpression(p))) {
    if (ts.isPropertyAssignment(p) && p.name === n) return false;
    n = p;
    p = p.parent;
  }
  if (!p) return false;
  if (ts.isBinaryExpression(p) && ASSIGNMENT_OPS.has(p.operatorToken.kind) && p.left === n) return true;
  if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
      (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken) && n === id) return true;
  if ((ts.isForInStatement(p) || ts.isForOfStatement(p)) && p.initializer === n) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------------------------

function bindingNames(name: ts.BindingName, out: string[] = []): string[] {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
  return out;
}

function declKind(list: ts.VariableDeclarationList): "var" | "let" | "const" {
  if (list.flags & ts.NodeFlags.Const) return "const";
  if (list.flags & ts.NodeFlags.Let) return "let";
  return "var";
}

/** Every binding declared in F's own scope tree (params, var/let/const anywhere, inner function & class names), excluding nested functions' internals. */
export function functionBindings(fn: FunctionLike): Binding[] {
  const out: Binding[] = [];
  for (const p of fn.parameters) for (const n of bindingNames(p.name)) out.push({ name: n, kind: "param", pos: p.getStart() });
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isVariableDeclarationList(n.parent)) {
      for (const name of bindingNames(n.name)) out.push({ name, kind: declKind(n.parent), pos: n.getStart() });
    } else if (ts.isFunctionDeclaration(n) && n.name) {
      out.push({ name: n.name.text, kind: "function", pos: n.getStart() });
      return;
    } else if (ts.isClassDeclaration(n) && n.name) {
      out.push({ name: n.name.text, kind: "class", pos: n.getStart() });
      return;
    } else if (ts.isCatchClause(n) && n.variableDeclaration) {
      for (const name of bindingNames(n.variableDeclaration.name)) out.push({ name, kind: "catch", pos: n.getStart() });
      visit(n.block);
      return;
    }
    if (isFunctionLike(n) || ts.isClassLike(n)) return;
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return out;
}

/** Does F contain constructs that defeat static analysis? */
export function unanalyzable(fn: FunctionLike): string | undefined {
  let reason: string | undefined;
  const visit = (n: ts.Node) => {
    if (reason) return;
    if (ts.isWithStatement(n)) reason = "uses `with`";
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "eval") reason = "uses eval()";
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return reason;
}

// ---------------------------------------------------------------------------------------------
// Scope-aware walk over a set of nodes
// ---------------------------------------------------------------------------------------------

interface Usage {
  reads: Set<string>;
  writes: Set<string>;
  /** First position each name is referenced. */
  firstPos: Map<string, number>;
}

/**
 * Collect free variable reads/writes of `roots`, i.e. references that don't resolve to a
 * declaration *inside* the roots' own nested scopes. Names in `baseScope` are treated as
 * declared at the roots' level (so they're also "inner").
 */
function freeUsage(roots: readonly ts.Node[], baseScope: Set<string>): Usage {
  const usage: Usage = { reads: new Set(), writes: new Set(), firstPos: new Map() };
  const stack: Set<string>[] = [baseScope];
  const declared = (name: string) => stack.some((s) => s.has(name));

  const blockScope = (statements: readonly ts.Statement[]): Set<string> => {
    const s = new Set<string>();
    for (const st of statements) {
      if (ts.isVariableStatement(st) && declKind(st.declarationList) !== "var") {
        for (const d of st.declarationList.declarations) bindingNames(d.name).forEach((n) => s.add(n));
      }
      if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) s.add(st.name.text);
    }
    return s;
  };
  const functionScope = (fn: FunctionLike | ts.ClassLikeDeclaration): Set<string> => {
    const s = new Set<string>();
    if (ts.isClassLike(fn)) {
      if (fn.name) s.add(fn.name.text);
      return s;
    }
    if ((ts.isFunctionExpression(fn)) && fn.name) s.add(fn.name.text);
    for (const p of fn.parameters) bindingNames(p.name).forEach((n) => s.add(n));
    for (const b of functionBindings(fn)) s.add(b.name);
    s.add("arguments");
    return s;
  };

  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n)) {
      if (isReference(n) && !declared(n.text)) {
        if (!usage.firstPos.has(n.text)) usage.firstPos.set(n.text, n.getStart());
        if (isWrite(n)) {
          usage.writes.add(n.text);
          // Compound assignments and updates also read.
          const p = n.parent;
          if (!(ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken)) usage.reads.add(n.text);
        } else {
          usage.reads.add(n.text);
        }
      }
      return;
    }
    let pushed = false;
    if (isFunctionLike(n) || ts.isClassLike(n)) {
      stack.push(functionScope(n as FunctionLike));
      pushed = true;
    } else if (ts.isBlock(n) || ts.isCaseBlock(n)) {
      const stmts = ts.isBlock(n) ? n.statements : n.clauses.flatMap((c) => [...c.statements]);
      stack.push(blockScope(stmts));
      pushed = true;
    } else if ((ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n)) && n.initializer &&
               ts.isVariableDeclarationList(n.initializer) && declKind(n.initializer) !== "var") {
      const s = new Set<string>();
      n.initializer.declarations.forEach((d) => bindingNames(d.name).forEach((x) => s.add(x)));
      stack.push(s);
      pushed = true;
    } else if (ts.isCatchClause(n) && n.variableDeclaration) {
      stack.push(new Set(bindingNames(n.variableDeclaration.name)));
      pushed = true;
    }
    ts.forEachChild(n, visit);
    if (pushed) stack.pop();
  };
  roots.forEach(visit);
  return usage;
}

/** Names declared directly by a run of statements (let/const/class/function at its level + `var` anywhere inside, not in nested functions). */
function segmentDeclarations(statements: readonly ts.Statement[]): Map<string, BindingKind> {
  const out = new Map<string, BindingKind>();
  for (const st of statements) {
    if (ts.isVariableStatement(st)) {
      const k = declKind(st.declarationList);
      for (const d of st.declarationList.declarations) bindingNames(d.name).forEach((n) => out.set(n, k));
    }
    if (ts.isFunctionDeclaration(st) && st.name) out.set(st.name.text, "function");
    if (ts.isClassDeclaration(st) && st.name) out.set(st.name.text, "class");
  }
  const visitVar = (n: ts.Node) => {
    if (isFunctionLike(n) || ts.isClassLike(n)) return;
    if (ts.isVariableDeclarationList(n) && declKind(n) === "var") {
      n.declarations.forEach((d) => bindingNames(d.name).forEach((x) => out.set(x, "var")));
    }
    ts.forEachChild(n, visitVar);
  };
  statements.forEach((st) => ts.forEachChild(st, visitVar));
  return out;
}

/** Control-flow constructs that can't move into another function. */
function escapingControlFlow(statements: readonly ts.Statement[], fnIsMethod: boolean): string | undefined {
  let reason: string | undefined;
  const labels = new Set<string>();
  const visit = (n: ts.Node, loopDepth: number, switchDepth: number, inArrowOnly: boolean, inRegularFn: boolean) => {
    if (reason) return;
    if (ts.isReturnStatement(n) && !inRegularFn && !inArrowOnly) reason = "contains `return`";
    else if (ts.isYieldExpression(n) && !inRegularFn) reason = "contains `yield`";
    else if (ts.isIdentifier(n) && n.text === "arguments" && isReference(n) && !inRegularFn) reason = "uses `arguments`";
    else if (n.kind === ts.SyntaxKind.SuperKeyword && !inRegularFn) reason = "uses `super`";
    else if (ts.isMetaProperty(n) && !inRegularFn) reason = "uses `new.target`";
    else if (n.kind === ts.SyntaxKind.ThisKeyword && !inRegularFn && !fnIsMethod) reason = "uses `this` outside a class method";
    else if ((ts.isBreakStatement(n) || ts.isContinueStatement(n)) && !inRegularFn && !inArrowOnly) {
      if (n.label) {
        if (!labels.has(n.label.text)) reason = `\`${ts.isBreakStatement(n) ? "break" : "continue"} ${n.label.text}\` leaves the block`;
      } else if (ts.isBreakStatement(n) ? loopDepth + switchDepth === 0 : loopDepth === 0) {
        reason = `\`${ts.isBreakStatement(n) ? "break" : "continue"}\` leaves the block`;
      }
    }
    if (reason) return;
    if (ts.isLabeledStatement(n)) labels.add(n.label.text);
    const isLoop = ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n);
    const regular = ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n) ||
      ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isClassLike(n);
    const arrow = ts.isArrowFunction(n);
    ts.forEachChild(n, (c) =>
      visit(c, isLoop ? loopDepth + 1 : arrow ? 0 : loopDepth, ts.isSwitchStatement(n) ? switchDepth + 1 : arrow ? 0 : switchDepth,
        inArrowOnly || arrow, inRegularFn || regular),
    );
  };
  statements.forEach((st) => visit(st, 0, 0, false, false));
  return reason;
}

function containsAwait(statements: readonly ts.Statement[]): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found || isFunctionLike(n)) return;
    if (ts.isAwaitExpression(n) || (ts.isForOfStatement(n) && n.awaitModifier)) found = true;
    ts.forEachChild(n, visit);
  };
  statements.forEach((s) => visit(s));
  return found;
}

function containsThis(statements: readonly ts.Statement[]): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (n.kind === ts.SyntaxKind.ThisKeyword) found = true;
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isClassLike(n)) return;
    ts.forEachChild(n, visit);
  };
  statements.forEach((s) => visit(s));
  return found;
}

/** Free-variable usage inside nested functions of F that lie outside the segment (closures). */
function closureUsage(fn: FunctionLike, segStart: number, segEnd: number): Usage {
  const roots: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    if (n.getStart() >= segStart && n.getEnd() <= segEnd) return;
    if (isFunctionLike(n) && n !== fn) {
      roots.push(n);
      return;
    }
    ts.forEachChild(n, visit);
  };
  if (fn.body) ts.forEachChild(fn.body, visit);
  return freeUsage(roots, new Set());
}

// ---------------------------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------------------------

export function analyzeSegment(fn: FunctionLike, statements: readonly ts.Statement[], fnIsMethod: boolean): SegmentAnalysis {
  const fail = (reason: string): SegmentAnalysis => ({
    ok: false, reason, params: [], returnsDeclared: [], returnsAssigned: [], usesAwait: false, usesThis: false,
  });
  const first = statements[0];
  const last = statements[statements.length - 1];
  if (!first || !last || !fn.body) return fail("empty segment");
  const segStart = first.getStart();
  const segEnd = last.getEnd();

  const cf = escapingControlFlow(statements, fnIsMethod);
  if (cf) return fail(cf);

  const usesAwait = containsAwait(statements);
  if (usesAwait && !fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return fail("uses await outside async");
  const usesThis = containsThis(statements);

  const bindings = functionBindings(fn);
  const bindingCount = new Map<string, number>();
  for (const b of bindings) bindingCount.set(b.name, (bindingCount.get(b.name) ?? 0) + 1);
  const fnLocals = new Map(bindings.map((b) => [b.name, b]));

  const segDecl = segmentDeclarations(statements);
  for (const name of segDecl.keys()) {
    if ((bindingCount.get(name) ?? 0) > 1) return fail(`\`${name}\` is declared more than once in the function`);
  }

  const inside = freeUsage(statements, new Set(segDecl.keys()));
  // Usage of every name in F outside the segment (not scope-precise → conservative).
  const outsideRefs = new Map<string, number[]>();
  const collectOutside = (n: ts.Node) => {
    if (n.getStart() >= segStart && n.getEnd() <= segEnd && n.pos >= first.pos) return;
    if (ts.isIdentifier(n) && isReference(n)) {
      const arr = outsideRefs.get(n.text) ?? [];
      arr.push(n.getStart());
      outsideRefs.set(n.text, arr);
    }
    ts.forEachChild(n, collectOutside);
  };
  for (const p of fn.parameters) ts.forEachChild(p, collectOutside);
  ts.forEachChild(fn.body, collectOutside);

  const touched = new Set([...inside.reads, ...inside.writes]);
  const params: string[] = [];
  const returnsAssigned: string[] = [];
  for (const name of touched) {
    const b = fnLocals.get(name);
    if (!b) continue; // module-level or global: still visible from the sibling function
    if ((bindingCount.get(name) ?? 0) > 1) return fail(`\`${name}\` is declared more than once in the function`);
    if (b.kind === "function" && inside.writes.has(name)) return fail(`reassigns function \`${name}\``);
    if (inside.reads.has(name) || inside.writes.has(name)) params.push(name);
    if (inside.writes.has(name) && (outsideRefs.get(name)?.length ?? 0) > 0) returnsAssigned.push(name);
  }

  const returnsDeclared: SegmentAnalysis["returnsDeclared"] = [];
  for (const [name, kind] of segDecl) {
    const uses = outsideRefs.get(name) ?? [];
    if (uses.some((pos) => pos < segStart)) return fail(`\`${name}\` is used before it is declared (hoisting)`);
    if (uses.length > 0) returnsDeclared.push({ name, kind: kind === "var" || kind === "let" ? kind : "const" });
  }

  // Closures elsewhere in F that capture variables the segment reassigns, or that reassign
  // variables the segment uses, would observe a stale copy after extraction.
  const closures = closureUsage(fn, segStart, segEnd);
  for (const name of inside.writes) {
    if (fnLocals.has(name) && (closures.reads.has(name) || closures.writes.has(name))) {
      return fail(`\`${name}\` is reassigned here but captured by a closure elsewhere`);
    }
  }
  for (const name of touched) {
    if (fnLocals.has(name) && closures.writes.has(name)) return fail(`\`${name}\` is reassigned by a closure elsewhere`);
  }

  // Keep a stable, readable order: order of first use.
  params.sort((a, b) => (inside.firstPos.get(a) ?? 0) - (inside.firstPos.get(b) ?? 0));
  return { ok: true, params, returnsDeclared, returnsAssigned, usesAwait, usesThis };
}
