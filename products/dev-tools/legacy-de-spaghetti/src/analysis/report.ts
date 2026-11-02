import chalk from "chalk";

import type { Thresholds } from "../config.ts";
import type { Hotspot, ScanResult } from "./scan.ts";

const GRADE_COLOR = { A: chalk.green, B: chalk.greenBright, C: chalk.yellow, D: chalk.hex("#ff8800"), F: chalk.red };

function pad(s: string, n: number, right = false): string {
  // eslint-disable-next-line no-control-regex
  const visible = s.replace(/\u001b\[[0-9;]*m/g, "").length;
  const fill = " ".repeat(Math.max(0, n - visible));
  return right ? fill + s : s + fill;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `…${s.slice(s.length - n + 1)}`;
}

export function renderTable(result: ScanResult, top: number): string {
  const rows = result.functions.slice(0, top);
  const lines: string[] = [];
  const t = result.totals;
  lines.push(
    chalk.bold(`Scanned ${t.files} files, ${t.functions} functions, ${t.lines.toLocaleString()} lines`) +
      chalk.dim(result.churnAvailable ? " · ranked by spaghetti score × git churn" : " · ranked by spaghetti score"),
  );
  if (t.parseErrors) lines.push(chalk.yellow(`  ${t.parseErrors} file(s) could not be parsed`));
  lines.push("");
  if (rows.length === 0) {
    lines.push(chalk.green("No functions found."));
    return lines.join("\n");
  }
  const header = [
    pad("Grade", 6),
    pad("Score", 6, true),
    pad("Lines", 6, true),
    pad("Cmplx", 6, true),
    pad("Depth", 6, true),
    ...(result.churnAvailable ? [pad("Churn", 6, true)] : []),
    "  Function",
  ].join(" ");
  lines.push(chalk.dim(header));
  for (const f of rows) {
    const g = GRADE_COLOR[f.grade];
    lines.push(
      [
        pad(g.bold(` ${f.grade}`), 6),
        pad(g(String(f.score)), 6, true),
        pad(String(f.lines), 6, true),
        pad(String(f.complexity), 6, true),
        pad(String(f.maxDepth), 6, true),
        ...(result.churnAvailable ? [pad(String(f.churn), 6, true)] : []),
        `  ${chalk.bold(f.name)} ${chalk.dim(`${truncate(f.relFile, 50)}:${f.startLine}`)}`,
      ].join(" "),
    );
  }
  lines.push("");
  if (t.offenders) {
    lines.push(
      `${chalk.red.bold(String(t.offenders))} function(s) over threshold · ` +
        `${chalk.bold(t.debtLines.toLocaleString())} lines of excess "spaghetti debt"`,
    );
    const worst = result.functions[0]!;
    lines.push(chalk.dim(`Next: despaghetti plan ${worst.relFile} --function ${worst.name}`));
  } else {
    lines.push(chalk.green("✔ Every function is within thresholds."));
  }
  return lines.join("\n");
}

export function renderMarkdown(result: ScanResult, t: Thresholds, top: number): string {
  const tot = result.totals;
  const rows = result.functions.slice(0, top);
  const out = [
    "# Legacy-De-Spaghetti report",
    "",
    `- **Files:** ${tot.files} · **Functions:** ${tot.functions} · **Lines:** ${tot.lines}`,
    `- **Over threshold:** ${tot.offenders} · **Excess lines:** ${tot.debtLines}`,
    `- **Thresholds:** ${t.maxLines} lines, complexity ${t.maxComplexity}, nesting ${t.maxDepth}, ${t.maxParams} params`,
    "",
    `| Grade | Score | Lines | Complexity | Depth | ${result.churnAvailable ? "Churn | " : ""}Function | Location | Issues |`,
    `|:-:|--:|--:|--:|--:|${result.churnAvailable ? "--:|" : ""}---|---|---|`,
    ...rows.map(
      (f) =>
        `| ${f.grade} | ${f.score} | ${f.lines} | ${f.complexity} | ${f.maxDepth} | ${result.churnAvailable ? `${f.churn} | ` : ""}` +
        `\`${f.name}\` | \`${f.relFile}:${f.startLine}\` | ${f.violations.join("; ") || "-"} |`,
    ),
    "",
  ];
  return out.join("\n");
}

/** SARIF 2.1.0 for GitHub code scanning and other CI dashboards. */
export function renderSarif(result: ScanResult, version: string): object {
  const offenders = result.functions.filter((f: Hotspot) => f.violations.length);
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "legacy-de-spaghetti",
            version,
            informationUri: "https://gumroad.com/l/legacy-de-spaghetti",
            rules: [
              {
                id: "DSP001",
                name: "SpaghettiFunction",
                shortDescription: { text: "Function exceeds size/complexity thresholds" },
                help: { text: "Run `despaghetti plan <file> --function <name>` to see safe extraction candidates." },
              },
            ],
          },
        },
        results: offenders.map((f) => ({
          ruleId: "DSP001",
          level: f.grade === "F" ? "error" : "warning",
          message: { text: `${f.name}: ${f.violations.join(", ")} (spaghetti score ${f.score})` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.relFile },
                region: { startLine: f.startLine, endLine: f.endLine },
              },
            },
          ],
        })),
      },
    ],
  };
}
