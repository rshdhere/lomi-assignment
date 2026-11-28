import { AsyncLocalStorage } from "node:async_hooks";
import { recordProviderUsage } from "@repo/drizzle";
import { config } from "@repo/config";

export type Message = {
  role: "user" | "assistant" | "tool" | "system";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
};

export class TransientProviderError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

export const attemptContext = new AsyncLocalStorage<string>();
async function post(path: string, body: Record<string, unknown>) {
  const started = performance.now();
  const encoded = JSON.stringify(body);
  if (
    path === "/chat/completions" &&
    Buffer.byteLength(encoded) + config.modelOutputReserve >
      config.modelContextBudget
  )
    throw new Error(
      "Request exceeds configured model context budget after reserving output",
    );

  if (!config.openaiApiKey)
    throw new Error("Configure OPENAI_API_KEY and retry extraction");
  const result = await fetch(config.openaiBaseUrl.replace(/\/$/, "") + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: encoded,
    signal: AbortSignal.timeout(90000),
  });
  const details = await result.json().catch(() => null);
  const format = body.response_format as
    { json_schema?: { name?: string } } | undefined;
  await recordProviderUsage({
    attempt: attemptContext.getStore(),
    operation:
      format?.json_schema?.name ??
      (path === "/embeddings" ? "embeddings" : "chat"),
    requested: String(body.model),
    returned: details?.model,
    requestId: result.headers.get("x-request-id"),
    input: details?.usage?.prompt_tokens,
    output: details?.usage?.completion_tokens,
    elapsed: Math.round(performance.now() - started),
    status: result.status,
  });
  if (!result.ok) {
    const param = details?.error?.param;
    console.error("Model request failed", {
      path,
      status: result.status,
      parameter:
        typeof param === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(param)
          ? param
          : undefined,
      requestId: result.headers.get("x-request-id"),
    });
    if (result.status === 429 || result.status >= 500) {
      const header = result.headers.get("retry-after");
      const delay =
        header && /^\d+$/.test(header)
          ? Number(header) * 1000
          : Date.parse(header ?? "") - Date.now();
      throw new TransientProviderError(
        `Model provider returned HTTP ${result.status} for ${path}`,
        Number.isFinite(delay) ? Math.max(0, delay) : 0,
      );
    }
    throw new Error(
      `Model provider returned HTTP ${result.status} for ${path}. Check the configured model and retry.`,
    );
  }
  return details;
}

export async function chat(
  messages: Message[],
  options: Record<string, unknown> = {},
): Promise<Message> {
  const response = await post("/chat/completions", {
    model: config.openaiModel,
    messages,
    ...options,
    // Luna's Chat Completions endpoint accepts function tools with reasoning disabled.
    ...(Array.isArray(options.tools) && config.openaiModel === "gpt-6-luna"
      ? { reasoning_effort: "none" }
      : {}),
  });
  const message = response.choices?.[0]?.message;
  if (!message || message.refusal)
    throw new Error("Model provided no usable response");
  return message;
}

export async function structured(
  system: string,
  input: string,
  name: string,
  schema: object,
) {
  const message = await chat(
    [
      { role: "system", content: system },
      { role: "user", content: input },
    ],
    {
      response_format: {
        type: "json_schema",
        json_schema: { name, strict: true, schema },
      },
    },
  );
  if (!message.content) throw new Error("Empty structured output");
  return message.content;
}

export async function embed(inputs: string[]): Promise<number[][]> {
  const response = await post("/embeddings", {
    model: config.embeddingModel,
    input: inputs,
    dimensions: 1536,
  });
  const ordered = (
    response.data as { index: number; embedding: number[] }[]
  ).sort((a, b) => a.index - b.index);
  if (
    ordered.length !== inputs.length ||
    ordered.some(
      (item, i) =>
        item.index !== i ||
        item.embedding.length !== 1536 ||
        !item.embedding.every(Number.isFinite),
    )
  )
    throw new Error("Embedding provider returned invalid vectors");
  return ordered.map((item) => item.embedding);
}
