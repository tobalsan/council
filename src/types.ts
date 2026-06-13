export interface ModelNodeConfig {
  base_url?: string;
  model: string;
  api_key?: string;
  system_prompt?: string;
  timeout?: number;
  reasoning_effort?: string;
  cli?: string;
  provider?: string;
}

export interface MemberConfig extends ModelNodeConfig {
  id: string;
}

export interface HeadConfig extends ModelNodeConfig {}

export interface CouncilConfig {
  members: MemberConfig[];
  head: HeadConfig;
  timeout?: number;
}

interface NormalizedNodeBase {
  model: string;
  timeoutSec: number;
  reasoningEffort: string;
  systemPrompt?: string;
}

export interface NormalizedApiNode extends NormalizedNodeBase {
  transport: "api";
  baseUrl: string;
  apiKey: string;
}

export interface NormalizedCliNode extends NormalizedNodeBase {
  transport: "cli";
  cli: "codex" | "pi";
  provider?: string;
}

export type NormalizedModelNode = NormalizedApiNode | NormalizedCliNode;

export type NormalizedMember = NormalizedModelNode & { id: string };
export type NormalizedHead = NormalizedModelNode;

export interface NormalizedCouncilConfig {
  members: NormalizedMember[];
  head: NormalizedHead;
  timeoutSec: number;
}

export interface MemberAnswer {
  id: string;
  text: string;
}

export interface RunCouncilOptions {
  question: string;
  noRevise: boolean;
}

export interface RunCouncilResult {
  headAnswer: string;
  memberFinalAnswers: MemberAnswer[];
}
