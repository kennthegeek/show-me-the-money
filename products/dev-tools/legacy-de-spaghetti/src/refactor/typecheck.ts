/**
 * TypeScript support for refactoring .ts files: real parameter types for extracted functions,
 * and a "no new type errors" gate. Uses the project's tsconfig when there is one.
 */

import { dirname } from "node:path";

import ts from "typescript";

import { type FunctionLike, findFunction } from "../core/ast.ts";
import type { Candidate } from "./candidates.ts";

function compilerOptions(file: string): ts.CompilerOptions {
  const configPath = ts.findConfigFile(dirname(file), ts.sys.fileExists);
  const fallback: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    skipLibCheck: true,
    strict: false,
    noEmit: true,
    allowImportingTsExtensions: true,
  };
  if (!configPath) return fallback;
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return fallback;
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath));
  return { ...parsed.options, noEmit: true, skipLibCheck: true };
}

export class TypeChecker {
  private program: ts.Program | undefined;
  private readonly options: ts.CompilerOptions;
  /** lib.d.ts and dependencies never change between candidates: parse them once. */
  private readonly cache = new Map<string, ts.SourceFile | undefined>();
  constructor(private readonly file: string) {
    this.options = compilerOptions(file);
  }

  private build(text: string): ts.Program {
    const host = ts.createCompilerHost(this.options, true);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, lang, onError, create) => {
      if (name === this.file) return ts.createSourceFile(name, text, lang, true);
      if (!this.cache.has(name)) this.cache.set(name, getSourceFile(name, lang, onError, create));
      return this.cache.get(name);
    };
    const readFile = host.readFile.bind(host);
    host.readFile = (name) => (name === this.file ? text : readFile(name));
    this.program = ts.createProgram({ rootNames: [this.file], options: this.options, host, ...(this.program ? { oldProgram: this.program } : {}) });
    return this.program;
  }

  errorCount(text: string): number {
    const program = this.build(text);
    const sf = program.getSourceFile(this.file);
    if (!sf) return 0;
    return program.getSemanticDiagnostics(sf).length + program.getSyntacticDiagnostics(sf).length;
  }

  /** Printable declared types for the candidate's parameters (falls back to `any`). */
  paramTypes(text: string, fnName: string, c: Candidate): Record<string, string> {
    const program = this.build(text);
    const checker = program.getTypeChecker();
    const sf = program.getSourceFile(this.file);
    const out: Record<string, string> = {};
    if (!sf) return out;
    const fn = findFunction(sf, fnName);
    if (!fn) return out;
    const decls = declarationsByName(fn);
    for (const name of c.analysis.params) {
      const node = decls.get(name);
      let printed = "any";
      if (node) {
        const type = checker.getTypeAtLocation(node);
        const s = checker.typeToString(type, fn, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);
        printed = s.includes("import(") || s.length > 200 ? "any" : s;
      }
      out[name] = printed;
    }
    return out;
  }
}

function declarationsByName(fn: FunctionLike): Map<string, ts.Node> {
  const map = new Map<string, ts.Node>();
  const add = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) {
      if (!map.has(name.text)) map.set(name.text, name);
    } else {
      for (const el of name.elements) if (!ts.isOmittedExpression(el)) add(el.name);
    }
  };
  fn.parameters.forEach((p) => add(p.name));
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n)) add(n.name);
    if (ts.isCatchClause(n) && n.variableDeclaration) add(n.variableDeclaration.name);
    if (n !== fn && (ts.isFunctionLike(n) || ts.isClassLike(n)) && !ts.isArrowFunction(n)) {
      if (ts.isFunctionDeclaration(n) && n.name && !map.has(n.name.text)) map.set(n.name.text, n.name);
      return;
    }
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return map;
}
