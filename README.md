# Council CLI

`council` is a Bun + TypeScript CLI that asks multiple LLMs in parallel, lets them revise after seeing peers, then asks a head model to synthesize one final answer.

## Requirements

- Bun `1.3+`
- A config file at `~/.council/council.json`

## Install

```bash
bun install
bun link
```

After `bun link`, you can run the global alias:

```bash
council --help
```

## Usage

```bash
council [options] [question]
council head <dir> [--verbose]
council test <id> <prompt> [options]
```

Options:

- `--no-revise`: skip round 2 revision
- `--verbose`: print each member final answer before head synthesis
- `--skip <ids>`: skip one or more members for this run (comma-separated, repeatable)
- `-f, --file`: attach file context via files/directories/globs (supports exclusions with `!pattern`)
- `--help`: show help

`--file` behavior:

- Accepts repeated flags and comma-separated values in one flag.
- Supports excludes with `!pattern` (for example `!src/**/*.test.ts`).
- Fails fast for missing/invalid paths, zero matches, or files larger than 1 MB.

Examples:

```bash
council "Recommend a backend stack for a small SaaS"
council --no-revise "Quick tradeoff: Bun vs Node for CLI tools"
council --verbose "Design a rollout plan for feature flags"
council --file "src/**/*.ts,!src/**/*.test.ts" "Review architecture risks and schema drift"
cat requirements.txt | council
council test gpt "Give me 3 deployment debugging steps" --file "src/**/*.ts,*/*.test.ts"
council test head "Give me one production-readiness checklist"
```

## Saving & resuming runs

Every run writes member responses to a temp dir as they arrive (printed at startup):

```
📁 Saving responses to /var/folders/.../T/council/20260613-151549-30837
```

Layout: `question.md`, plus `<id>.r1.md` / `<id>.r2.md` per member (round 1 / revision; failures are not saved).

If a run is interrupted (e.g. head timeout or a flaky member), you can resume without re-querying members:

```bash
# Re-run only the head synthesis from saved member output
council head /var/folders/.../T/council/20260613-151549-30837 --verbose

# Skip members that already succeeded (or keep failing) and rerun the rest
council --skip grok,gemini "original question"
```

`council head <dir>` loads the saved question and each member's latest answer (prefers `.r2` over `.r1`), then runs head synthesis only.

## Config (`~/.council/council.json`)

`api_key` can be a literal key or `$ENV_VAR`. `reasoning_effort` is optional per member/head (default `xhigh`), passed through verbatim to the provider (`low|medium|high|xhigh|max` for Anthropic/OpenAI; xAI grok supports only up to `high`, so set `reasoning_effort: "high"` for xAI members). `system_prompt` is an optional per-member/head string that replaces the default system prompt.

`stance` is an optional per-member string — a hard behavioral mandate (e.g. a Devil's Advocate or Red Team role) injected as the first, highest-priority instruction in the member's user message and reinforced at the end. Applies to members only (the head uses `system_prompt`). It takes effect in round 1, the revision round, and the `test <member>` command.

```json
{
  "members": [
    {
      "id": "grok",
      "base_url": "https://openrouter.ai/api/v1/chat/completions",
      "model": "xai/grok-4.1-fast",
      "api_key": "$OPENROUTER_KEY",
      "timeout": 180,
      "reasoning_effort": "high",
      "stance": "You are the Devil's Advocate. Oppose the emerging consensus and surface its strongest counterargument."
    },
    {
      "id": "gpt",
      "base_url": "https://api.openai.com/v1",
      "model": "gpt-5.2",
      "api_key": "$OPENAI_KEY"
    }
  ],
  "head": {
    "base_url": "https://api.openai.com/v1/chat/completions",
    "model": "gpt-5.2-pro",
    "api_key": "$OPENAI_KEY",
    "timeout": 180
  },
  "timeout": 120
}
```

Timeout precedence: member/head `timeout` > global `timeout` > default `120` seconds.

API selection by endpoint:

- `https://api.anthropic.com`: uses the native Anthropic Messages API (adaptive thinking + effort).
- `https://api.openai.com/v1` and `https://api.x.ai/v1`: uses Responses API automatically.
- Other endpoints (for example OpenRouter/Gemini-compatible): uses Chat Completions.

### CLI transport

Members and the head can run a local CLI instead of an HTTP API by setting `cli`. Supported values: `"codex"`, `"pi"`, and `"claude"`. `base_url` and `api_key` are not required for CLI nodes.

- **codex** — must be authenticated before use (`codex` must be on `PATH`).
- **pi** — requires `provider` (non-empty string passed to `--provider`). `pi` must be configured separately.
- **claude** — runs the local Claude Code CLI (`claude -p`); must be authenticated (`claude` must be on `PATH`). No `provider` needed. `reasoning_effort` maps directly to Claude Code's `--effort` (`low|medium|high|xhigh|max`).

`reasoning_effort`, `timeout`, and `system_prompt` work identically for CLI and API nodes. Mixed CLI/API councils are supported.

Example CLI members and a codex head:

```json
{
  "members": [
    { "id": "gpt", "cli": "codex", "model": "gpt-5.5", "reasoning_effort": "high", "timeout": 300 },
    { "id": "glm", "cli": "pi", "provider": "zai", "model": "glm-5.2", "reasoning_effort": "high", "timeout": 300 },
    { "id": "claude", "cli": "claude", "model": "opus", "reasoning_effort": "high", "timeout": 300 }
  ],
  "head": { "cli": "codex", "model": "gpt-5.5", "reasoning_effort": "xhigh", "timeout": 600 }
}
```

## Development

```bash
bun run typecheck
bun run src/index.ts --help
```
