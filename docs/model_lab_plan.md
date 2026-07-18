# Ghost Model Lab: fine-tuning + benchmarking pipeline (v1, manual)

> Status: approved plan, not yet implemented. Drafted 2026-07-14.
> **Reconciled 2026-07-18** against the Tier-1 agent work
> ([UNSLOTH_TIER1_PLAN.md](UNSLOTH_TIER1_PLAN.md), now implemented). The design
> holds; several code references it was written against no longer exist, and are
> corrected below. Changes are marked **[reconciled]**.

## Context

Ghost's next major addition: fine-tune local models and benchmark them, driven from the Ghost app. The Unsloth Studio backend Ghost connects to turns out to be a full training server with a REST API, so the training half is orchestration, not ML plumbing.

**[reconciled]** This was written expecting `apps/server/src/agent/unsloth.ts` and its `unsloth connect` handshake from the `feat/ai-sidebar-unsloth` branch. That branch was never merged — the Tier-1 plan dropped the handshake as unnecessary on the OpenAI seam — so **that file does not exist**. Studio credentials now come from environment configuration in [apps/server/src/agent/UnslothEngine.ts](../apps/server/src/agent/UnslothEngine.ts): `UNSLOTH_BASE_URL`, `UNSLOTH_API_KEY`, `UNSLOTH_MODEL`. The Model Lab reads the same three variables rather than shelling out to the CLI. This is strictly simpler and removes the CLI from the runtime dependency set; the only thing lost is auto-discovery of the key, which the operator now pastes into `.env` once. Benchmarking has no Studio support, so Ghost drives EleutherAI's `lm-evaluation-harness` as a subprocess against Studio's OpenAI-compatible endpoint.

**Decisions:**

- Harness: `lm-evaluation-harness` (Python CLI, spawned by Ghost server, JSON results parsed).
- Scope: manual pipeline first (buttons + job tracking + history). Automation later.
- UI: a "Model Lab" workspace module registered like existing modules.
- Benchmark depth: fixed-seed subsets (~100–200 samples/task) by default, full runs optional. Scores labeled as subset scores.

## Verified facts the design depends on

(Confirmed by reading the Unsloth Studio backend source, `studio/backend` in the unsloth repo.)

1. **Auth**: the `sk-unsloth-*` key is an **unscoped admin API key**; it works on `/api/train/*`, `/api/datasets/*`, `/api/export/*`, and `/v1/*` alike. This is the fact the whole design leans on and it still holds — one key covers training and inference. **[reconciled]** ~~Ghost's existing `getConnection()` already obtains it~~ — there is no `getConnection()`. Read `UNSLOTH_API_KEY` from the environment, the same value `UnslothEngine` already uses for `/v1`. Obtain it once from `unsloth run`'s console output or Studio → Settings → API.
2. **Training routes** (prefix `/api/train`): `POST /start` (payload `TrainingStartRequest`: `model_name`, `training_type: "LoRA/QLoRA"`, `format_type`, `learning_rate`, `batch_size`, `hf_dataset` or `local_datasets: [path]`, `max_steps`/`num_epochs`, LoRA fields with sane defaults), `GET /status`, `GET /progress` (**SSE**: `progress`/`heartbeat`/`complete`/`error` events with step/loss/eta), `GET /metrics`, `POST /stop`, `GET /runs`, `GET /runs/{id}`.
3. **One training run at a time** (Studio enforces it; second `/start` returns `status:"error"`). Starting training may **evict the loaded inference model** if VRAM is tight (12 GB TITAN Xp: assume it will).
4. **Datasets**: `POST /api/datasets/upload` (multipart; `.csv/.json/.jsonl/.parquet`) → `{stored_path}` → pass in `local_datasets`. Or pass an HF repo id via `hf_dataset`. `POST /api/datasets/check-format` validates before training.
5. **Export**: two-step — `POST /api/export/load-checkpoint {checkpoint_path: <run output_dir>}`, then `POST /api/export/gguf {save_directory, quantization_method:"Q4_K_M"}`. Progress via `GET /api/export/status` + `/api/export/logs/stream` (SSE).
6. **Benchmark endpoint constraints**: `/v1/chat/completions` works for any loaded model but **rejects `logprobs`**. `/v1/completions` is a passthrough to llama-server and **only works with a GGUF model loaded** (llama.cpp supports logprobs). Consequence:
   - Primary path: benchmark the **exported GGUF** via `local-completions`/`local-chat-completions`.
   - Use **generative task variants** (CoT + answer extraction) which don't need logprobs: `mmlu_pro` (generative CoT in lm-eval), `gpqa_*_cot_zeroshot`, `bbh_cot_fewshot`, `ifeval`, `gsm8k`, `math_hard`. MuSR is loglikelihood-only → include only if the GGUF `/v1/completions` logprobs path proves out during implementation; otherwise drop it.
