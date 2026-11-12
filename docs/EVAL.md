# Penumbra: Evaluation

How a model is measured as Penumbra's agent, and how a run seeds a fine-tune.
Cases, scoring, and trainset logic live in `packages/shared/src/eval`, beside
the tool contracts, so the eval cannot drift from what the app ships.

## What is measured

One turn: does the request produce the **right tool call with the right
arguments**, and **no** tool call during conversation? Tools are not executed.

| Metric | Notes |
|---|---|
| Tool-selection accuracy | The headline. |
| False positives | Tool called on chit-chat. The worst failure: an uninvited write. |
| False negatives | Prose when asked to act. Annoying, not destructive. |
| Arg JSON validity | |
| Arg correctness (spot) | Deterministic slots only (priority, status). |
| Latency | Tier 0 runs on the user's CPU. |

Not covered: multi-step loops (a single-turn pass can hide a duplicate
`create_task` in a live loop), tool execution (store tests), answer quality.

## Running it

```bash
pnpm tool-eval            # bundled llama-server on :8080, Tier 0 tools
TIER=1 pnpm tool-eval     # adds the Model Lab tools under the server prompt
LLM_URL=http://gpu-host:8888 MODEL=gpt-oss-20b API_KEY=sk-unsloth-… LABEL=studio pnpm tool-eval
```

| Variable | Default | Purpose |
|---|---|---|
| `LLM_URL` | `http://127.0.0.1:8080` | Any OpenAI-compatible server |
| `MODEL` | `qwen3-1.7b` | Model id |
| `API_KEY` | none | Bearer, when set |
| `LABEL` | none | Names the run |
| `BENCH_DIR` | `bench` | Output dir (git-ignored) |
| `TIER` | `0` | `1` adds the lab contracts |

Each run appends to `bench/results.jsonl`; the tier is recorded in the label
because the two tiers are not comparable.

## The two tool sets

- `TIER=0`: the five `agentTools`, scored on `evalCases`.
- `TIER=1`: those plus the six `labTools`, under `AGENT_POLICY` + `LAB_POLICY`,
  scored on `evalCases` **and** `labEvalCases`.

Tier 1 reruns the base cases so the cost of extra tools shows up: compare its
base rows against a Tier 0 run. `eval.test.ts` fails if a lab tool has no
positive case. `labEvalCases` targets crossovers (lab vocabulary that should
still reach `create_task`, lab tools that read alike) and negatives drawn from
the lab's own subject matter. Arguments are asserted only where the utterance
states them and the contract default would be wrong.

## Training data

The same run writes `bench/trainset.jsonl` (OpenAI chat format) by rejection
sampling: only turns the model got right. The rest go to
`bench/trainset-todo.json` with a reason, as the hand-labeling worklist. A wrong
turn is never emitted. The main use is distillation: run against a large Tier 1
model, train the small Tier 0 one on what it got right.

## Benchmark suites

The Model Lab runs two families, reported side by side and **never averaged**,
since a model can gain reasoning while getting worse at calling tools.

- **General**: `lm-evaluation-harness` as a subprocess (`general-v1`).
- **Personal**: the cases above, scored in-process on the server.

| Suite | Advertises | Scores |
|---|---|---|
| `penumbra-tools-v2` | 5 base contracts | `evalCases` |
| `penumbra-lab-v1` | plus 6 lab contracts, under `LAB_POLICY` | `evalCases` + `labEvalCases` |

`LAB_TOOL_SUITES` picks tools and prompt together from the suite id. If a case
set changes, bump the suite id instead of changing what old rows meant.

**`penumbra-tools-v1` rows**: v1 sampled a capped run by prefix, and at the
default 20 of 33 cases that skipped every negative. Its `false_positives` is
unmeasured wherever `samplesPerTask` was below the full set, and its selection
scores are not comparable to v2. v2 samples across the whole set.

## Installing lm-eval

Optional; detected at runtime and reported by `GET /lab/status`. The `[api]`
extra is required (plain `lm-eval` fails at run time on a missing `tenacity`),
and the default suite's tasks need their own extras:

```bash
python3 -m venv .venv-lmeval
.venv-lmeval/bin/pip install 'lm-eval[api,ifeval,math]'
LM_EVAL_BIN=$PWD/.venv-lmeval/bin/lm_eval pnpm --filter @penumbra/server dev
```
