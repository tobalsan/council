import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CouncilConfig,
  HeadConfig,
  MemberConfig,
  NormalizedApiNode,
  NormalizedCliNode,
  NormalizedCouncilConfig,
  NormalizedHead,
  NormalizedMember,
  NormalizedModelNode,
} from "./types.js";

const DEFAULT_TIMEOUT_SEC = 120;
const DEFAULT_REASONING_EFFORT = "xhigh";

export class ConfigError extends Error {}

export function getConfigPath(): string {
  return join(homedir(), ".council", "council.json");
}

export async function loadConfig(): Promise<NormalizedCouncilConfig> {
  const configPath = getConfigPath();
  let raw: string;

  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    throw new ConfigError(
      `Config file missing. Expected at ${configPath}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown parse error";
    throw new ConfigError(`Invalid JSON in ${configPath}: ${message}`);
  }

  return normalizeConfig(parsed);
}

function normalizeConfig(input: unknown): NormalizedCouncilConfig {
  if (!isObject(input)) {
    throw new ConfigError("Config root must be an object");
  }

  const membersRaw = input.members;
  const headRaw = input.head;
  const globalTimeout = normalizeOptionalTimeout(input.timeout, "timeout");

  if (!Array.isArray(membersRaw) || membersRaw.length === 0) {
    throw new ConfigError("No members configured. Add at least one member in members[]");
  }

  if (!isObject(headRaw)) {
    throw new ConfigError("Missing or invalid head configuration");
  }

  const timeoutSec = globalTimeout ?? DEFAULT_TIMEOUT_SEC;

  const members = membersRaw.map((member, index) =>
    normalizeMember(member, index, timeoutSec),
  );
  const head = normalizeHead(headRaw, timeoutSec);

  return {
    members,
    head,
    timeoutSec,
  };
}

function normalizeNodeBase(
  input: Record<string, unknown>,
  prefix: string,
  globalTimeoutSec: number,
): { model: string; timeoutSec: number; reasoningEffort: string; systemPrompt?: string; stance?: string } {
  const model = requireNonEmptyString(input.model, `${prefix}.model`);
  const timeoutOverride = normalizeOptionalTimeout(input.timeout, `${prefix}.timeout`);
  const systemPrompt = normalizeOptionalString(input.system_prompt, `${prefix}.system_prompt`);
  const stance = normalizeOptionalString(input.stance, `${prefix}.stance`);
  const reasoningEffort = normalizeOptionalString(input.reasoning_effort, `${prefix}.reasoning_effort`);

  return {
    model,
    timeoutSec: timeoutOverride ?? globalTimeoutSec,
    reasoningEffort: reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(stance ? { stance } : {}),
  };
}

function normalizeCliNode(
  input: Record<string, unknown>,
  cliValue: string,
  prefix: string,
  globalTimeoutSec: number,
): NormalizedCliNode {
  if (cliValue !== "codex" && cliValue !== "pi" && cliValue !== "claude" && cliValue !== "grok") {
    throw new ConfigError(
      `${prefix}.cli must be "codex", "pi", "claude", or "grok", got "${cliValue}"`,
    );
  }

  const base = normalizeNodeBase(input, prefix, globalTimeoutSec);

  if (cliValue === "pi") {
    const provider = requireNonEmptyString(input.provider, `${prefix}.provider`);
    return { transport: "cli", cli: "pi", provider, ...base };
  }

  if (cliValue === "claude") {
    return { transport: "cli", cli: "claude", ...base };
  }

  if (cliValue === "grok") {
    return { transport: "cli", cli: "grok", ...base };
  }

  return { transport: "cli", cli: "codex", ...base };
}

function normalizeApiNode(
  input: Record<string, unknown>,
  prefix: string,
  globalTimeoutSec: number,
): NormalizedApiNode {
  const baseUrl = normalizeBaseUrl(
    requireNonEmptyString(input.base_url, `${prefix}.base_url`),
  );
  const apiKey = resolveApiKey(
    requireNonEmptyString(input.api_key, `${prefix}.api_key`),
    `${prefix}.api_key`,
  );
  const base = normalizeNodeBase(input, prefix, globalTimeoutSec);

  return { transport: "api", baseUrl, apiKey, ...base };
}

function normalizeMember(
  input: unknown,
  index: number,
  globalTimeoutSec: number,
): NormalizedMember {
  if (!isObject(input)) {
    throw new ConfigError(`members[${index}] must be an object`);
  }

  const prefix = `members[${index}]`;
  const id = requireNonEmptyString(input.id, `${prefix}.id`);
  const cliRaw = normalizeOptionalString(input.cli, `${prefix}.cli`);

  const node: NormalizedModelNode = cliRaw
    ? normalizeCliNode(input, cliRaw, prefix, globalTimeoutSec)
    : normalizeApiNode(input, prefix, globalTimeoutSec);

  return { ...node, id };
}

function normalizeHead(
  input: unknown,
  globalTimeoutSec: number,
): NormalizedHead {
  if (!isObject(input)) {
    throw new ConfigError("head must be an object");
  }

  const cliRaw = normalizeOptionalString(input.cli, "head.cli");

  return cliRaw
    ? normalizeCliNode(input, cliRaw, "head", globalTimeoutSec)
    : normalizeApiNode(input, "head", globalTimeoutSec);
}

function resolveApiKey(value: string, path: string): string {
  if (!value.startsWith("$")) {
    return value;
  }

  const envName = value.slice(1).trim();
  if (!envName) {
    throw new ConfigError(`${path} has invalid env var reference`);
  }

  const resolved = process.env[envName];
  if (!resolved) {
    throw new ConfigError(`Environment variable ${envName} is not set (from ${path})`);
  }

  return resolved;
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const suffix = "/chat/completions";

  if (trimmed.endsWith(suffix)) {
    return trimmed.slice(0, -suffix.length);
  }

  return trimmed;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(`${path} must be a non-empty string`);
  }

  return value.trim();
}

function normalizeOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new ConfigError(`${path} must be a string if provided`);
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOptionalTimeout(value: unknown, path: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${path} must be a positive number in seconds if provided`);
  }

  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type { CouncilConfig, HeadConfig, MemberConfig };