7. Hardware: the **server host's** GPU — TITAN Xp 12 GB, **Pascal** (no bf16,
   fp16 only) — constrains v1 to ≤8B models, QLoRA only, `load_in_4bit: true`.
   **[resolved 2026-07-18]** Studio runs on the **Ghost server host**, the
   machine with the powerful GPU, and is reached *only* through the server. A
   development laptop's GPU (this one reports a GTX 970M 3 GB) is irrelevant to
   this constraint: it never runs Studio. Confirm the server host's actual card
   at deploy time, since it sets the model-size ceiling for the whole plan.

## Deployment topology (decided)

Studio is **co-located with the Ghost server** on the GPU host, and every client
reaches it *through* the server. This is the same shape the Tier-1 agent already
takes, and the reasons compound:

- **The GPU is where the model must be.** Powerful models cannot run on a
  laptop or a phone; the server host is the only machine with the hardware.
- **The Studio admin key never leaves the server.** It is an *unscoped* key
  (fact 1) — it can start training jobs and write files. Shipping it to a
  browser would put full training control in every client. `UNSLOTH_API_KEY` is
  server-side configuration and no client ever sees it.
- **One reachable surface.** Clients talk to `/agent/*` and `/lab/*` behind the
  server's own auth gate; Studio's port need not be exposed to the LAN at all.
- **Tools run beside the model.** The Tier-1 server-store decision
  ([UNSLOTH_TIER1_PLAN.md](UNSLOTH_TIER1_PLAN.md) §2) already puts tool
  execution in-process with the model. Training and benchmarking land on the
  same host for the same reason.

**Rule this implies:** no client-side code ever holds a Studio URL or key.
`RemoteEngine` already obeys this — it knows only the Ghost server. Model Lab's
UI must too: it talks to `/lab/*`, never to Studio.

## Architecture

```
Model Lab module (web)  ──REST + SSE──▶  Ghost server /lab/* routes
                                             │
                              ┌──────────────┼──────────────────┐
                              ▼              ▼                  ▼
                       Studio REST      lm-eval subprocess   SQLite (jobs,
                       (/api/train,     (local-chat-         runs, scores)
                       /datasets,        completions →
                       /export, /v1)     Studio /v1)
```

Ghost server owns: the Studio bearer, a **job record** per pipeline stage (SQLite), SSE relay of progress to the client, and lm-eval spawning + result parsing. The client stays a thin shell, same as `useAgent`/`useTasks`.

## Implementation

### M1 — Shared contracts + server plumbing

- `packages/shared/src/validation/lab.ts`: Zod schemas for the wire — `FinetuneRequest` (model id, dataset source `{kind:"hf",id}|{kind:"upload"}`, hyperparams subset: lr, epochs/max_steps, lora_r), `LabJob` (`id, kind: finetune|export|benchmark, state: queued|running|done|failed, progress, error, createdAt`), `BenchmarkRequest` (model ref, suite, samplesPerTask), `BenchmarkResult` (per-task scores + metadata: model, suite version, samples, seed, duration). Export from `packages/shared/src/index.ts` alongside the existing agent schemas.
- `apps/server/src/lab/studio.ts`: typed Studio client; thin `fetch` wrappers for the train/dataset/export routes above. **[reconciled]** For the bearer, read `UNSLOTH_API_KEY`/`UNSLOTH_BASE_URL` from the environment — the same source [agent/UnslothEngine.ts](../apps/server/src/agent/UnslothEngine.ts) uses, so inference and training can never end up pointed at different Studios. Note Studio's convention that the header is *omitted entirely* when no key is set, rather than sent empty.
- `apps/server/src/lab/jobs.ts`: job table + helpers in the existing better-sqlite3 db ([apps/server/src/db.ts](../apps/server/src/db.ts) pattern). Tables: `lab_jobs`, `lab_runs` (fine-tune runs: base model, dataset, hyperparams, output_dir, gguf_path), `lab_scores` (benchmark results keyed by model ref + suite + samples).
- Routes in a new `apps/server/src/lab/routes.ts` registered from `main.ts` (mirror `registerTaskSyncRoutes`): `POST /lab/finetune`, `POST /lab/datasets/upload` (multipart proxy to Studio), `POST /lab/export`, `POST /lab/benchmark`, `GET /lab/jobs`, `GET /lab/jobs/:id/events` (SSE relay), `GET /lab/runs`, `GET /lab/scores`.
- **[reconciled]** The SSE write pattern now lives in [agent/routes.ts](../apps/server/src/agent/routes.ts), not `main.ts` — copy `send()` and the `req.raw.on("close")` abort wiring from `POST /agent/chat`.
- **[reconciled — new requirement]** These routes must sit behind the **same gate** as the agent routes (`requireAuth` in `agent/routes.ts`: bearer token when `GHOST_AGENT_TOKEN` is set, loopback only otherwise). `/lab/*` is a strictly more dangerous actuator than `/agent/chat` — it spawns training jobs, writes files, and can evict the loaded model. It must never be the one unauthenticated endpoint on the box. Factor `requireAuth` out of `agent/routes.ts` into something both can import.

