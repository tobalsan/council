import type { MemberAnswer } from "./types.js";

export const DEFAULT_MEMBER_SYSTEM_PROMPT =
  "You are a member of an elite council of experts in software engineering, AI, coding, and technology. You have been selected for your deep expertise and independent thinking. Provide your best, most thoughtful answer to the question posed. Be specific, practical, and opinionated where appropriate.";

export const DEFAULT_HEAD_SYSTEM_PROMPT =
  "You are the head of an elite council of experts in software engineering, AI, coding, and technology. Your role is to synthesize the council members' deliberated responses into a single, definitive answer. Identify the strongest points, resolve disagreements, and produce the best possible unified recommendation. Be clear, actionable, and comprehensive.";

export function buildRevisionUserPrompt(
  question: string,
  ownResponse: string,
  otherResponses: MemberAnswer[],
): string {
  const others =
    otherResponses.length === 0
      ? "(No other member responses available.)"
      : otherResponses
          .map((item) => `### ${item.id}\n${item.text}`)
          .join("\n\n");

  return [
    "## Original Question",
    question,
    "",
    "## Your Initial Response",
    ownResponse,
    "",
    "## Other Council Members' Responses",
    others,
    "",
    "---",
    "",
    "You have now seen the other council members' responses. Revise your answer if you believe improvements are warranted based on points you may have missed or perspectives worth incorporating. If you stand by your original answer, you may restate it with any minor refinements. Provide your final, complete answer.",
  ].join("\n");
}

export function buildHeadUserPrompt(
  question: string,
  finalResponses: MemberAnswer[],
): string {
  const responses = finalResponses
    .map((item) => `### ${item.id}\n${item.text}`)
    .join("\n\n");

  return [
    "## Original Question",
    question,
    "",
    "## Council Members' Final Responses",
    "",
    responses,
    "",
    "---",
    "",
    "Synthesize these responses into a single, definitive answer. Identify the strongest points across all members, resolve any disagreements, and produce the council's final recommendation.",
  ].join("\n");
}
