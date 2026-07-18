# Penumbra — Evaluation, Benchmarking, and Finetuning

How Penumbra measures whether a model is good enough to be its agent, and how a
benchmark run doubles as the seed for finetuning one. Companion to
[AGENT_DESIGN.md](AGENT_DESIGN.md) §7 and [UNSLOTH_TIER1_PLAN.md](UNSLOTH_TIER1_PLAN.md).

Present tense means it exists in the repo today.

---

## 1. What is measured

The agent's usefulness rests on one skill: turning a natural request into the
**right tool call with the right arguments**, and *not* calling a tool during
ordinary conversation. `pnpm tool-eval` measures exactly that. It does not
execute tools — it grades what the model emits.

The cases, the scoring, and the training-set logic live in
`packages/shared/src/eval`, beside the tool contracts. That placement is the
point: the eval imports the same specs and system prompt the app ships, so it
cannot drift from the product, and the metrics are unit-tested without needing
a model.

| Metric | Why it is separate |
|---|---|
| Tool-selection accuracy | The headline: did it pick the right action? |
| False positives | Called a tool during chit-chat. The worst failure — it writes to the user's data uninvited. |
| False negatives | Answered in prose when asked to act. Annoying, not destructive. |
| Arg JSON validity | A call whose arguments do not parse is a wasted turn. |
| Arg correctness (spot) | Only deterministic slots (priority, status). Titles vary in casing and phrasing, so selection is the signal. |
| Latency | Tier 0 runs on the user's CPU; a correct answer that takes 25s is still a bad experience. |

## 2. Running it

```bash
# Tier 0 — the bundled llama-server + GGUF
pnpm tool-eval

# Tier 1 — Unsloth Studio
LLM_URL=http://gpu-host:8888 MODEL=gpt-oss-20b API_KEY=sk-unsloth-… \
  LABEL=studio-baseline pnpm tool-eval
```

| Variable | Default | Purpose |
|---|---|---|
| `LLM_URL` | `http://127.0.0.1:8080` | Any OpenAI-compatible server |
| `MODEL` | `qwen3-1.7b` | Model id sent with the request |
| `API_KEY` | — | Sent as a bearer token when set |
| `LABEL` | — | Names the run in the results log |
| `BENCH_DIR` | `bench` | Where artifacts are written (git-ignored) |

Each run **appends** to `bench/results.jsonl`. The value of a benchmark is the
trend across models and finetunes, not one number, so runs are never
overwritten.

### A recorded baseline

Qwen2.5-1.5B-Instruct Q4_K_M, CPU-only, the bundled Tier-0 model:

```
Tool-selection accuracy : 25/26 (96%)
False positives         : 0
False negatives         : 0
Arg JSON validity       : 18/18 calls
Arg correctness (spot)  : 5/5 checked
Latency                 : avg 14194ms, max 24472ms
```

Selection is already strong; **latency is the reason Tier 1 exists**. Fourteen
seconds per turn is not a usable assistant, and that is a hardware and
model-size problem rather than a prompt problem.

## 3. Finetuning: the run is the dataset

The same run writes `bench/trainset.jsonl` — OpenAI chat-format rows, the shape
Unsloth's SFT trainer reads. It is built by **rejection sampling**: only turns
the model got right become training examples. Everything else lands in
`bench/trainset-todo.json` with a reason, which is the hand-labeling worklist.

Be honest about what this is worth. Training a model on its own correct outputs
teaches *that model* very little. The scaffold is useful for three things:

1. **Distillation** — capture a large model's behavior and train a small one on
   it. That is precisely the Tier-1 → Tier-0 relationship: run the eval against
   Studio, train the embedded model on what Studio got right.
2. **Regression pinning** — a fixed set of known-good turns to check a finetune
   against.
3. **A seed with its gaps marked** — the `todo` file is exactly the set of
   utterances worth labeling by hand, because they are the ones the model
   cannot already do.

A wrong turn is never emitted as training data; teaching a model its own
mistakes is worse than not training at all.

## 4. Where this sits in the bigger picture

This is the **personal** half of a two-family benchmark
([model_lab_plan.md](model_lab_plan.md) M3): it grades the model on Penumbra's own
job. The **general** half runs academic suites via `lm-evaluation-harness` and
grades raw capability. Both are first-class, and they are never averaged
together — a model can gain reasoning ability while getting worse at calling
`create_task`, and a single blended number would hide exactly that.

A useful property of this half: because scoring is pure TypeScript in
`@penumbra/shared`, the server can run it **in-process** as a Model Lab job. No
Python, no subprocess, and no way for the benchmark to drift from the tool specs
the app actually ships.

## 5. Running the general suite

`lm-evaluation-harness` is an **optional** dependency, detected at runtime and
reported by `GET /lab/status`. Install it into a venv rather than system Python:

```bash
python3 -m venv .venv-lmeval
.venv-lmeval/bin/pip install 'lm-eval[api]'
LM_EVAL_BIN=$PWD/.venv-lmeval/bin/lm_eval pnpm --filter @penumbra/server dev
```

**The `[api]` extra is required, not optional.** A plain `pip install lm-eval`
installs fine and then fails at run time with
`ModuleNotFoundError: ... ['tenacity']` the moment an API model is used — which
is our only mode, since we benchmark over an OpenAI-compatible endpoint rather
than loading weights in-process. Verified the hard way against a live run.

## 6. What this does not cover

- **Multi-step loops.** The eval grades one turn. It does not catch loop-level
  failures — a live Tier-1 run had the 1.5B model call `create_task` twice for
  one request and create a duplicate task, which a single-turn eval scores as a
  clean pass. Multi-step behavior is graded by the engine tests and, ultimately,
  by using it.
- **Tool execution.** Whether a call *succeeds* is the store's business and is
  covered by `apps/server/src/agent/tools.test.ts` and the client equivalent.
- **Answer quality.** Nothing here grades prose beyond "did it correctly decline
  to call a tool".