### M2 — Fine-tune + export flow (server)

- `POST /lab/finetune`: validate → create job → Studio `POST /api/train/start` (map our request onto `TrainingStartRequest`; force `training_type:"LoRA/QLoRA"`, `load_in_4bit:true`) → subscribe to Studio's `GET /api/train/progress` SSE and mirror events into the job record + client SSE. Handle the "already training" error as a 409.
- On `complete`: fetch `GET /api/train/runs` for the run's `output_dir`, store in `lab_runs`.
- `POST /lab/export`: `load-checkpoint` with the run's `output_dir` → `export/gguf` → poll `/api/export/status` → store `gguf_path`.

### M3 — Benchmark runner (server)

**Two suite families, both first-class (decided 2026-07-18).** A model is judged
on how it performs *everywhere* and how it performs *here*. These answer
different questions and neither substitutes for the other:

| | **General** (`lm-eval`) | **Personal** (Ghost tool-calling) |
|---|---|---|
| Question | How capable is this model at all? | Does it work as *my* assistant? |
| Source | EleutherAI academic suites | `packages/shared/src/eval`, the shipped tool contracts |
| Comparable to | Public leaderboard numbers | Only to Ghost's own history |
| Runs as | Spawned `lm_eval` Python subprocess | **In-process TypeScript** — the logic is already pure and imported |
| Catches | Reasoning/knowledge regressions | Wrong tool, bad args, firing during chit-chat |

The asymmetry in *how they run* is worth keeping: the general suite is a
subprocess because lm-eval is Python; the personal suite is a direct function
call because `scoreCase`/`summarize` are pure TypeScript in the shared package.
No subprocess, no Python, no drift from the specs the app ships.

**Do not average them into one score.** A model can gain five points of MMLU
while getting worse at calling `create_task`. They are reported side by side,
always, and a promotion decision needs both to hold.

**Storage.** `lab_scores` carries a `suite_kind: "general" | "personal"`
discriminator so both families share one history table and one comparison view.
The personal family's existing `BenchmarkRecord`
(`packages/shared/src/eval/scoring.ts`) is already the right shape — reuse it
rather than inventing a second one, and keep `bench/results.jsonl` working as
the no-server path for a quick local check.

- `apps/server/src/lab/benchmark.ts`: spawn `lm_eval --model local-chat-completions --model_args model=<id>,base_url=<studio>/v1/chat/completions,num_concurrent=1,max_retries=3 --tasks <suite> --limit <samples> --seed 42 --apply_chat_template --output_path <scratch>` with `OPENAI_API_KEY=<studio bearer>`. **[reconciled]** There is no `runConnect()` to mirror — no subprocess spawning exists in the server today, so this is net-new rather than a copy. Use `node:child_process.spawn` with the job's abort signal wired to `kill()`, matching how `POST /agent/chat` cancels an in-flight turn on client disconnect.
- Default general suite `general-v1`: `ifeval, gsm8k, mmlu_pro, bbh_cot_fewshot, gpqa_main_cot_zeroshot, math_hard` (drop/flag MuSR per fact 6). Suite defined as data in shared package so UI and server agree.
- Precondition check before spawning: the target model must be loaded in Studio (`/api/inference/status`); load the GGUF if needed. Refuse to start while a training job is running (VRAM eviction).
- Parse lm-eval's `results.json`, persist per-task scores to `lab_scores`, stream stdout lines as SSE progress.
- One-time setup documented + checked at runtime: `pip install lm-eval` available on PATH; `GET /lab/status` reports `lm_eval` presence. **[reconciled]** `AgentStatus` does *not* report CLI presence — it is `stopped | no_model | ready`, derived from probing `/v1/models`, and reports nothing about any CLI. Model Lab needs its own status shape. Keep it honest in the same way: report what was actually probed, and do not report "ready" off something merely installed but not runnable (the exact bug fixed in `OpenAiEngine.getStatus`, where Studio lists downloaded-but-unloaded models).

