import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CouncilConfig,
  HeadConfig,
  MemberConfig,
  NormalizedCouncilConfig,
  NormalizedHead,
  NormalizedMember,
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

function normalizeMember(
  input: unknown,
  index: number,
  globalTimeoutSec: number,
): NormalizedMember {
  if (!isObject(input)) {
    throw new ConfigError(`members[${index}] must be an object`);
  }

  const id = requireNonEmptyString(input.id, `members[${index}].id`);
  const baseUrl = normalizeBaseUrl(
    requireNonEmptyString(input.base_url, `members[${index}].base_url`),
  );
  const model = requireNonEmptyString(input.model, `members[${index}].model`);
  const apiKey = resolveApiKey(
    requireNonEmptyString(input.api_key, `members[${index}].api_key`),
    `members[${index}].api_key`,
  );
  const timeoutOverride = normalizeOptionalTimeout(
    input.timeout,
    `members[${index}].timeout`,
  );
  const systemPrompt = normalizeOptionalString(
    input.system_prompt,
    `members[${index}].system_prompt`,
  );
  const reasoningEffort = normalizeOptionalString(
    input.reasoning_effort,
    `members[${index}].reasoning_effort`,
  );

  return {
    id,
    baseUrl,
    model,
    apiKey,
    timeoutSec: timeoutOverride ?? globalTimeoutSec,
    reasoningEffort: reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    ...(systemPrompt ? { systemPrompt } : {}),
  };
}

function normalizeHead(
  input: unknown,
  globalTimeoutSec: number,
): NormalizedHead {
  if (!isObject(input)) {
    throw new ConfigError("head must be an object");
  }

  const baseUrl = normalizeBaseUrl(requireNonEmptyString(input.base_url, "head.base_url"));
  const model = requireNonEmptyString(input.model, "head.model");
  const apiKey = resolveApiKey(
    requireNonEmptyString(input.api_key, "head.api_key"),
    "head.api_key",
  );
  const timeoutOverride = normalizeOptionalTimeout(input.timeout, "head.timeout");
  const systemPrompt = normalizeOptionalString(
    input.system_prompt,
    "head.system_prompt",
  );
  const reasoningEffort = normalizeOptionalString(
    input.reasoning_effort,
    "head.reasoning_effort",
  );

  return {
    baseUrl,
    model,
    apiKey,
    timeoutSec: timeoutOverride ?? globalTimeoutSec,
    reasoningEffort: reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    ...(systemPrompt ? { systemPrompt } : {}),
  };
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
