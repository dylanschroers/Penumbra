import type { ScoredCase } from "./scoring";

// Turns a benchmark run into finetuning data, so the eval and the training set
// can never drift apart: the same utterances that grade the model also teach it.
//
// The technique is rejection sampling — keep only the turns the model got
// right, and emit them as gold examples. Be clear about what that is worth:
// training a model on its own correct outputs teaches *it* very little. The
// value is (a) distilling a large model's behavior into a small one, which is
// the Tier-0/Tier-1 split exactly, (b) a regression set that pins behavior
// across finetunes, and (c) a seed file whose gaps — the cases the model got
// wrong, reported as `skipped` — are the ones worth hand-labeling.

/** OpenAI chat-format training row, the shape Unsloth's SFT trainer reads. */
export interface TrainingExample {
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
    tool_calls?: Array<{
      type: "function";
      function: { name: string; arguments: string };
    }>;
  }>;
}

export interface TrainsetResult {
  examples: TrainingExample[];
  /** Utterances with no trustworthy gold turn, and why. These are the
   *  hand-labeling worklist. */
  skipped: Array<{ text: string; reason: string }>;
}

export function toTrainingExamples(
  scored: ScoredCase[],
  system: string,
): TrainsetResult {
  const examples: TrainingExample[] = [];
  const skipped: TrainsetResult["skipped"] = [];

  for (const s of scored) {
    const user = { role: "user" as const, content: s.case.text };
    const head = [{ role: "system" as const, content: system }, user];

    if (!s.selectionOk) {
      // The expected tool is known, but its arguments are not: the cases
      // deliberately omit titles, so a gold call cannot be fabricated here.
      skipped.push({
        text: s.case.text,
        reason: `wrong tool (${s.outcome.name ?? "none"} for ${s.case.tool ?? "none"})`,
      });
      continue;
    }

    if (s.case.tool === null) {
      // A correct refusal is only teachable if we captured what it said.
      if (!s.outcome.content?.trim()) {
        skipped.push({ text: s.case.text, reason: "no assistant content" });
        continue;
      }
      examples.push({
        messages: [
          ...head,
          { role: "assistant", content: s.outcome.content.trim() },
        ],
      });
      continue;
    }

    if (!s.outcome.argsValid || s.argsOk === false) {
      skipped.push({
        text: s.case.text,
        reason: s.outcome.argsValid
          ? "args failed spot-check"
          : "unparseable args",
      });
      continue;
    }

    examples.push({
      messages: [
        ...head,
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              type: "function",
              function: {
                name: s.case.tool,
                arguments: JSON.stringify(s.outcome.args ?? {}),
              },
            },
          ],
        },
      ],
    });
  }

  return { examples, skipped };
}

/** Serialize to JSONL, the format Unsloth's dataset loader expects. */
export function toJsonl(examples: TrainingExample[]): string {
  return examples.map((e) => JSON.stringify(e)).join("\n");
}