### M4 — Model Lab UI (web)

- `apps/web/src/modules/lab/`: `LabModule.tsx` registered in [workspace/registry.ts](../apps/web/src/workspace/registry.ts) (one entry, per the module pattern). Three tabs inside the card:
  1. **Fine-tune**: base-model picker (from Studio `/api/models/local` via server), dataset (HF id or file upload), minimal hyperparams, start button, live loss/progress (SSE).
  2. **Runs**: past runs from `/lab/runs`, export-to-GGUF button per run.
  3. **Benchmarks**: pick model (base or fine-tuned GGUF) + suite, run, live progress; results table comparing scores across models/runs, subset size labeled on every score.
- `apps/web/src/modules/lab/useLab.ts`: SSE client hook. **[reconciled]** The path is [modules/agent/useAgent.ts](../apps/web/src/modules/agent/useAgent.ts), and that hook holds no frame parser — it is UI state only. The SSE frame parser lives in [engine/RemoteEngine.ts](../apps/web/src/engine/RemoteEngine.ts) as `readFrames()`, which already handles frames split across chunk boundaries. Reuse or extract that rather than hand-rolling a third parser.

## Explicitly out of scope (v1)

- Scheduled/automatic retraining, auto-promotion, regression gates.
- ~~App-specific tool-calling benchmark suite~~ — **promoted into v1** (decided
  2026-07-18); see M3. The blocker named here (an agent tool registry) is gone,
  and the suite already exists in `packages/shared/src/eval` — see
  [EVAL.md](EVAL.md). Its fine-tune companion `bench/trainset.jsonl` can feed
  the training step directly as a `local_datasets` entry, since it is already
  emitted in the chat format Studio's SFT trainer reads.
- Still out of scope: a **BFCL-style multi-turn** tool suite. Today's personal
  suite grades one turn, so it cannot see loop-level faults — a live run had a
  1.5B model call `create_task` twice and create a duplicate task, which scores
  as a clean pass. This needs the audit log, which does not exist.
- Training-data generation from agent usage (audit log doesn't exist yet).
- Multi-GPU, non-QLoRA training, >8B models.

## Risks / open items to resolve during implementation

- **lm-eval vs chat endpoint**: generative variants should work over `local-chat-completions`, but exact task names/versions must be confirmed against the installed lm-eval release; fall back to GGUF + `local-completions` (logprobs) if a chosen task turns out loglikelihood-only.
- **Pascal fp16**: some Unsloth model configs assume bf16; if a chosen base model fails, pick fp16-safe ones (Qwen/Llama ≤8B are known-good).
- Long-running SSE relays across server restarts: jobs table is the source of truth; on reconnect, resubscribe to Studio's `Last-Event-ID`-capable progress stream.

## Verification

1. `pnpm dev`, Studio running with a small model (e.g. Llama-3.2-1B-Instruct).
2. Fine-tune a 1B model on a tiny HF dataset (e.g. 100 rows, `max_steps: 20`) from the Model Lab card; watch live loss; confirm run appears in Runs tab and `lab_runs`.
3. Export the run to GGUF; confirm `gguf_path` recorded and the file exists.
4. Run `general-v1` benchmark with `--limit 20` against the base model, then the fine-tuned GGUF; confirm two comparable score rows render side by side.
5. Kill the server mid-training, restart, confirm the job resumes reporting via Studio status rather than orphaning.
6. Negative paths: start a second fine-tune while one runs (expect 409 in UI), run benchmark with Studio stopped (expect honest status pill, mirroring `AgentStatus`).

## Benchmark sources

- Open LLM Leaderboard v2 suite (MMLU-Pro, GPQA, BBH, IFEval, MATH, MuSR): <https://aistoollab.com/en/open-llm-leaderboard-2026-which-scores-matter/>, <https://llm-stats.com/benchmarks>
- lm-evaluation-harness API evaluation guide (local-completions / local-chat-completions, logprobs limitation): <https://github.com/EleutherAI/lm-evaluation-harness/blob/main/docs/API_guide.md>
