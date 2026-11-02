/**
 * Optional AI naming (Pro). The AST engine decides *what* to extract and the safety net
 * proves behaviour is unchanged; Claude only proposes a name and a one-line summary for
 * each extracted function. Any failure falls back to the heuristic name, so the refactor
 * never depends on the network.
 */

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

import { UserError } from "@products/shared";

import type { Namer } from "../refactor/engine.ts";

const NameSchema = z.object({
  name: z.string().describe("camelCase JavaScript identifier, verb first, 2-4 words"),
  summary: z.string().describe("one sentence, under 90 characters, describing what the code does"),
});

const SYSTEM = `You name functions extracted from legacy JavaScript/TypeScript during refactoring.
Given a block of code that is being moved out of a larger function, return:
- name: a precise camelCase identifier, verb first (e.g. applyCustomerDiscounts, computeShippingCost), 2-4 words, no abbreviations the code doesn't already use.
- summary: one plain sentence describing what the block does, for a doc comment.
Describe what the code actually does, not what a comment above it claims. Never reuse an identifier from the "already taken" list.`;

export interface AiNamerOptions {
  model: string;
  effort: "low" | "medium" | "high";
  onWarning?: (msg: string) => void;
  /** For tests / custom endpoints. */
  client?: Anthropic;
}

export function createAiNamer(opts: AiNamerOptions): Namer {
  if (!opts.client && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new UserError("--ai needs an Anthropic API key.", "Set ANTHROPIC_API_KEY (get one at https://console.anthropic.com/), or drop --ai to use built-in naming.");
  }
  const client = opts.client ?? new Anthropic({ maxRetries: 2, timeout: 60_000 });
  let warned = false;
  const warn = (m: string) => {
    if (!warned) opts.onWarning?.(m);
    warned = true;
  };

  return async ({ functionName, code, params, returns, heading, taken }) => {
    const nearby = [...taken].filter((n) => n.length > 3).slice(0, 200).join(", ");
    try {
      const response = await client.beta.messages.parse({
        model: opts.model,
        max_tokens: 2048,
        // Route policy refusals to a fallback model automatically instead of failing the call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: opts.effort, format: betaZodOutputFormat(NameSchema) },
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content:
              `Extracted from function \`${functionName}\`.\n` +
              `Parameters: ${params.join(", ") || "(none)"}\nReturns: ${returns.join(", ") || "(nothing)"}\n` +
              (heading ? `Section comment above the block: "${heading}"\n` : "") +
              `Already taken identifiers: ${nearby}\n\n<code>\n${code}\n</code>`,
          },
        ],
      });
      if (response.stop_reason === "refusal" || !response.parsed_output) return undefined;
      const { name, summary } = response.parsed_output;
      if (!/^[a-z][A-Za-z0-9]*$/.test(name) || taken.has(name)) return undefined;
      return { name, summary };
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        throw new UserError("Anthropic rejected the API key.", "Check ANTHROPIC_API_KEY, or drop --ai.");
      }
      if (err instanceof Anthropic.RateLimitError) warn("Claude rate limit hit; using built-in names for the rest.");
      else if (err instanceof Anthropic.APIError) warn(`Claude API error (${err.status}); using built-in names.`);
      else warn("Couldn't reach the Claude API; using built-in names.");
      return undefined;
    }
  };
}
