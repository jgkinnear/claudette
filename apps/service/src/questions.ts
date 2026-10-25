import { basename } from "node:path";

/**
 * What a session is asking you, distilled from Claude Code's hooks into a short,
 * display-safe summary. Claudette never answers: the hooks reply "no decision" and
 * Claude asks you exactly as it normally would.
 *
 * Only these are kept: tool name, a Bash command, a file's base name (never its path),
 * a URL's host, a web search query, and AskUserQuestion's question + option labels.
 */
export interface Question {
  kind: "permission" | "question" | "notice";
  title: string;
  detail: string | null;
  options: string[];
  askedAt: number;
}

const clip = (s: string, max: number) => {
  const flat = s.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? clip(v, max) : null);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function permission(tool: string, input: Record<string, unknown>): Pick<Question, "title" | "detail"> {
  const file = str(input.file_path, 400) ?? str(input.notebook_path, 400);
  switch (tool) {
    case "Bash":
      return { title: "Can I run this command?", detail: str(input.command, 240) };
    case "Write":
      return { title: "Can I create a file?", detail: file ? basename(file) : null };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { title: "Can I edit a file?", detail: file ? basename(file) : null };
    case "Read":
      return { title: "Can I read a file?", detail: file ? basename(file) : null };
    case "WebFetch": {
      let host: string | null = null;
      try {
        host = new URL(String(input.url)).host || null;
      } catch {
        host = null;
      }
      return { title: "Can I fetch a web page?", detail: host };
    }
    case "WebSearch":
      return { title: "Can I search the web?", detail: str(input.query, 160) };
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
      if (mcp) return { title: clip(`Can I use ${mcp[2]} from ${mcp[1]}?`, 60), detail: null };
      return { title: clip(`Can I use ${tool}?`, 60), detail: null };
    }
  }
}

/** Claude's multiple-choice question (the AskUserQuestion tool): the first question and its option labels. */
function askUserQuestion(input: Record<string, unknown>, now: number): Question | null {
  const questions = Array.isArray(input.questions) ? (input.questions as unknown[]) : [];
  const q = obj(questions[0]);
  const text = str(q.question, 240);
  if (!text) return null;
  const header = str(q.header, 40) ?? "Quick question";
  const options = (Array.isArray(q.options) ? q.options : [])
    .map((opt) => str(obj(opt).label, 40))
    .filter((l): l is string => l !== null)
    .slice(0, 4);
  const more = questions.length > 1 ? ` (1 of ${questions.length})` : "";
  return { kind: "question", title: clip(header + more, 60), detail: text, options, askedAt: now };
}

/** Plan approval (ExitPlanMode): the plan's first real line (skipping headings), else its title. */
function planApproval(input: Record<string, unknown>, now: number): Question {
  const lines = (typeof input.plan === "string" ? input.plan : "").split("\n").map((l) => l.trim()).filter(Boolean);
  const tidy = (l: string) => l.replace(/^[#>*\-\s\d.]+/, "").trim();
  const first = tidy(lines.find((l) => !l.startsWith("#")) ?? "") || tidy(lines[0] ?? "");
  return { kind: "question", title: "Here's my plan. Shall I go ahead?", detail: first ? clip(first, 240) : null, options: [], askedAt: now };
}

/** Turn one hook payload into a question, or null if it isn't one. Pure, no I/O. */
export function questionFromHook(payload: unknown, now: number): Question | null {
  const o = obj(payload);
  const event = o.hook_event_name;
  const tool = str(o.tool_name, 80);
  const input = obj(o.tool_input);
  // Claude's own questions arrive both as a permission request and as PreToolUse; read them the same way.
  if ((event === "PermissionRequest" || event === "PreToolUse") && tool === "AskUserQuestion") {
    return askUserQuestion(input, now);
  }
  if (event === "PermissionRequest" && tool === "ExitPlanMode") return planApproval(input, now);
  if (event === "PermissionRequest") {
    if (!tool) return null;
    return { kind: "permission", ...permission(tool, input), options: [], askedAt: now };
  }
  if (event === "Notification") {
    const type = o.notification_type;
    if (type !== "permission_prompt" && type !== "elicitation_dialog") return null;
    return {
      kind: "notice",
      title: type === "permission_prompt" ? "I need your permission" : "I have a question",
      detail: str(o.message, 200),
      options: [],
      askedAt: now,
    };
  }
  return null;
}

/** Pending questions by raw Claude session id (memory only). */
export class QuestionBook {
  private bySession = new Map<string, Question>();

  /** A specific question (permission/question) beats a generic notification for the same prompt. */
  record(sessionId: string, q: Question): void {
    const prev = this.bySession.get(sessionId);
    if (q.kind === "notice" && prev && prev.kind !== "notice" && q.askedAt - prev.askedAt < 30_000) return;
    this.bySession.set(sessionId, q);
  }

  get(sessionId: string | null): Question | null {
    return sessionId ? (this.bySession.get(sessionId) ?? null) : null;
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
