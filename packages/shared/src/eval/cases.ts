// The tool-calling eval set (docs/AGENT_DESIGN.md §7). Lives beside the tool
// contracts rather than in scripts/ so the benchmark runner and the
// training-set exporter score and train against the same utterances, and so it
// is covered by the shared package's tests.

/** One graded utterance.
 *  - `tool`: the tool it should call, or null when it should just answer.
 *  - `args`: deterministic slots worth spot-checking. Titles are omitted on
 *    purpose — extraction varies in casing and phrasing, so tool selection is
 *    the signal, not string equality. */
export interface EvalCase {
  text: string;
  tool: string | null;
  args?: Record<string, unknown>;
}

export const evalCases: EvalCase[] = [
  // create_task
  { text: "Add buy milk to my list", tool: "create_task" },
  { text: "Create a task to finish the quarterly report", tool: "create_task" },
  {
    text: "Add a high priority task to file taxes",
    tool: "create_task",
    args: { priority: "high" },
  },
  { text: "Put 'renew passport' on my todo list", tool: "create_task" },
  {
    text: "Make a low priority task to clean the garage",
    tool: "create_task",
    args: { priority: "low" },
  },
  {
    text: "Add a high-priority task to file taxes by April 15",
    tool: "create_task",
    args: { priority: "high" },
  },
  {
    text: "Create a task called draft proposal, medium priority",
    tool: "create_task",
    args: { priority: "medium" },
  },
  // list_tasks
  { text: "What's on my to-do list?", tool: "list_tasks" },
  { text: "Show me my tasks", tool: "list_tasks" },
  {
    text: "Which tasks have I finished?",
    tool: "list_tasks",
    args: { status: "done" },
  },
  { text: "List everything I still have to do", tool: "list_tasks" },
  // complete_task
  { text: "Mark buy milk as done", tool: "complete_task" },
  {
    text: "I finished the quarterly report, check it off",
    tool: "complete_task",
  },
  {
    text: "Complete the task about renewing my passport",
    tool: "complete_task",
  },
  { text: "Tick off cleaning the garage", tool: "complete_task" },
  // delete_task
  { text: "Delete the buy milk task", tool: "delete_task" },
  { text: "Remove 'file taxes' from my list", tool: "delete_task" },
  { text: "Get rid of the draft proposal task", tool: "delete_task" },
  // negative — should NOT call a tool
  { text: "What's the weather like today?", tool: null },
  { text: "How do I stay more organized?", tool: null },
  { text: "What can you help me with?", tool: null },
  { text: "Tell me a fun fact.", tool: null },
  { text: "What's 15% of 240?", tool: null },
  { text: "Explain what a task manager is.", tool: null },
  { text: "Good morning!", tool: null },
  { text: "Thanks, that's helpful.", tool: null },
];
