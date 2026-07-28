# Penumbra — Model Lab

Fine-tuning, exporting, and benchmarking models from inside the app. Companion
to [ARCHITECTURE.md](ARCHITECTURE.md); [EVAL.md](EVAL.md) covers what the
benchmarks measure and how to read them. Same convention as the rest of the
docs: present tense means it exists in the repo.

The Lab is orchestration, not ML plumbing. Unsloth Studio is a full training
server with a REST API, so Penumbra's job is to drive it, keep a durable record
of every job, and never let the client near the credential.

## Deployment topology

Studio is **co-located with the Penumbra server** on the GPU host, and every
client reaches it *through* the server. Four reasons, and they compound:

- **The GPU is where the model must be.** Powerful models cannot run on a laptop
  or a phone; the server host is the only machine with the hardware.
- **The Studio key never leaves the server.** It is an *unscoped admin* key (see
  below) — it can start training jobs and write files. Shipping it to a browser
  would hand full training control to every client. `UNSLOTH_API_KEY` is
  server-side configuration and no client ever sees it.
- **One reachable surface.** Clients talk to `/agent/*` and `/lab/*` behind the
  server's own auth gate; Studio's port need not be exposed to the LAN at all.
- **Tools run beside the model.** The server-side agent already executes tools
  in-process with the model. Training and benchmarking land on the same host for
  the same reason.

**The rule this implies:** no client-side code ever holds a Studio URL or key.
`RemoteEngine` obeys it — it knows only the Penumbra server. The Lab's UI obeys
it too: it talks to `/lab/*`, never to Studio.

```
Model Lab module (web)  --REST + SSE-->  Penumbra server /lab/* routes
                                             |
                              +--------------+------------------+
                              v              v                  v
                       Studio REST      lm-eval subprocess   SQLite (jobs,
                       (/api/train,     (local-chat-         runs, scores)
                       /datasets,        completions ->
                       /export, /v1)     Studio /v1)
```

The server owns the Studio bearer, a job record per pipeline stage, progress
relay to the client, and lm-eval spawning plus result parsing. The client stays
a thin shell.

## What Studio guarantees

Confirmed by reading `studio/backend` in the Unsloth repo, then corrected by
live runs where the two disagreed. These are the facts the design leans on.

1. **Auth.** The `sk-unsloth-*` key is an **unscoped admin API key** — it works
   on `/api/train/*`, `/api/datasets/*`, `/api/export/*`, and `/v1/*` alike. One
   key covers training and inference, which is exactly why it stays server-side.
   Studio's convention is that the header is *omitted entirely* when no key is
   set, rather than sent empty; an empty bearer is rejected as malformed.
2. **Training** (prefix `/api/train`): `POST /start`, `GET /status`,
   `GET /progress` (SSE: `progress` / `heartbeat` / `complete` / `error` with
   step, loss, eta), `GET /metrics`, `POST /stop`, `GET /runs`, `GET /runs/{id}`.
3. **One training run at a time.** Studio enforces it, and answers a second
   `/start` with `status: "error"` rather than a non-2xx. Starting training may
   **evict the loaded inference model** if VRAM is tight.
4. **Datasets.** `POST /api/datasets/upload` (multipart; `.csv/.json/.jsonl/.parquet`)
   returns `{stored_path}` for use in `local_datasets`; or pass an HF repo id as
   `hf_dataset`. Penumbra does not use this route — see Uploads below.
5. **Export is two-step.** `POST /api/export/load-checkpoint` with the run's
   output dir, then `POST /api/export/gguf` with a save directory and
   quantization. There is no `status` field to poll: settled means *not active,
   and the op counter moved*, so a baseline has to be taken immediately before
   the export or an earlier success reads as this one's.
6. **Benchmark endpoint constraints.** `/v1/chat/completions` works for any
   loaded model but **rejects `logprobs`**. `/v1/completions` is a passthrough to
   llama-server and **only works with a GGUF loaded**. This is the constraint
   that shapes suite design — see Suites below.
7. **`/v1/models` lists unloaded models too.** Studio returns loaded models
   *plus* every downloaded GGUF, distinguished only by a `loaded: true|false`
   flag; llama-server omits the flag and lists only what is resident. Reading
   `data[0].id` reports `ready` off a model sitting on disk, and the next
   completion then fails. `getStatus()` prefers a `loaded: true` entry and falls
   back to `data[0]` only when no entry carries the flag.
8. **Never send `enable_tools` or `mcp_enabled`.** Those ask Studio to run *its
   own* tool loop against its MCP registry; it passes client-supplied tools
   through only while both are absent. Setting either silently takes the turn
   away from Penumbra's tools. A test pins their absence from the request body.

## Hardware ceiling

