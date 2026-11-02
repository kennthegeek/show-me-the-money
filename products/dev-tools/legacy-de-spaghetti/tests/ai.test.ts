import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { createAiNamer } from "../src/ai/namer.ts";

function fakeClient(reply: (body: Record<string, unknown>) => { status: number; json: unknown }) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const client = new Anthropic({
    apiKey: "test-key",
    maxRetries: 0,
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(url), headers: new Headers(init?.headers), body });
      const r = reply(body);
      return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
    },
  });
  return { client, requests };
}

const message = (text: string, stop = "end_turn") => ({
  id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5",
  content: [{ type: "text", text }], stop_reason: stop, stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});

const input = {
  functionName: "processOrder", code: "var discount = 0; if (vip) discount = 5;", params: ["vip"],
  returns: ["discount"], heading: "discounts", taken: new Set(["processOrder", "computeDiscount"]),
};

describe("AI namer", () => {
  it("asks Claude for a structured name and summary", async () => {
    const { client, requests } = fakeClient(() => ({ status: 200, json: message('{"name":"applyVipDiscount","summary":"Applies the VIP discount."}') }));
    const namer = createAiNamer({ model: "claude-opus-5-5", effort: "low", client });
    expect(await namer(input)).toEqual({ name: "applyVipDiscount", summary: "Applies the VIP discount." });

    const req = requests[0]!;
    expect(req.url).toContain("/v1/messages");
    expect(req.body.model).toBe("claude-opus-5-5");
    expect(req.body.fallbacks).toBe("default");
    expect(req.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    const oc = req.body.output_config as { effort: string; format: { type: string; schema: { properties: object } } };
    expect(oc.effort).toBe("low");
    expect(oc.format.type).toBe("json_schema");
    expect(Object.keys(oc.format.schema.properties).sort()).toEqual(["name", "summary"]);
    expect(JSON.stringify(req.body.messages)).toContain("computeDiscount"); // taken names are passed
  });

  it("rejects unusable names and falls back silently", async () => {
    for (const bad of ['{"name":"computeDiscount","summary":"x"}', '{"name":"has spaces","summary":"x"}']) {
      const { client } = fakeClient(() => ({ status: 200, json: message(bad) }));
      expect(await createAiNamer({ model: "m", effort: "low", client })(input)).toBeUndefined();
    }
    const { client } = fakeClient(() => ({ status: 200, json: message("", "refusal") }));
    expect(await createAiNamer({ model: "m", effort: "low", client })(input)).toBeUndefined();
  });

  it("warns once on API errors and keeps going; fails loudly on a bad key", async () => {
    const warnings: string[] = [];
    const { client } = fakeClient(() => ({ status: 429, json: { type: "error", error: { type: "rate_limit_error", message: "slow down" } } }));
    const namer = createAiNamer({ model: "m", effort: "low", client, onWarning: (w) => warnings.push(w) });
    expect(await namer(input)).toBeUndefined();
    expect(await namer(input)).toBeUndefined();
    expect(warnings).toHaveLength(1);

    const bad = fakeClient(() => ({ status: 401, json: { type: "error", error: { type: "authentication_error", message: "bad" } } }));
    await expect(createAiNamer({ model: "m", effort: "low", client: bad.client })(input)).rejects.toThrow(/rejected the API key/);
  });
});
