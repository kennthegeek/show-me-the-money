/** Name extracted functions from what the code says about itself. */

import { isValidIdentifier } from "../core/ast.ts";
import type { Candidate } from "./candidates.ts";

const VERBS = new Set(
  ("validate check verify sum apply compute calculate build create make parse load save send format render update " +
    "init initialize prepare process handle normalize collect filter sort merge convert fetch get set add remove clean " +
    "reset log emit notify map group resolve ensure assert compose generate extract read write find count total " +
    "accumulate tally adjust append attach clamp copy decode encode derive determine enrich evaluate expand flatten " +
    "guard hydrate index insert lookup mark match measure migrate parse persist populate print publish queue record " +
    "refresh register reject release rename replace report request restore retry round run sanitize schedule select " +
    "serialize split store strip summarize sync tag throttle transform translate trim validate wrap put place move " +
    "ship assign allocate distribute reserve dispatch route post charge bill refund close open lock unlock")
    .split(" "),
);
const STOP = new Set(["the", "a", "an", "of", "for", "to", "and", "with", "into", "from", "on", "in", "all", "any", "some", "our", "its", "this", "that", "then", "now", "here", "step", "phase", "section", "part"]);

function words(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^\s*(\d+[.)]|step\s*\d+[:.]?|todo:?|note:?|fixme:?)\s*/i, "")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w && !/^\d+$/.test(w));
}

export function camel(parts: string[]): string {
  return parts.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join("");
}

function fromHeading(heading: string): string | undefined {
  const ws = words(heading).filter((w) => !STOP.has(w)).slice(0, 4);
  if (ws.length === 0 || heading.length > 80) return undefined;
  if (!VERBS.has(ws[0]!)) ws.unshift(ws.length === 1 ? "compute" : "handle");
  return camel(ws);
}

export function heuristicName(c: Candidate, functionName: string, taken: Set<string>): string {
  const base = functionName.split(".").pop()!.replace(/[^A-Za-z0-9_$]/g, "") || "extracted";
  const returned = [...c.analysis.returnsDeclared.map((r) => r.name), ...c.analysis.returnsAssigned];
  const options = [
    c.heading ? fromHeading(c.heading) : undefined,
    returned.length === 1 ? camel(["compute", ...words(returned[0]!)]) : undefined,
    returned.length === 2 ? camel(["compute", ...words(returned[0]!), "and", ...words(returned[1]!)]) : undefined,
    camel([...words(base), "step"]),
  ].filter((x): x is string => Boolean(x && isValidIdentifier(x)));
  return unique(options[0] ?? "extractedStep", taken);
}

export function unique(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name}${i}`)) return `${name}${i}`;
}
