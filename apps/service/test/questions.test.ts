import { describe, expect, it } from "vitest";
import { QuestionBook, questionFromHook } from "../src/questions.js";

const now = 1_800_000_000_000;
const perm = (tool_name: string, tool_input: Record<string, unknown>) =>
  questionFromHook({ hook_event_name: "PermissionRequest", session_id: "s", tool_name, tool_input }, now);

describe("questions from hooks", () => {
  it("summarises permission requests in Claudette's voice", () => {
    expect(perm("Bash", { command: "pnpm   db:migrate\n --env=prod", description: "Run migrations" })).toMatchObject({
      kind: "permission",
      title: "Can I run this command?",
      detail: "pnpm db:migrate --env=prod",
    });
    expect(perm("WebFetch", { url: "https://docs.example.com/a/b?token=secret" })?.detail).toBe("docs.example.com");
    expect(perm("mcp__github__create_issue", {})?.title).toBe("Can I use create_issue from github?");
  });

  it("only ever keeps a file's name, never its path", () => {
    const q = perm("Edit", { file_path: "/Users/someone/private/project/src/billing.ts", old_string: "x", new_string: "y" });
    expect(q).toMatchObject({ title: "Can I edit a file?", detail: "billing.ts" });
    expect(JSON.stringify(q)).not.toContain("/Users");
    expect(JSON.stringify(q)).not.toContain("old_string");
  });

  it("reads AskUserQuestion's question and option labels", () => {
    const q = questionFromHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            { header: "Database", question: "Which database for the cache?", options: [{ label: "Redis", description: "fast" }, { label: "SQLite" }] },
            { header: "Second", question: "?" },
          ],
        },
      },
      now,
    );
    expect(q).toEqual({ kind: "question", title: "Database (1 of 2)", detail: "Which database for the cache?", options: ["Redis", "SQLite"], askedAt: now });
  });

  it("ignores other events and strips control characters", () => {
    expect(questionFromHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }, now)).toBeNull();
    expect(questionFromHook({ hook_event_name: "Notification", notification_type: "idle_prompt", message: "x" }, now)).toBeNull();
    expect(perm("Bash", { command: "echo \u001b[31mred\u202e" })?.detail).toBe("echo [31mred");
  });

  it("a generic notification doesn't replace the specific question", () => {
    const book = new QuestionBook();
    book.record("s", perm("Bash", { command: "rm -rf dist" })!);
    book.record("s", questionFromHook({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission" }, now + 1000)!);
    expect(book.get("s")?.title).toBe("Can I run this command?");
  });
});
