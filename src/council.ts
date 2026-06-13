import { callModel, formatError } from "./client.js";
import {
  buildHeadUserPrompt,
  buildRevisionUserPrompt,
  DEFAULT_HEAD_SYSTEM_PROMPT,
  DEFAULT_MEMBER_SYSTEM_PROMPT,
} from "./prompts.js";
import { createRunDir, saveQuestion, saveMemberAnswer } from "./runstore.js";
import * as status from "./status.js";
import type {
  MemberAnswer,
  NormalizedCouncilConfig,
  NormalizedMember,
  RunCouncilOptions,
  RunCouncilResult,
} from "./types.js";

export class CouncilError extends Error {}

export async function runCouncil(
  config: NormalizedCouncilConfig,
  options: RunCouncilOptions,
): Promise<RunCouncilResult> {
  const runDirectory = createRunDir();
  saveQuestion(runDirectory, options.question);
  status.runDir(runDirectory);

  const round1Answers = await runRound1(runDirectory, config.members, options.question);

  if (round1Answers.length === 0) {
    throw new CouncilError("All members failed in round 1. Nothing to synthesize.");
  }

  const finalAnswers = options.noRevise
    ? round1Answers
    : await runRound2(runDirectory, config.members, round1Answers, options.question);

  const headAnswer = await synthesize(config, options.question, finalAnswers);

  return {
    headAnswer,
    memberFinalAnswers: finalAnswers,
  };
}

export async function synthesize(
  config: NormalizedCouncilConfig,
  question: string,
  finalAnswers: MemberAnswer[],
): Promise<string> {
  status.headStart();
  const headSystemPrompt = config.head.systemPrompt ?? DEFAULT_HEAD_SYSTEM_PROMPT;
  const headUserPrompt = buildHeadUserPrompt(question, finalAnswers);

  let headAnswer: string;
  try {
    const headResult = await callModel({
      node: config.head,
      systemPrompt: headSystemPrompt,
      userMessage: headUserPrompt,
    });
    headAnswer = headResult.text;
  } catch (error) {
    const reason = formatError(error);
    status.headFail(reason);
    throw new CouncilError(`Head failed: ${reason}`);
  }

  status.headSuccess();
  return headAnswer;
}

async function runRound1(
  runDirectory: string,
  members: NormalizedMember[],
  question: string,
): Promise<MemberAnswer[]> {
  const tasks = members.map(async (member) => {
    status.memberStart(member.id, 1);
    try {
      const result = await callModel({
        node: member,
        systemPrompt: member.systemPrompt ?? DEFAULT_MEMBER_SYSTEM_PROMPT,
        userMessage: question,
      });
      status.memberSuccess(member.id, result.elapsedMs / 1000, 1);
      const savedPath = saveMemberAnswer(runDirectory, member.id, 1, result.text);
      status.memberSaved(member.id, 1, savedPath);
      return { id: member.id, text: result.text } as MemberAnswer;
    } catch (error) {
      status.memberFail(member.id, formatError(error), 1);
      return null;
    }
  });

  const results = await Promise.all(tasks);
  return results.filter((item): item is MemberAnswer => item !== null);
}

async function runRound2(
  runDirectory: string,
  members: NormalizedMember[],
  round1Answers: MemberAnswer[],
  question: string,
): Promise<MemberAnswer[]> {
  const round1ById = new Map(round1Answers.map((entry) => [entry.id, entry.text]));
  const activeMembers = members.filter((member) => round1ById.has(member.id));

  const tasks = activeMembers.map(async (member) => {
    const ownRound1 = round1ById.get(member.id);
    if (!ownRound1) {
      return null;
    }

    const otherResponses = round1Answers.filter((entry) => entry.id !== member.id);
    const revisionPrompt = buildRevisionUserPrompt(question, ownRound1, otherResponses);

    status.memberStart(member.id, 2);
    try {
      const result = await callModel({
        node: member,
        systemPrompt: member.systemPrompt ?? DEFAULT_MEMBER_SYSTEM_PROMPT,
        userMessage: revisionPrompt,
      });
      status.memberSuccess(member.id, result.elapsedMs / 1000, 2);
      const savedPath = saveMemberAnswer(runDirectory, member.id, 2, result.text);
      status.memberSaved(member.id, 2, savedPath);
      return { id: member.id, text: result.text } as MemberAnswer;
    } catch (error) {
      status.memberFail(member.id, formatError(error), 2);
      return { id: member.id, text: ownRound1 } as MemberAnswer;
    }
  });

  const revised = await Promise.all(tasks);
  return revised.filter((item): item is MemberAnswer => item !== null);
}
