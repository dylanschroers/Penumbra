import type { SuiteKind } from "./types";

// Benchmark suites, defined as data so the server and the UI agree on what can
// be run without either hard-coding a list.
//
// Two families, both first-class (docs/EVAL.md §4). They answer
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
    // (docs/MODEL_LAB.md → What Studio guarantees, fact 6) and belong in a
    // separate suite once that exists. leaderboard_musr is loglikelihood-only
    // for the same reason.
    tasks: ["gsm8k", "leaderboard_ifeval", "leaderboard_math_hard"],
  },
  // v2, and the bump is the whole reason this is not still v1.
  //
  // A capped run used to take the first `samplesPerTask` cases. The set is
  // grouped by tool with the negatives last, so the default 20 of 33 contained
  // no negative case at all: `false_positives` could only ever report 0, and
  // every recorded row reading "0" meant "not measured", not "none found". The
  // sample is now spread across the set, which is a different measurement of
  // the same questions — so it gets a different id rather than quietly
  // rewriting what a v1 row said.
  //
  // v1 rows keep their meaning and still display, because a score row carries
  // its own suite string rather than looking one up here. They are simply not
  // comparable to v2 rows on the false-positive and selection numbers, which is
  // exactly what an id bump is for.
  {
    id: "penumbra-tools-v2",
    kind: "personal",
    label: "Penumbra tool calling",
    description:
      "Does the model call the right Penumbra tool with the right arguments, and stay quiet during chit-chat. Runs in-process against the shipped tool contracts.",
    tasks: [],
  },
  {
    id: "penumbra-lab-v1",
    kind: "personal",
    label: "Penumbra tool calling, with the Model Lab",
    description:
      "The same questions plus the Model Lab's, against every tool the server advertises. Compare its base-tool rows against penumbra-tools-v2 to see what the extra tools cost.",
    tasks: [],
  },
];

/**
 * Suites that advertise the Model Lab contracts as well as the base ones.
 *
 * A set rather than a field on the definition because it decides two things at
 * once — which tools go on the wire and which system prompt frames them — and
 * those must not be settable independently. A run advertising the lab tools
 * under a prompt that never mentions them measures a configuration the app does
 * not ship.
 */
export const LAB_TOOL_SUITES: ReadonlySet<string> = new Set([
  "penumbra-lab-v1",
]);

export function findSuite(id: string): SuiteDefinition | undefined {
  return SUITES.find((s) => s.id === id);
}
