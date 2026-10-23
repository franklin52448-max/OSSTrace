import { ProviderError } from "../../lib/errors.ts";

/** OpenRouter's OpenAI-compatible chat-completions endpoint. */
export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

/** One OpenAI-style function tool, as sent in the request's `tools` array. */
export type ToolSpec = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

export type ToolCallMsg = { id: string; type: "function"; function: { name: string; arguments: string } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCallMsg[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ChatCompletion = { content: string | null; toolCalls: ToolCallMsg[]; finishReason: string | null };

export interface AgentLlm {
  complete(messages: ChatMessage[], tools: ToolSpec[], opts: { deadline: number }): Promise<ChatCompletion>;
}

/** Output tokens per model call: room for a reply or a few tool calls, nothing open-ended. */
const MAX_OUTPUT_TOKENS = 1500;
const PROVIDER_ID = "openrouter";

/**
 * The only object in this server that holds the agent's OpenRouter key. The key goes into exactly
 * one place -- this request's Authorization header -- and nowhere else: not into `messages` (what
 * the model reads), not into an error (every error below carries only the provider id and a status),
 * not into a log line. Held in a `#private` field so nothing else can even read it back off the
 * instance.
 */
export class OpenRouterClient implements AgentLlm {
  readonly #apiKey: string;
  readonly model: string;
  readonly #fetchImpl: typeof fetch;
  readonly #log: ((msg: string) => void) | undefined;

  constructor(apiKey: string, model: string, fetchImpl: typeof fetch = fetch, log?: (msg: string) => void) {
    this.#apiKey = apiKey;
    this.model = model;
    this.#fetchImpl = fetchImpl;
    this.#log = log;
  }

  async complete(messages: ChatMessage[], tools: ToolSpec[], opts: { deadline: number }): Promise<ChatCompletion> {
    const remaining = opts.deadline - Date.now();
    if (remaining < 2000) throw new ProviderError(PROVIDER_ID, "The agent ran out of time for this message", 5);
    let res: Response;
    try {
      res = await this.#fetchImpl(OPENROUTER_CHAT_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
          "x-title": "OSSTrace Tracer agent",
        },
        // No `temperature`: some models OpenRouter routes to refuse it, and TRACER_AGENT_MODEL can be any of them.
        body: JSON.stringify({ model: this.model, messages, tools, tool_choice: "auto", max_tokens: MAX_OUTPUT_TOKENS }),
        signal: AbortSignal.timeout(Math.min(45_000, remaining)),
        redirect: "error",
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new ProviderError(PROVIDER_ID, timedOut ? "The AI model provider timed out" : "The AI model provider is unreachable", 5);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      // OpenRouter's own error message (e.g. "model not found", "insufficient credits") is for the
      // operator's log only -- the caller gets a plain status, never upstream text.
      const upstream = (body as { error?: { message?: unknown } } | null)?.error?.message;
      this.#log?.(`openrouter HTTP ${res.status}${typeof upstream === "string" ? `: ${upstream.slice(0, 200)}` : ""}`);
      const retry = res.status === 429 ? Number(res.headers.get("retry-after")) || 10 : res.status >= 500 ? 10 : undefined;
      throw new ProviderError(PROVIDER_ID, res.status === 429 ? "The AI model provider is rate limited" : `The AI model provider returned HTTP ${res.status}`, retry);
    }
    return parseCompletion(body);
  }
}

/** Reads an OpenAI-style completion defensively: anything off-shape is a provider error, not a guess. */
export function parseCompletion(body: unknown): ChatCompletion {
  const choice = (body as { choices?: unknown[] } | null)?.choices?.[0] as
    | { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }
    | undefined;
  const msg = choice?.message;
  if (!msg || typeof msg !== "object") throw new ProviderError(PROVIDER_ID, "The AI model provider returned no message", 5);
  // OpenRouter answers HTTP 200 when the upstream model fails mid-generation, and says so in the
  // choice itself (finish_reason "error", an `error` object, usually empty content). That's a
  // provider failure, not the model choosing to say nothing.
  if (choice?.finish_reason === "error" || (choice as { error?: unknown }).error) throw new ProviderError(PROVIDER_ID, "The AI model failed while answering", 5);
  const content = typeof msg.content === "string" ? msg.content : null;
  const toolCalls: ToolCallMsg[] = [];
  if (Array.isArray(msg.tool_calls)) {
    for (const raw of msg.tool_calls as unknown[]) {
      const c = raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      if (typeof c?.id !== "string" || typeof c.function?.name !== "string") continue;
      const args = typeof c.function.arguments === "string" ? c.function.arguments : JSON.stringify(c.function.arguments ?? {});
      toolCalls.push({ id: c.id.slice(0, 200), type: "function", function: { name: c.function.name.slice(0, 100), arguments: args } });
    }
  }
  return { content, toolCalls, finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null };
}
