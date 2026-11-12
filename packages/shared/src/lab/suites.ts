import type { SuiteKind } from "./types";

// Two families, reported side by side and never averaged
// (docs/EVAL.md → Benchmark suites).

export interface SuiteDefinition {
  id: string;
  kind: SuiteKind;
  label: string;
  description: string;
  tasks: string[];
}

export const SUITES: SuiteDefinition[] = [
  {
    id: "general-v1",
    kind: "general",
    label: "General capability",
    description:
      "Open LLM Leaderboard v2 style, via lm-evaluation-harness. Generative tasks only — a chat endpoint cannot serve loglikelihood.",
    // Checked against lm-eval 0.4.12: leaderboard tasks need the `leaderboard_`
    // prefix. Only `generate_until` tasks: multiple-choice ones need loglikelihoods
    // that /v1/chat/completions cannot return (docs/MODEL_LAB.md fact 6).
    tasks: ["gsm8k", "leaderboard_ifeval", "leaderboard_math_hard"],
  },
  // v2 samples across the whole set. v1 took a prefix, which at 20 of 33 cases
  // contained no negatives, so v1 false_positives were never measured.
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
 * Decides both the tools on the wire and the system prompt, so the two can't be
 * set independently.
 */
export const LAB_TOOL_SUITES: ReadonlySet<string> = new Set([
  "penumbra-lab-v1",
]);

export function findSuite(id: string): SuiteDefinition | undefined {
  return SUITES.find((s) => s.id === id);
}
