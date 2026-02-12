# Council CLI — Specification

## Problem Statement

When making important technical decisions, a single AI model can have blind spots or biases. By querying multiple frontier models in parallel, letting them see and revise against each other's answers, and having a designated "head" synthesize the results, we get a higher-quality, more balanced recommendation — a deliberative AI council.

## Goals

- Provide a single `council "question"` command that orchestrates multi-model deliberation
- Two-round process: independent answers → revision after seeing peers → head synthesis
- Real-time CLI status feedback during the process
- Configurable members, head, prompts, and timeouts via `~/.council/council.json`

## Non-Goals

- No GUI or web interface
- No conversation history or session persistence
- No built-in cost tracking
- No `council init` scaffolding command

---

## User Stories

1. **Ask a question**: `council "advise on a framework for X"` → get a synthesized answer from multiple models
2. **Quick mode**: `council --no-revise "quick question"` → skip the revision round, go straight from round 1 to head synthesis
3. **Verbose output**: `council --verbose "question"` → see each member's final answer before the head's synthesis
4. **Pipe input**: `cat requirements.txt | council` → read question/context from stdin

---

## Technical Architecture

### Stack

- **Runtime**: Bun
- **Language**: TypeScript
- **API Client**: `openai` npm package (works with any OpenAI-compatible endpoint)
- **CLI Framework**: None (minimal arg parsing — Bun's `process.argv` / `Bun.argv`)
- **Installation**: `bun link` for global `council` command

### Project Structure

```
council/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts          # CLI entry point, arg parsing, stdin handling
│   ├── config.ts         # Load & validate ~/.council/council.json
│   ├── client.ts         # OpenAI client factory, API call wrapper
│   ├── council.ts        # Orchestration: round 1 → round 2 → head synthesis
│   ├── prompts.ts        # Default system prompts for members and head
│   └── status.ts         # Real-time terminal status output
```

### Config File: `~/.council/council.json`

```json
{
  "members": [
    {
      "id": "grok",
      "base_url": "https://openrouter.ai/api/v1/chat/completions",
      "model": "xai/grok-4.1-fast",
      "api_key": "$OPENROUTER_KEY",
      "system_prompt": "Optional custom prompt override",
      "timeout": 180
    },
    {
      "id": "gpt",
      "base_url": "https://api.openai.com/v1/chat/completions",
      "model": "gpt-5.2",
      "api_key": "sk-literal-key-here"
    }
  ],
  "head": {
    "base_url": "https://api.openai.com/v1/chat/completions",
    "model": "gpt-5.2-pro",
    "api_key": "$OPENAI_KEY",
    "system_prompt": "Optional custom head prompt override",
    "timeout": 180
  },
  "timeout": 120
}
```

**Config rules:**
- `api_key` supports both literal values and `$ENV_VAR` references (resolved at runtime)
- `timeout` (seconds): per-member override > global config > default 120s
- `system_prompt`: optional per-member and per-head override of default prompts
- `id`: required for each member, used in status output and verbose display

### API Calls

All API calls use the `openai` npm package:

```ts
const client = new OpenAI({ apiKey, baseURL });
const response = await client.chat.completions.create({
  model,
  reasoning_effort: "high",
  messages: [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage }
  ]
});
```

- Every request includes `reasoning_effort: "high"`
- No streaming — all responses are awaited in full

---

## Deliberation Flow

### Round 1 — Independent Answers (parallel)

1. All members are queried **in parallel** with:
   - **System prompt**: Default or custom member prompt (see Prompts section)
   - **User message**: The user's question verbatim

2. Status output during this phase:
   ```
   ⟳ Querying member "grok"...
   ⟳ Querying member "gpt"...
   ✓ Member "grok" responded (3.2s)
   ✓ Member "gpt" responded (5.1s)
   ```

3. If a member fails (timeout, API error, rate limit): log a warning, skip that member, continue with the rest.
   ```
   ✗ Member "gemini" failed: timeout after 120s — skipping
   ```

4. If `--no-revise` flag is set, skip round 2 and go directly to head synthesis.

### Round 2 — Revision (parallel)

1. All surviving members are queried **in parallel** with:
   - **System prompt**: Same as round 1
   - **User message**: A structured message containing:
     - The original question
     - This member's own initial response
     - All other members' initial responses (labeled by member id)
     - A prompt asking them to revise their answer if they see fit

2. Status output mirrors round 1 format.

3. Same failure handling — skip failed members.

### Round 3 — Head Synthesis

1. The head is queried with:
   - **System prompt**: Default or custom head prompt
   - **User message**: A structured message containing:
     - The original question
     - All members' final (revised) answers, labeled by member id

2. Status output:
   ```
   ⟳ Head is synthesizing final answer...
   ✓ Council deliberation complete
   ```

3. The head's response is printed to stdout.

---

## Prompts

### Default Member System Prompt

```
You are a member of an elite council of experts in software engineering, AI, coding, and technology. You have been selected for your deep expertise and independent thinking. Provide your best, most thoughtful answer to the question posed. Be specific, practical, and opinionated where appropriate.
```

### Default Member Revision Prompt (user message for round 2)

```
## Original Question
{question}

## Your Initial Response
{own_response}

## Other Council Members' Responses
### {member_id_1}
{response_1}

### {member_id_2}
{response_2}

---

You have now seen the other council members' responses. Revise your answer if you believe improvements are warranted based on points you may have missed or perspectives worth incorporating. If you stand by your original answer, you may restate it with any minor refinements. Provide your final, complete answer.
```

### Default Head System Prompt

```
You are the head of an elite council of experts in software engineering, AI, coding, and technology. Your role is to synthesize the council members' deliberated responses into a single, definitive answer. Identify the strongest points, resolve disagreements, and produce the best possible unified recommendation. Be clear, actionable, and comprehensive.
```

### Default Head Synthesis Prompt (user message for round 3)

```
## Original Question
{question}

## Council Members' Final Responses

### {member_id_1}
{response_1}

### {member_id_2}
{response_2}

---

Synthesize these responses into a single, definitive answer. Identify the strongest points across all members, resolve any disagreements, and produce the council's final recommendation.
```

---

## CLI Interface

```
council [options] [question]

Arguments:
  question          The question or request for the council (reads from stdin if omitted)

Options:
  --no-revise       Skip the revision round (round 2); go directly from initial answers to head synthesis
  --verbose         Show each member's final response before the head's synthesis
  --help            Show help
```

### Input Handling

1. If a positional argument is provided, use it as the question
2. If no argument and stdin is not a TTY (piped input), read stdin as the question
3. If no argument and stdin is a TTY, print usage and exit with error

### Output

- **Default**: Print only the head's final synthesized answer to stdout
- **--verbose**: Print each member's final answer (labeled by id) followed by the head's synthesis, separated by horizontal rules

### Exit Codes

- `0`: Success
- `1`: Config file missing or invalid
- `1`: No question provided
- `1`: All members failed (nothing to synthesize)

---

## Edge Cases & Error Handling

| Scenario | Behavior |
|---|---|
| Config file missing | Print error with expected path, exit 1 |
| Config file invalid JSON | Print parse error, exit 1 |
| No members configured | Print error, exit 1 |
| API key is `$VAR` but env var unset | Print error naming the var, exit 1 |
| Single member fails | Log warning, continue with remaining |
| All members fail in round 1 | Print error, exit 1 |
| Some members fail in round 2 | Use their round 1 answer as fallback for head synthesis |
| Head fails | Print error with details, exit 1 |
| Empty question | Print usage, exit 1 |

---

## Dependencies

```json
{
  "dependencies": {
    "openai": "^4"
  }
}
```

Minimal dependency footprint — only the OpenAI SDK.

---

## Open Questions / Future Considerations

- **Session history**: Could add `--save` to persist deliberations to `~/.council/history/`
- **Cost tracking**: Could estimate token costs per run based on model pricing
- **Custom roles**: Members could have specialization labels (e.g., "security expert", "performance expert") injected into their prompts
- **Multi-turn**: Could support follow-up questions in the same council session
- **Config profiles**: Support multiple config files for different council compositions
