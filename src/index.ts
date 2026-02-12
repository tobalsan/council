#!/usr/bin/env bun

import { loadConfig, ConfigError } from "./config.js";
import { runCouncil, CouncilError } from "./council.js";
import { callModel, formatError } from "./client.js";
import {
  DEFAULT_HEAD_SYSTEM_PROMPT,
  DEFAULT_MEMBER_SYSTEM_PROMPT,
} from "./prompts.js";

const USAGE = `Usage: council [options] [question]
       council test <id> <prompt>

Arguments:
  question          The question or request for the council (reads from stdin if omitted)

Options:
  --no-revise       Skip the revision round (round 2); go directly from initial answers to head synthesis
  --verbose         Show each member's final response before the head's synthesis
  --help            Show help`;

interface ParsedArgs {
  noRevise: boolean;
  verbose: boolean;
  help: boolean;
  questionFromArgs: string | null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "test") {
    await runTestCommand(args.slice(1));
    return;
  }

  const parsed = parseArgs(args);

  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const question = await resolveQuestion(parsed.questionFromArgs);
  if (!question || question.trim().length === 0) {
    printError("No question provided.");
    printError(USAGE);
    process.exit(1);
  }

  const normalizedQuestion = question.trim();

  try {
    const config = await loadConfig();
    const result = await runCouncil(config, {
      question: normalizedQuestion,
      noRevise: parsed.noRevise,
    });

    if (parsed.verbose) {
      for (const answer of result.memberFinalAnswers) {
        process.stdout.write(`### Member: ${answer.id}\n\n${answer.text}\n\n---\n\n`);
      }
    }

    process.stdout.write(`${result.headAnswer}\n`);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof CouncilError) {
      printError(error.message);
      process.exit(1);
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    printError(`Unexpected error: ${message}`);
    process.exit(1);
  }
}

async function runTestCommand(args: string[]): Promise<void> {
  const memberId = args[0];
  const prompt = args.slice(1).join(" ").trim();

  if (!memberId || !prompt) {
    printError("Invalid test command. Expected: council test <id> <prompt>");
    printError(USAGE);
    process.exit(1);
  }

  try {
    const config = await loadConfig();
    const isHead = memberId === "head";
    const member = isHead ? null : config.members.find((item) => item.id === memberId);

    if (!isHead && !member) {
      const available = config.members.map((item) => item.id).join(", ");
      printError(
        `Configured member "${memberId}" was not found. Use "head" or one of: ${available || "(none)"}`,
      );
      process.exit(1);
    }

    const targetLabel = isHead ? "head" : `member "${memberId}"`;
    const node = isHead ? config.head : member!;
    const systemPrompt =
      node.systemPrompt ??
      (isHead ? DEFAULT_HEAD_SYSTEM_PROMPT : DEFAULT_MEMBER_SYSTEM_PROMPT);

    process.stderr.write(`⟳ Testing ${targetLabel}...\n`);
    const result = await callModel({
      node,
      systemPrompt,
      userMessage: prompt,
    });
    process.stderr.write(
      `✓ ${isHead ? "Head" : `Member "${memberId}"`} responded in ${(result.elapsedMs / 1000).toFixed(1)}s\n`,
    );
    process.stdout.write(`${result.text}\n`);
  } catch (error) {
    if (error instanceof ConfigError) {
      printError(`Test command failed to load config: ${error.message}`);
      process.exit(1);
    }

    printError(`Test call failed for ${memberId === "head" ? "head" : `member "${memberId}"`}: ${formatError(error)}`);
    process.exit(1);
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  let noRevise = false;
  let verbose = false;
  let help = false;
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg === "--no-revise") {
      noRevise = true;
      continue;
    }

    if (arg === "--verbose") {
      verbose = true;
      continue;
    }

    if (arg === "--help") {
      help = true;
      continue;
    }

    if (arg.startsWith("--")) {
      printError(`Unknown option: ${arg}`);
      printError(USAGE);
      process.exit(1);
    }

    positional.push(arg);
  }

  return {
    noRevise,
    verbose,
    help,
    questionFromArgs: positional.length > 0 ? positional.join(" ") : null,
  };
}

async function resolveQuestion(questionFromArgs: string | null): Promise<string | null> {
  if (questionFromArgs && questionFromArgs.trim().length > 0) {
    return questionFromArgs;
  }

  if (process.stdin.isTTY) {
    return null;
  }

  return readStdin();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
    } else {
      chunks.push(chunk as Buffer);
    }
  }

  return Buffer.concat(chunks).toString("utf8");
}

function printError(message: string): void {
  process.stderr.write(`${message}\n`);
}

await main();
