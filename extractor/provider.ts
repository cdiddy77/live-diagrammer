/**
 * Provider-agnostic LLM client. Anything exposing an OpenAI-compatible
 * POST /chat/completions works: OpenAI, OpenRouter, Together, Groq, vLLM,
 * Ollama, LM Studio.
 *
 * Configure by environment (repo-root .env is the house convention):
 *   LLM_BASE_URL   default https://api.openai.com/v1
 *                  OpenRouter: https://openrouter.ai/api/v1
 *   LLM_MODEL      required when actually calling
 *   LLM_API_KEY    falls back to OPENAI_API_KEY, then OPENROUTER_API_KEY
 *
 * Structured output is requested as json_schema, and falls back to json_object
 * if the endpoint rejects it. Either way the response is validated with zod on
 * our side, so a provider that ignores the schema entirely still fails loudly
 * instead of poisoning the graph.
 */
import { ExtractorOutput, type Op } from "../contracts/schema.ts";

export type LlmConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
};

export function configFromEnv(): LlmConfig {
  return {
    baseUrl: (process.env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, ""),
    model: process.env.LLM_MODEL ?? "",
    apiKey: process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "",
    temperature: Number(process.env.LLM_TEMPERATURE ?? "0"),
  };
}

/**
 * Strict structured-output modes across providers accept only a subset of JSON
 * Schema. Drop the validation keywords they choke on (we re-check with zod) and
 * rewrite oneOf as anyOf, which is the spelling strict mode accepts.
 */
export function sanitizeSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  if (node === null || typeof node !== "object") return node;
  const drop = new Set([
    "pattern", "minLength", "maxLength", "format",
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
    "minItems", "maxItems", "$schema", "$id", "default",
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (drop.has(k)) continue;
    out[k === "oneOf" ? "anyOf" : k] = sanitizeSchema(v);
  }
  return out;
}

export type CallResult = {
  ops: Op[];
  latency_ms: number;
  raw: string;
  /** Set when the response did not validate against the contract. */
  parse_error?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export async function callExtractor(
  system: string,
  user: string,
  schema: unknown,
  cfg: LlmConfig,
): Promise<CallResult> {
  /**
   * Reasoning-tier models (the gpt-5 line) reject any temperature but the
   * default. Dropped on the first unsupported_value and retried, rather than
   * maintaining a list of which models allow it.
   */
  let sendTemperature = true;
  const body = (responseFormat: unknown) => ({
    model: cfg.model,
    ...(sendTemperature ? { temperature: cfg.temperature } : {}),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: responseFormat,
  });

  const jsonSchemaFormat = {
    type: "json_schema",
    json_schema: { name: "extractor_output", strict: true, schema: sanitizeSchema(schema) },
  };

  const post = async (payload: unknown) => {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  };

  const t0 = Date.now();
  let r = await post(body(jsonSchemaFormat));
  if (!r.ok && /temperature/i.test(r.text) && /unsupported|does not support/i.test(r.text)) {
    sendTemperature = false;
    r = await post(body(jsonSchemaFormat));
  }
  if (!r.ok && /json_schema|response_format|schema/i.test(r.text)) {
    // Endpoint doesn't do json_schema. Fall back and put the shape in the words.
    r = await post({
      ...body({ type: "json_object" }),
      messages: [
        { role: "system", content: `${system}\n\nReply with JSON only: {"ops": [ ... ]}` },
        { role: "user", content: user },
      ],
    });
  }
  const latency_ms = Date.now() - t0;

  if (!r.ok) throw new Error(`LLM ${r.status}: ${r.text.slice(0, 400)}`);

  const env = JSON.parse(r.text);
  const raw: string = env.choices?.[0]?.message?.content ?? "";
  const usage = env.usage;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { ops: [], latency_ms, raw, parse_error: "response was not JSON", usage };
  }

  const parsed = ExtractorOutput.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      ops: [],
      latency_ms,
      raw,
      parse_error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      usage,
    };
  }
  return { ops: parsed.data.ops, latency_ms, raw, usage };
}
