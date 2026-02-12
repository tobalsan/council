# Council CLI — LLM Codebase Guide

This document is for LLM agents and contributors who need high-context understanding before making changes.

## What This Project Does

`council` orchestrates a deliberation pipeline:

1. Round 1: query all members in parallel with the user question.
2. Round 2 (optional): each surviving member revises after seeing peer answers.
3. Round 3: head model synthesizes one final answer.

Primary design goals:

- Parallel fan-out for member calls.
- Failure isolation (single member failure should not fail whole run).
- Strict stdout/stderr separation for scriptability.

## Runtime + Dependencies

- Runtime: Bun
- Language: TypeScript (strict mode)
- External dependency: `openai` SDK (Responses + Chat Completions APIs)

No framework is used for CLI parsing.

## File Map and Responsibilities

- `src/index.ts`
  - CLI entrypoint.
  - Parses flags and positionals.
  - Resolves question from args or stdin.
  - Loads config, executes orchestration, prints output, maps failures to exit code `1`.
- `src/config.ts`
  - Loads `~/.council/council.json`.
  - Validates required fields and types.
  - Resolves `$ENV_VAR` API keys.
  - Normalizes base URL (accepts both API root and `/chat/completions` form).
  - Applies timeout precedence.
- `src/client.ts`
  - Wraps OpenAI SDK request execution.
  - Auto-selects API by endpoint:
    - `https://api.openai.com/v1` and `https://api.x.ai/v1` -> Responses API.
    - all other endpoints -> Chat Completions API.
  - Enforces high reasoning effort:
    - Responses: `reasoning.effort = "high"`
    - Chat Completions: `reasoning_effort = "high"`
  - Applies per-request timeout.
  - Implements one retry for transient failures (network/timeout/429/5xx).
  - Normalizes text extraction for both APIs.
- `src/council.ts`
  - Core orchestration (round 1 -> round 2 -> head synthesis).
  - Handles per-member failure behavior and round 2 fallback-to-round1.
  - Throws `CouncilError` for terminal states (all members failed in round1, head failure).
- `src/prompts.ts`
  - Default member/head system prompts.
  - Prompt builders for revision and synthesis user messages.
- `src/status.ts`
  - Real-time status logging helpers.
  - All status goes to `stderr`.
- `src/types.ts`
  - Shared config/runtime result types.

## CLI Contract

Command:

```bash
council [options] [question]
council test <id> <prompt>
```

Flags:

- `--no-revise`: skip round 2.
- `--verbose`: print final member answers before head answer.
- `--help`: print usage and exit `0`.

Subcommand:

- `test <id> <prompt>`: run one direct call for quick debugging.
  - If `<id>` is `head`, uses configured head node + head system prompt.
  - Otherwise `<id>` must match a configured member id.

Input resolution order:

1. Positional args (all unflagged tokens joined into one question).
2. If no positionals and stdin is piped, read stdin as question.
3. Else error + usage, exit `1`.

Output behavior:

- `stdout`: final answer (and verbose member blocks when requested).
- `stderr`: status and errors.
- `council test`: single model output to `stdout`, explicit test diagnostics/errors to `stderr`.

Exit behavior:

- `0` success.
- `1` for expected failures (config errors, empty question, all members failed round1, head failure, unknown flag).

## Config Contract

Expected path: `~/.council/council.json`

Top-level shape:

- `members`: array of objects, non-empty.
- `head`: object.
- `timeout` (optional): global timeout seconds.

Member required fields:

- `id`, `base_url`, `model`, `api_key`

Head required fields:

- `base_url`, `model`, `api_key`

Optional per-node fields:

- `timeout`
- `system_prompt`

Important rules:

- `api_key` accepts literal or `$ENV_VAR`.
- Unknown keys are allowed and ignored.
- `base_url` normalization trims trailing slash and strips `/chat/completions` if present.

## Deliberation Flow Details

### Round 1

- For each member in config, dispatch in parallel.
- On success: store answer.
- On failure: log warning and skip member.
- If zero successes: terminal error.

### Round 2 (unless `--no-revise`)

- Only members that succeeded in round 1 participate.
- Each member receives:
  - original question
  - own round1 answer
  - all other round1 answers
- If round2 call fails for a member: use their round1 answer as final fallback.

### Head Synthesis

- Head receives original question + all member final answers.
- Head failure is terminal.

## Error Handling Model

Error classes used by CLI entrypoint:

- `ConfigError` (`src/config.ts`): config load/parse/validation/env failures.
- `CouncilError` (`src/council.ts`): orchestration terminal failures.

Client-level retry:

- One retry attempt only when classified transient.
- Non-transient failures bubble immediately.

## Prompting Contract

Do not silently change prompt structure in a way that breaks data inclusion.

Required revision prompt sections:

- original question
- own initial response
- labeled other members responses
- explicit instruction to revise or retain with refinements

Required head synthesis prompt sections:

- original question
- labeled final member responses
- explicit synthesis instruction

## Testing and Validation Commands

- Typecheck:

```bash
bun run typecheck
```

- Basic CLI smoke test:

```bash
bun run src/index.ts --help
```

- Runtime smoke (requires config):

```bash
council "Test question"
```

## Common Change Scenarios

### Add a new CLI flag

1. Update `parseArgs` in `src/index.ts`.
2. Thread option into `runCouncil` inputs if needed.
3. Update usage string and README docs.

### Change failure policy

- Member/head behavior belongs in `src/council.ts`.
- Retry policy belongs in `src/client.ts`.
- Keep spec alignment across README and this file.

### Support extra config fields

- Extend types in `src/types.ts`.
- Normalize/validate in `src/config.ts`.
- Keep backward compatibility when possible.

### Change provider behavior

- Centralize network/request changes in `src/client.ts`.
- Preserve non-streaming behavior unless intentionally redesigned.

## Constraints to Preserve

- Keep stdout clean for machine consumption.
- Keep status/progress in stderr.
- Avoid adding heavy dependencies unless needed.
- Maintain parallel member execution.
- Preserve round2 fallback-to-round1 semantics.

## Quick Mental Model for Agents

- `index.ts` is command plumbing.
- `config.ts` is trust boundary for user config.
- `client.ts` is network boundary.
- `council.ts` is business logic.
- `prompts.ts` is protocol content.
- `status.ts` is UX telemetry.
