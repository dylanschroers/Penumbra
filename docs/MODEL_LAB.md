# Penumbra: Model Lab

Fine-tuning, export, and benchmarking from the app. Unsloth Studio does the ML;
Penumbra drives it, keeps a durable record of each job, and keeps the Studio key
away from clients. What the benchmarks measure is in [EVAL.md](EVAL.md).

## Deployment topology

Clients never talk to Studio. The Lab module calls the server's `/lab/*` and
`/compute/*`, and the server holds every Studio URL and key. The main Studio is
co-located with the server on the GPU host; a Colab Studio can be added as a
second target over a tunnel (see Compute targets).

```
Model Lab (web) --REST--> Penumbra server /lab/*, /compute/*
                              ├─> Studio REST (/api/train, /api/export, /api/inference, /v1)
                              ├─> lm_eval subprocess -> Studio /v1
                              └─> SQLite: lab_jobs, lab_runs, lab_scores
```

**Rule:** no client-side code ever holds a Studio URL or key.

## What Studio guarantees

Read from `studio/backend` in the Unsloth repo, corrected by live runs.

1. **Auth.** `sk-unsloth-*` is an unscoped admin key: training, datasets,
   export, and inference alike. With no key set, omit the header; an empty
   bearer is rejected.
2. **Training** (`/api/train`): `POST /start`, `GET /status`, `GET /progress`
   (SSE: `progress` / `heartbeat` / `complete` / `error`), `GET /metrics`,
   `POST /stop`, `GET /runs`, `GET /runs/{id}`.
3. **One training run at a time.** A second `/start` returns `status: "error"`
   with a 2xx. Training may evict the loaded inference model.
4. **Datasets.** `POST /api/datasets/upload` exists; Penumbra uses its own
   upload route instead (see Uploads).
5. **Export is two-step**: `POST /api/export/load-checkpoint`, then
   `POST /api/export/export/gguf` (the doubled segment is real;
   `/api/export/gguf` answers 405). There is no status to poll: done means not
   active and the op counter moved, so take a baseline right before exporting.
6. **`/v1/chat/completions` rejects `logprobs`; `/v1/completions` works only
   with a GGUF loaded.** So multiple-choice benchmarks cannot run over chat.
7. **`/v1/models` may list unloaded models**, with `loaded: true|false`.
   `getStatus()` prefers a `loaded: true` entry and falls back to `data[0]` when
   no entry has the flag (llama-server and newer Studio builds list only
   resident models).
8. **`/v1/models` is authoritative, not the inventory.** `/api/hub/local` scans
   disk, so a model loaded from a checkpoint dir can be served but unlisted
   (routine on Colab). Resident models are always offered; a failed inventory
   reports `inventoryError`.
9. **A load holds its connection until the weights are resident**, which a Colab
   tunnel usually cuts at about 100s. A dropped socket is not a verdict: poll
   `/api/inference/status` and `/api/inference/load-progress`, and fail only
   once Studio is idle with nothing new loaded. A 4xx or 500 from Studio is a
   real verdict.
10. **Never send `enable_tools` or `mcp_enabled`.** Either makes Studio run its
    own tool loop and silently drop Penumbra's tools. A test pins this.

## Hardware ceiling

The reference host is a TITAN Xp 12 GB: Pascal, fp16 only, no bf16. Training is
QLoRA (`load_in_4bit: true`) on models of about 8B or less. If a base model
fails to start, it likely assumes bf16; Qwen and Llama at 8B or below work.

## Suites

- **General** spawns `lm_eval` against Studio's OpenAI-compatible endpoint.
- **Personal** runs in-process from `packages/shared/src/eval`.

lm-eval task names are version-sensitive (checked on 0.4.12): leaderboard tasks
need the `leaderboard_` prefix, and `leaderboard_mmlu_pro`, `leaderboard_bbh`,
and `leaderboard_gpqa` are multiple-choice, so they fail over chat (fact 6).
`general-v1` is generative-only: `gsm8k`, `leaderboard_ifeval`,
`leaderboard_math_hard`. Install notes: [EVAL.md](EVAL.md) → Installing lm-eval.

## Uploads

A path picked on a laptop means nothing on the GPU host, so `/lab/upload`
streams files in chunks into `PENUMBRA_UPLOAD_DIR` and the fine-tune passes
Studio that path. For a model directory, `/lab/models/plan` returns only the
files the host is missing. The client names the destination, so `resolveDest`
must reject unknown kinds, absolute paths, and `..` escapes.

## Job records

Jobs return an id immediately and report progress by polling; the job row, not
the connection, is the source of truth. `lab/progress.ts` parses lm-eval's tqdm
output and the personal suite's case count into `{progress, detail}`.

Two failure modes that once gave silently wrong results:

- **The progress stream is not the verdict.** A stream that ends without
  `complete` is a failed run (Studio restart, tunnel drop), but `complete` is
  not success either: Studio emits it whenever training stops, crashes
  included. The outcome comes from the run record's status.
- **Output dirs come only from Studio's runs list.** Runs are snapshotted
  before training starts so the new one is identifiable. If none appears,
  nothing is recorded and export refuses the run.

## Driving it from chat

Tier 1 binds `labTools`: `list_models`, `list_datasets`, `start_finetune`,
`run_benchmark`, `job_status`, `lab_history`.

- **One orchestration.** `registerLabRoutes` returns its operations and the agent
  binds that object, so chat and UI share one `inFlight` map and Cancel works on
  jobs started from chat.
- **A job id is the answer.** Starting work never returns a result;
  `LAB_POLICY` says so and forbids reporting scores no tool returned.
- `job_status` reads `lab_jobs`; `lab_history` reads `lab_runs` or `lab_scores`
  via its `what` slot (one tool, not two, to keep the tool count down).
- Tool arguments reuse the route schemas. Everything else (learning rate, LoRA
  rank, dataset format) stays at its default.

## Compute targets

Two Studios: **local** (address and key from env, overridable from the panel)
and **Colab** (a tunnel address pasted into the panel). Both persist. Configured
under `/compute/*` because chat uses them too.

- **Roles.** `chat` and `benchmark` each name a target. The response gives both
  the assignment and what it resolves to, since a Colab target can disappear.
  `effective()` knows only what is configured, not reachable, so a role on a
  dead tunnel stays there until reassigned.
- **Training** picks per run via `finetuneRequest.provider`; `auto` prefers
  local and probes Colab before falling back.
- **Export** follows `lab_runs.provider`, since the checkpoint lives on the
  machine that trained it. An ended Colab session gets a 409.
- Chat and benchmark on the same GPU contend: a benchmark evicts the chat model.

**Colab's own `colab.googleusercontent.com` link does not work.** It needs the
notebook's browser session and returns Google's sign-in page with a 200. The
probe checks that `/v1/models` returns a real listing and reports `not_studio`
otherwise. Use a cloudflared or ngrok tunnel to port 8888, with a Studio key set
(a public keyless tunnel is an open GPU).

**Loading** (`POST /compute/targets/:id/load`) accepts any id, not just
inventory rows: a fresh Colab has an empty disk, and Studio fetches unknown ids
from HuggingFace. What ends up loaded is read back from Studio (fact 9).
