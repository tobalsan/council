import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedApiNode, NormalizedCliNode, NormalizedModelNode } from "./types.js";

const ANTHROPIC_MAX_TOKENS = 32000;

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

let cliCallCounter = 0;

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
  if (input.node.transport === "cli") {
    return await callCli(input.node, input.systemPrompt, input.userMessage);
  }

  const node = input.node;

  if (isAnthropicBase(node.baseUrl)) {
    return await callAnthropic(node, input.systemPrompt, input.userMessage);
  }

  const client = new OpenAI({
    apiKey: node.apiKey,
    baseURL: node.baseUrl,
  });

  const signal = AbortSignal.timeout(node.timeoutSec * 1000);
  if (shouldUseResponsesAPI(node.baseUrl)) {
    const response = await client.responses.create(
      {
        model: node.model,
        input: input.userMessage,
        instructions: input.systemPrompt,
        stream: false,
        reasoning: { effort: node.reasoningEffort },
      } as OpenAI.Responses.ResponseCreateParamsNonStreaming,
      { signal },
    );

    const text = extractResponsesText(response);
    if (text) {
      return text;
    }

    throw new Error("Responses API returned empty content");
  }

  const request = {
    model: node.model,
    reasoning_effort: node.reasoningEffort,
    stream: false,
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userMessage },
    ],
  } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

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

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runProcess(
  cmd: string,
  args: string[],
  stdinText: string | undefined,
  timeoutSec: number,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;

    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reject(new Error(`${cmd} not found or failed to start: ${message}`));
      return;
    }

    if (!child.stdout || !child.stderr || !child.stdin) {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} stdio streams not available`));
      return;
    }

    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${cmd} exceeded ${timeoutSec}s limit`));
    }, timeoutSec * 1000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${cmd} not found or failed to start: ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: stdoutBuf, stderr: stderrBuf });
    });

    if (stdinText !== undefined) {
      child.stdin.write(stdinText, "utf8");
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

async function callCli(
  node: NormalizedCliNode,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  if (node.cli === "codex") {
    return await callCodex(node, systemPrompt, userMessage);
  }
  if (node.cli === "claude") {
    return await callClaude(node, systemPrompt, userMessage);
  }
  return await callPi(node, systemPrompt, userMessage);
}

async function callCodex(
  node: NormalizedCliNode,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const { model, reasoningEffort: effort, timeoutSec } = node;
  const promptText = `${systemPrompt}\n\n${userMessage}`;

  cliCallCounter += 1;
  const tmpFile = join(tmpdir(), `council-codex-${process.pid}-${cliCallCounter}.txt`);

  const args = [
    "exec",
    "--model", model,
    "-c", `model_reasoning_effort="${effort}"`,
    "-c", 'sandbox_permissions=["disk-full-read-access"]',
    "--skip-git-repo-check",
    "-o", tmpFile,
    "-",
  ];

  const { code, stdout, stderr } = await runProcess("codex", args, promptText, timeoutSec);

  if (code !== 0) {
    throw new Error(`codex exited ${code}: ${stderr.trim() || stdout.trim()}`);
  }

  let answer: string;
  try {
    answer = (await readFile(tmpFile, "utf8")).trim();
  } finally {
    unlink(tmpFile).catch(() => undefined);
  }

  if (answer.length === 0) {
    throw new Error("codex produced no output");
  }

  return answer;
}

async function callPi(
  node: NormalizedCliNode,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const { model, reasoningEffort: effort, timeoutSec, provider } = node;

  if (!provider) {
    throw new Error("pi transport requires provider but none was set");
  }

  const args = [
    "--provider", provider,
    "--model", model,
    "--thinking", effort,
    "--no-tools",
    "--no-session",
    "--system-prompt", systemPrompt,
    "-p", userMessage,
  ];

  const { code, stdout, stderr } = await runProcess("pi", args, undefined, timeoutSec);

  if (code !== 0) {
    throw new Error(`pi exited ${code}: ${stderr.trim() || stdout.trim()}`);
  }

  const answer = stdout.trim();
  if (answer.length === 0) {
    throw new Error("pi produced no output");
  }

  return answer;
}

async function callClaude(
  node: NormalizedCliNode,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const { model, reasoningEffort: effort, timeoutSec } = node;

  const args = [
    "-p",
    "--model", model,
    "--effort", effort,
    "--system-prompt", systemPrompt,
  ];

  const { code, stdout, stderr } = await runProcess("claude", args, userMessage, timeoutSec);

  if (code !== 0) {
    throw new Error(`claude exited ${code}: ${stderr.trim() || stdout.trim()}`);
  }

  const answer = stdout.trim();
  if (answer.length === 0) {
    throw new Error("claude produced no output");
  }

  return answer;
}

function isAnthropicBase(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).host === "api.anthropic.com";
  } catch {
    return false;
  }
}

async function callAnthropic(
  node: NormalizedApiNode,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const client = new Anthropic({ apiKey: node.apiKey });
  const signal = AbortSignal.timeout(node.timeoutSec * 1000);

  const stream = client.messages.stream(
    {
      model: node.model,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: node.reasoningEffort as Anthropic.Messages.OutputConfig["effort"] },
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    } as Anthropic.MessageStreamParams,
    { signal },
  );

  const message = await stream.finalMessage();

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (text.length > 0) {
    return text;
  }

  throw new Error("Anthropic API returned empty content");
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
