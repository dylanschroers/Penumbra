import type { SuiteKind } from "./types";

// Benchmark suites, defined as data so the server and the UI agree on what can
// be run without either hard-coding a list.
//
// Two families, both first-class (docs/model_lab_plan.md M3). They answer
// different questions: "general" says how capable a model is at all and is
// comparable to public numbers; "personal" says whether it works as *this*
// assistant and is comparable only to Penumbra's own history. Their scores are
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
      "Open LLM Leaderboard v2 style, via lm-evaluation-harness. Generative tasks only — a chat endpoint cannot serve loglikelihood.",
    // Task names and output types verified against the installed lm-eval
    // (0.4.12): the leaderboard_* prefix is required, and the plan's original
    // list (ifeval, mmlu_pro, bbh_cot_fewshot, gpqa_main_cot_zeroshot,
    // math_hard) does not resolve — `math_hard` fails outright with
    // "Tasks not found".
    //
    // Only `generate_until` tasks are listed. leaderboard_mmlu_pro,
    // leaderboard_bbh and leaderboard_gpqa are `multiple_choice`, which needs
    // loglikelihoods that /v1/chat/completions cannot return; running them here
    // fails rather than scoring badly. They need the GGUF /v1/completions path
    // (docs/model_lab_plan.md fact 6) and belong in a separate suite once that
    // exists. leaderboard_musr is loglikelihood-only for the same reason.
    tasks: ["gsm8k", "leaderboard_ifeval", "leaderboard_math_hard"],
  },
  {
    id: "penumbra-tools-v1",
    kind: "personal",
    label: "Penumbra tool calling",
    description:
      "Does the model call the right Penumbra tool with the right arguments, and stay quiet during chit-chat. Runs in-process against the shipped tool contracts.",
    tasks: [],
  },
];

export function findSuite(id: string): SuiteDefinition | undefined {
  return SUITES.find((s) => s.id === id);
}
