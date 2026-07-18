import type { SuiteKind } from "./types";

// Benchmark suites, defined as data so the server and the UI agree on what can
// be run without either hard-coding a list.
//
// Two families, both first-class (docs/model_lab_plan.md M3). They answer
// different questions: "general" says how capable a model is at all and is
// comparable to public numbers; "personal" says whether it works as *this*
// assistant and is comparable only to Ghost's own history. Their scores are
// reported side by side and never averaged — a model can gain reasoning ability
// while getting worse at calling create_task, and one blended number would hide
// exactly that.

export interface SuiteDefinition {
  id: string;
  kind: SuiteKind;
  label: string;
  description: string;
  /** lm-eval task names. Empty for the personal family, which runs in-process. */
  tasks: string[];
}

export const SUITES: SuiteDefinition[] = [
  {
    id: "general-v1",
    kind: "general",
    label: "General capability",
    description:
      "Open LLM Leaderboard v2 style, via lm-evaluation-harness. Generative task variants only — Studio's chat endpoint rejects logprobs.",
    // MuSR is loglikelihood-only and is deliberately absent; it would need the
    // GGUF /v1/completions path.
    tasks: [
      "ifeval",
      "gsm8k",
      "mmlu_pro",
      "bbh_cot_fewshot",
      "gpqa_main_cot_zeroshot",
      "math_hard",
    ],
  },
  {
    id: "ghost-tools-v1",
    kind: "personal",
    label: "Ghost tool calling",
    description:
      "Does the model call the right Ghost tool with the right arguments, and stay quiet during chit-chat. Runs in-process against the shipped tool contracts.",
    tasks: [],
  },
];

export function findSuite(id: string): SuiteDefinition | undefined {
  return SUITES.find((s) => s.id === id);
}
