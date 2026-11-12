import type { ScoredCase } from "./scoring";

// Rejection sampling: only turns the model got right become examples. Mainly
// for distilling a large model into a small one.

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
      // Cases omit titles, so a gold call can't be fabricated.
      skipped.push({
        text: s.case.text,
        reason: `wrong tool (${s.outcome.name ?? "none"} for ${s.case.tool ?? "none"})`,
      });
      continue;
    }

    if (s.case.tool === null) {
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

export function toJsonl(examples: TrainingExample[]): string {
  return examples.map((e) => JSON.stringify(e)).join("\n");
}
