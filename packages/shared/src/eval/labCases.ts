import type { EvalCase } from "./cases";

// The Tier-1 half of the eval set: the Model Lab tools, and what advertising
// them does to everything else.
//
// Separate from `evalCases` because the two are graded against different tool
// lists. `evalCases` is scored against `agentTools` alone and is pinned — the
// `penumbra-tools-v2` suite is a recorded measurement, and changing the case mix
// would make every past score incomparable with nothing in the row saying why.
// These are scored against `agentTools` *and* `labTools`, which is the set the
// server actually advertises.
//
// The measurement that matters is not "does list_models fire on 'what models do
// I have'". It is what §7 of docs/AGENT_DESIGN.md warns about: a small model
// degrades as the tool list grows, and the cost lands on the tools that were
// already working. So a lab run scores these *and* the base cases, and the
// number to watch is base-tool selection with eleven tools advertised versus
// the same cases with five.
//
// Three kinds of case, and the last two are the point:
//
//   1. Positives, at least one per lab tool, so a tool cannot be added without
//      a case (eval.test.ts fails the build otherwise).
//   2. Crossovers — utterances carrying lab vocabulary that must reach a task
//      tool, and lab utterances that must not reach the wrong *lab* tool. This
//      is where a tool set this size actually fails.
//   3. Negatives about the lab's own subject matter. "What is LoRA?" next to
//      six actuators is a far better false-positive trap than "Good morning!".

export const labEvalCases: EvalCase[] = [
  // --- list_models ---
  { text: "What models can I benchmark?", tool: "list_models" },
  { text: "Which model is loaded right now?", tool: "list_models" },
  { text: "List the models on the GPU box", tool: "list_models" },
  { text: "Is anything loaded on the benchmark machine?", tool: "list_models" },

  // --- list_datasets ---
  { text: "What datasets can I train on?", tool: "list_datasets" },
  { text: "Show me the datasets on the training host", tool: "list_datasets" },
  { text: "Which training files have I uploaded?", tool: "list_datasets" },

  // --- start_finetune ---
  {
    text: "Fine-tune unsloth/Qwen3-1.7B on tatsu-lab/alpaca",
    tool: "start_finetune",
  },
  {
    text: "Start training the base model on my dataset",
    tool: "start_finetune",
  },
  {
    // maxSteps is asserted only where the utterance states it. Everywhere else
    // the wire schema's default is the right answer, and demanding the slot
    // would score a correct run as a miss.
    text: "Fine-tune Qwen3-1.7B on train.jsonl for 100 steps",
    tool: "start_finetune",
    args: { maxSteps: 100 },
  },

  // --- run_benchmark ---
  {
    text: "Run the penumbra-tools-v2 benchmark",
    tool: "run_benchmark",
    args: { suite: "penumbra-tools-v2" },
  },
  { text: "Benchmark the loaded model", tool: "run_benchmark" },
  {
    text: "Benchmark it with 50 samples per task",
    tool: "run_benchmark",
    args: { samplesPerTask: 50 },
  },

  // --- job_status ---
  { text: "How's that training run going?", tool: "job_status" },
  { text: "Is the benchmark finished yet?", tool: "job_status" },
  { text: "What's running in the lab right now?", tool: "job_status" },

  // --- lab_history ---
  // `what` is asserted only on the scores side. The contract defaults it to
  // "runs", so a model that omits the slot on a runs question still behaves
  // correctly and must not be scored as wrong; omitting it on a scores question
  // genuinely produces the wrong list.
  { text: "What have I fine-tuned so far?", tool: "lab_history" },
  { text: "Which of my runs were exported to GGUF?", tool: "lab_history" },
  {
    text: "Show me the benchmark scores",
    tool: "lab_history",
    args: { what: "scores" },
  },
  {
    text: "How did the last benchmark score?",
    tool: "lab_history",
    args: { what: "scores" },
  },

  // --- crossovers: lab vocabulary, task tool ---
  // A tool set that spans two domains fails at the seam between them, not in
  // the middle of either. Each of these says a lab word loudly while asking for
  // something the lab cannot do.
  { text: "Add a task to benchmark the new model", tool: "create_task" },
  { text: "Remind me to fine-tune the model tomorrow", tool: "create_task" },
  { text: "Mark 'run the benchmark' as done", tool: "complete_task" },
  { text: "Delete the task about training the model", tool: "delete_task" },

  // --- crossovers: the wrong lab tool ---
  // "What models have I trained" against "what models can I run" is the pair a
  // small model most reliably confuses: both are a list, both say "models", and
  // only one of them is about the past. A measured run on the earlier
  // one-tool-four-views design picked `models` for this and got it wrong.
  { text: "What models have I trained?", tool: "lab_history" },
  { text: "What models are available to serve?", tool: "list_models" },
  // Progress against result. The job says whether it finished; only the score
  // table says what it got, which is why they are two tools.
  { text: "Did the benchmark job finish?", tool: "job_status" },
  { text: "What did the benchmark actually score?", tool: "lab_history" },

  // --- negatives: the lab's own subject matter ---
  // Questions a model is most tempted to answer with an actuator, because every
  // content word matches a tool description.
  { text: "What is LoRA, in one paragraph?", tool: null },
  { text: "How does quantization change a model's quality?", tool: null },
  { text: "What's a sensible learning rate for a 1.7B model?", tool: null },
  { text: "Should I benchmark before or after fine-tuning?", tool: null },
  { text: "Explain what a GGUF file is.", tool: null },
];
