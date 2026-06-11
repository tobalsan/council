export interface ModelNodeConfig {
  base_url: string;
  model: string;
  api_key: string;
  system_prompt?: string;
  timeout?: number;
  reasoning_effort?: string;
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

export interface NormalizedModelNode {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutSec: number;
  systemPrompt?: string;
  reasoningEffort: string;
}

export interface NormalizedMember extends NormalizedModelNode {
  id: string;
}

export interface NormalizedHead extends NormalizedModelNode {}

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
