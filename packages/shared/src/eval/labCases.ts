import type { EvalCase } from "./cases";

// Scored against `agentTools` + `labTools`. `evalCases` stays pinned to the
// base tools so past penumbra-tools-v2 scores stay comparable. Crossovers and
// lab-subject negatives matter most: the risk is extra tools degrading the
// base ones.

export const labEvalCases: EvalCase[] = [
  { text: "What models can I benchmark?", tool: "list_models" },
  { text: "Which model is loaded right now?", tool: "list_models" },
  { text: "List the models on the GPU box", tool: "list_models" },
  { text: "Is anything loaded on the benchmark machine?", tool: "list_models" },

  { text: "What datasets can I train on?", tool: "list_datasets" },
  { text: "Show me the datasets on the training host", tool: "list_datasets" },
  { text: "Which training files have I uploaded?", tool: "list_datasets" },

  {
    text: "Fine-tune unsloth/Qwen3-1.7B on tatsu-lab/alpaca",
    tool: "start_finetune",
  },
  {
    text: "Start training the base model on my dataset",
    tool: "start_finetune",
  },
  {
    // maxSteps is asserted only where the utterance states it.
    text: "Fine-tune Qwen3-1.7B on train.jsonl for 100 steps",
    tool: "start_finetune",
    args: { maxSteps: 100 },
  },

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

  { text: "How's that training run going?", tool: "job_status" },
  { text: "Is the benchmark finished yet?", tool: "job_status" },
  { text: "What's running in the lab right now?", tool: "job_status" },

  // `what` is asserted only for scores: it defaults to "runs", so omitting it on
  // a runs question is correct.
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

  { text: "Add a task to benchmark the new model", tool: "create_task" },
  { text: "Remind me to fine-tune the model tomorrow", tool: "create_task" },
  { text: "Mark 'run the benchmark' as done", tool: "complete_task" },
  { text: "Delete the task about training the model", tool: "delete_task" },

  { text: "What models have I trained?", tool: "lab_history" },
  { text: "What models are available to serve?", tool: "list_models" },
  { text: "Did the benchmark job finish?", tool: "job_status" },
  { text: "What did the benchmark actually score?", tool: "lab_history" },

  { text: "What is LoRA, in one paragraph?", tool: null },
  { text: "How does quantization change a model's quality?", tool: null },
  { text: "What's a sensible learning rate for a 1.7B model?", tool: null },
  { text: "Should I benchmark before or after fine-tuning?", tool: null },
  { text: "Explain what a GGUF file is.", tool: null },
];
