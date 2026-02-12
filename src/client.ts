import OpenAI from "openai";
import type { NormalizedModelNode } from "./types.js";

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
