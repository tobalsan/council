import OpenAI from "openai";
import type { NormalizedModelNode } from "./types.js";

const RESPONSES_API_BASES = new Set([
  "https://api.openai.com/v1",
  "https://api.x.ai/v1",
]);

const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
]);

export interface CallModelInput {
  node: NormalizedModelNode;
  systemPrompt: string;
  userMessage: string;
}

export interface CallModelResult {
  text: string;
  elapsedMs: number;
}

export async function callModel(input: CallModelInput): Promise<CallModelResult> {
  const startedAt = Date.now();

  try {
    const text = await tryCall(input);
    return { text, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    if (!isTransientError(error)) {
      throw error;
    }

    const text = await tryCall(input);
    return { text, elapsedMs: Date.now() - startedAt };
  }
}

async function tryCall(input: CallModelInput): Promise<string> {
  const client = new OpenAI({
    apiKey: input.node.apiKey,
    baseURL: input.node.baseUrl,
  });

  const signal = AbortSignal.timeout(input.node.timeoutSec * 1000);
  if (shouldUseResponsesAPI(input.node.baseUrl)) {
    const response = await client.responses.create(
      {
        model: input.node.model,
        input: input.userMessage,
        instructions: input.systemPrompt,
        stream: false,
        reasoning: { effort: "high" },
      } as OpenAI.Responses.ResponseCreateParamsNonStreaming,
      { signal },
    );

    const text = extractResponsesText(response);
    if (text) {
      return text;
    }

    throw new Error("Responses API returned empty content");
  }

  const request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming =
    {
      model: input.node.model,
      reasoning_effort: "high",
      stream: false,
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userMessage },
      ],
    };

  const response = await client.chat.completions.create(
    request,
    { signal },
  );

  const choice = response.choices?.[0];
  if (!choice) {
    throw new Error("No completion choices returned");
  }

  const content = choice.message?.content;
  if (typeof content === "string" && content.trim().length > 0) {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const joined = content
      .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
      .join("\n")
      .trim();
    if (joined.length > 0) {
      return joined;
    }
  }

  throw new Error("Completion returned empty content");
}

function shouldUseResponsesAPI(baseUrl: string): boolean {
  return RESPONSES_API_BASES.has(normalizeComparableBaseUrl(baseUrl));
}

function normalizeComparableBaseUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return baseUrl.replace(/\/+$/, "");
  }
}

function extractResponsesText(response: OpenAI.Responses.Response): string | null {
  if (typeof response.output_text === "string" && response.output_text.trim().length > 0) {
    return response.output_text.trim();
  }

  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) {
    return null;
  }

  const texts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const type = (part as { type?: unknown }).type;
      const text = (part as { text?: unknown }).text;
      if (type === "output_text" && typeof text === "string" && text.trim().length > 0) {
        texts.push(text.trim());
      }
    }
  }

  return texts.length > 0 ? texts.join("\n").trim() : null;
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    const status = (error as { status?: number }).status;
    return status ? `${error.message} (status ${status})` : error.message;
  }

  return "Unknown error";
}

function isTransientError(error: unknown): boolean {
  if (isAbortError(error)) {
    return true;
  }

  const status = getHttpStatus(error);
  if (status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }

  const code = getErrorCode(error);
  return code !== undefined && RETRYABLE_ERROR_CODES.has(code);
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "AbortError" || error.message.toLowerCase().includes("timed out");
}

function getHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const directCode = (error as { code?: unknown }).code;
  if (typeof directCode === "string") {
    return directCode;
  }

  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const nestedCode = (cause as { code?: unknown }).code;
    if (typeof nestedCode === "string") {
      return nestedCode;
    }
  }

  return undefined;
}
