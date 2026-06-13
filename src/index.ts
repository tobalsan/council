#!/usr/bin/env bun

import { loadConfig, ConfigError } from "./config.js";
import { runCouncil, CouncilError, synthesize } from "./council.js";
import { callModel, formatError } from "./client.js";
import {
  DEFAULT_HEAD_SYSTEM_PROMPT,
  DEFAULT_MEMBER_SYSTEM_PROMPT,
} from "./prompts.js";
import { buildPromptWithFiles, FileInputError, readFiles } from "./files.js";
import { loadSavedRun } from "./runstore.js";

const USAGE = `Usage: council [options] [question]
       council head <dir> [--verbose]
       council test <id> <prompt> [options]

Arguments:
  question          The question or request for the council (reads from stdin if omitted)
  head <dir>        Re-run head synthesis on a previously saved run directory

Options:
  -f, --file        Files/directories or glob patterns to attach (prefix with !pattern to exclude)
  --skip <ids>      Comma-separated member ids to skip (repeatable)
  --no-revise       Skip the revision round (round 2); go directly from initial answers to head synthesis
  --verbose         Show each member's final response before the head's synthesis
  --help            Show help`;

interface ParsedArgs {
  noRevise: boolean;
  verbose: boolean;
  help: boolean;
  fileInputs: string[];
  skip: string[];
  questionFromArgs: string | null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "head") {
    await runHeadCommand(args.slice(1));
    return;
  }

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

  let normalizedQuestion = question.trim();

  try {
    if (parsed.fileInputs.length > 0) {
      const files = await readFiles(parsed.fileInputs, { cwd: process.cwd() });
      normalizedQuestion = buildPromptWithFiles(normalizedQuestion, files, process.cwd());
    }

    const config = await loadConfig();

    let filteredMembers = config.members;
    if (parsed.skip.length > 0) {
      const memberIds = new Set(config.members.map((m) => m.id));
      for (const skipId of parsed.skip) {
        if (!memberIds.has(skipId)) {
          printError(`⚠ --skip: no member named "${skipId}"`);
        }
      }
      const skipSet = new Set(parsed.skip);
      filteredMembers = config.members.filter((m) => !skipSet.has(m.id));
      if (filteredMembers.length === 0) {
        printError("All members were skipped. Nothing to run.");
        process.exit(1);
      }
    }

    const result = await runCouncil({ ...config, members: filteredMembers }, {
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
    if (error instanceof FileInputError) {
      printError(`File input error: ${error.message}`);
      process.exit(1);
    }

    if (error instanceof ConfigError || error instanceof CouncilError) {
      printError(error.message);
      process.exit(1);
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    printError(`Unexpected error: ${message}`);
    process.exit(1);
  }
}

async function runHeadCommand(args: string[]): Promise<void> {
  const verbose = args.includes("--verbose");
  const dir = args.find((a) => !a.startsWith("--"));

  if (!dir) {
    printError("Usage: council head <dir> [--verbose]");
    process.exit(1);
  }

  try {
    const config = await loadConfig();
    const { question, answers } = loadSavedRun(dir);

    if (verbose) {
      for (const answer of answers) {
        process.stdout.write(`### Member: ${answer.id}\n\n${answer.text}\n\n---\n\n`);
      }
    }

    const headAnswer = await synthesize(config, question, answers);
    process.stdout.write(`${headAnswer}\n`);
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
  const parsed = parseArgs(args);
  const memberId = parsed.questionFromArgs?.split(" ")[0]?.trim();
  const prompt = parsed.questionFromArgs?.split(" ").slice(1).join(" ").trim() ?? "";

  if (!memberId || !prompt) {
    printError("Invalid test command. Expected: council test <id> <prompt> [--file ...]");
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

    let promptWithFiles = prompt;
    if (parsed.fileInputs.length > 0) {
      const files = await readFiles(parsed.fileInputs, { cwd: process.cwd() });
      promptWithFiles = buildPromptWithFiles(prompt, files, process.cwd());
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
      userMessage: promptWithFiles,
    });
    process.stderr.write(
      `✓ ${isHead ? "Head" : `Member "${memberId}"`} responded in ${(result.elapsedMs / 1000).toFixed(1)}s\n`,
    );
    process.stdout.write(`${result.text}\n`);
  } catch (error) {
    if (error instanceof FileInputError) {
      printError(`File input error: ${error.message}`);
      process.exit(1);
    }

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
  const fileInputs: string[] = [];
  const skip: string[] = [];
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }

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

    if (arg === "--file" || arg === "-f") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--") || value === "-f") {
        printError("--file requires at least one path or glob pattern");
        process.exit(1);
      }

      const entries = value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      fileInputs.push(...entries);
      i += 1;
      continue;
    }

    if (arg === "--skip") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        printError("--skip requires a value");
        process.exit(1);
      }

      const entries = value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      skip.push(...entries);
      i += 1;
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
    fileInputs,
    skip,
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
