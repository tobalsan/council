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
council test <id> <prompt> [options]
```

Options:

- `--no-revise`: skip round 2 revision
- `--verbose`: print each member final answer before head synthesis
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

## Config (`~/.council/council.json`)

`api_key` can be a literal key or `$ENV_VAR`. `reasoning_effort` is optional per member/head (default `xhigh`), passed through verbatim to the provider (`low|medium|high|xhigh|max` for Anthropic/OpenAI; xAI grok supports only up to `high`, so set `reasoning_effort: "high"` for xAI members).

```json
{
  "members": [
    {
      "id": "grok",
      "base_url": "https://openrouter.ai/api/v1/chat/completions",
      "model": "xai/grok-4.1-fast",
      "api_key": "$OPENROUTER_KEY",
      "timeout": 180,
      "reasoning_effort": "high"
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

## Development

```bash
bun run typecheck
bun run src/index.ts --help
```