The GPU host's card sets the ceiling for everything here. The reference host is
a TITAN Xp 12 GB — **Pascal, so fp16 only, no bf16** — which constrains training
to QLoRA with `load_in_4bit: true` on models of roughly 8B or less. Some Unsloth
model configs assume bf16; if a base model fails to start, pick an fp16-safe one
(Qwen and Llama at 8B or below are known-good). Confirm the actual card at
deploy time, since it moves this ceiling.

## Suites

Two families, both first-class, reported side by side and **never averaged** —
the reasoning and the metrics are in [EVAL.md](EVAL.md) §4. What matters here is
how they run and why they differ:

- **General** spawns `lm_eval` as a Python subprocess against Studio's
  OpenAI-compatible endpoint.
- **Personal** runs **in-process**, because `scoreCase`/`summarize` are pure
  TypeScript in `packages/shared/src/eval`. No subprocess, no Python, and no way
  to drift from the tool specs the app ships.

**Task names are version-sensitive, and the obvious ones are wrong.** Measured
against lm-eval 0.4.12: the leaderboard variants carry a `leaderboard_` prefix,
and bare `math_hard` fails outright with "Tasks not found". Worse,
`leaderboard_mmlu_pro`, `leaderboard_bbh`, and `leaderboard_gpqa` are all
`multiple_choice` — they need loglikelihoods a chat endpoint cannot return (fact
6), so they *fail* rather than merely scoring badly. `general-v1` is therefore
generative-only: `gsm8k`, `leaderboard_ifeval`, `leaderboard_math_hard`. The
multiple-choice half needs the GGUF `/v1/completions` path and belongs in a
separate suite once that exists.

Install notes, including the required `[api]` extra and the per-task extras that
otherwise fail partway through a run, are in [EVAL.md](EVAL.md) §5.

## Uploads

A model or dataset picked on a laptop names a path only that laptop can read,
while training runs on the GPU host — so the file goes across first. Rather than
proxying Studio's multipart dataset route (fact 4), `/lab/upload` writes into the
server's own upload root (`PENUMBRA_UPLOAD_DIR`, default `~/.penumbra/uploads`)
and the finetune then passes Studio a path Studio can open.

Files stream in chunks pulled from disk, so a multi-gigabyte model never sits in
the webview whole. A model is a directory: the client lists it, asks
`/lab/models/plan` which files the host still needs (comparing sizes), and sends
only those, so a re-run against a model already present skips the transfer.

The client controls the destination name, which makes path containment the one
thing that must be airtight: `resolveDest` rejects an unknown kind, an absolute
`rel`, and any `..` that would climb out of the upload root.

## Job records

Jobs start, return immediately with an id, and report progress by polling —
training runs for minutes to hours, so nothing blocks a request on completion.
The job row is the source of truth rather than the connection: the client may be
gone, and must still be able to read what happened when it returns.

Two failure modes are worth knowing because both once produced silently wrong
results:

- **A progress stream that simply ends is not a finished run.** Studio
  restarting or a tunnel dropping ends the stream without a `complete` event;
  treating that as success marks an interrupted training done and then attaches
  some other run's checkpoint to it. The run is failed unless completion was
  actually reported.
- **Studio reports output dirs only via its runs list, which need not end with
  yours.** The runs that existed before a training start are snapshotted so the
  new one is provably the one it produced. If nothing new appears, nothing is
  recorded — the run then has no output dir and export refuses it, which is the
  safe failure.

## Compute targets

Two Studios are known: **local**, whose address and bearer are persisted (the
environment is the deployment default, and a value set through the API outranks
it), and **Colab**, a second Studio reached through a tunnel and held in memory
only, so its bearer never touches disk and must be re-entered after a restart.

Every target is a full Studio — the key is unscoped (fact 1) — so they do not
differ in what they *can* do. They differ in whether their configuration
survives a restart.

Targets are configured at `/compute/*`, not under `/lab/*`, because chat uses
them too: the Studio a conversation runs against is the same one the Lab trains
and benchmarks on. `GET /compute/targets` reports both, never a bearer. Roles
are assigned there:

- **chat** and **benchmark** each name a target. An assignment can outlive the
  target it names — Colab's config dies with the process — so the response
  carries both what was asked for and what it currently resolves to, and the UI
  says when the two differ rather than misreporting where answers came from.
- **training** is *not* an assignment. It is chosen per run in
  `finetuneRequest.provider`, where `auto` prefers local and falls back to a
  reachable Colab. That is the right granularity: where one job goes, not where
  all training goes.
- **export** is not assignable at all. It follows `lab_runs.provider`, because
  `outputDir` is a path on the machine that trained the run. A Colab session
  that has ended cannot export its checkpoint, and the route says so with a 409
  rather than failing deep inside a job on a path the local Studio cannot see.

One GPU holds one model, so chat and benchmarking on the same target contend: a
benchmark evicts the model the assistant is using. Pointing them at different
targets is the only real fix, which is why the assignments are shown together.
