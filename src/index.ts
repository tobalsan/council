#!/usr/bin/env bun

import { loadConfig, ConfigError } from "./config.js";
import { runCouncil, CouncilError } from "./council.js";

const USAGE = `Usage: council [options] [question]

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
