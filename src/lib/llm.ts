/**
 * One place to ask a model for a JSON answer, through either the Claude API or the
 * Claude Code CLI. Every call is a fresh context: nothing from a previous call leaks
 * into the next, which is what makes the review passes independent.
 */
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { jsonrepair } from "jsonrepair";

export type Provider = "api" | "claude-code" | "manual" | "mock";

export const PROVIDER: Provider =
  (process.env.ANALYZE_PROVIDER as Provider) ||
  (process.env.ANALYZE_MOCK === "1" ? "mock" : process.env.ANTHROPIC_API_KEY ? "api" : "claude-code");

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

export type ImageRef = { label: string; path: string };

export type JsonRequest = {
  /** role + rules */
  system: string;
  /** the task, with any inline text material */
  user: string;
  /** page images to look at */
  images?: ImageRef[];
  /** JSON schema the answer must follow (used as a tool schema on the API) */
  schema: Record<string, unknown>;
  /** name for the tool / output file */
  name: string;
  /** scratch dir for files (claude-code) */
  workDir: string;
  maxTokens?: number;
};

export async function askJson<T>(req: JsonRequest): Promise<T> {
  if (PROVIDER !== "api" && PROVIDER !== "claude-code") throw new Error(`Provider ${PROVIDER} cannot run model calls`);
  // One retry: a malformed answer or a transient CLI failure should not knock out a check.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return PROVIDER === "api" ? await askApi<T>(req) : await askClaudeCode<T>(req);
    } catch (e) {
      lastErr = e;
      console.warn(`${req.name}: attempt ${attempt + 1} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  throw lastErr;
}

async function askApi<T>(req: JsonRequest): Promise<T> {
  const client = new Anthropic();
  const content: Anthropic.ContentBlockParam[] = [{ type: "text", text: req.user }];
  for (const im of req.images ?? []) {
    const data = (await fs.readFile(im.path)).toString("base64");
    content.push({ type: "text", text: `\n=== ${im.label} ===` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
  }
  content.push({ type: "text", text: `Answer with the ${req.name} tool.` });
  const tool: Anthropic.Tool = { name: req.name, description: "Return the answer.", input_schema: req.schema as Anthropic.Tool["input_schema"] };
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: req.maxTokens ?? 12000,
    system: req.system,
    tools: [tool],
    tool_choice: { type: "tool", name: req.name },
    messages: [{ role: "user", content }],
  });
  const use = res.content.find((c): c is Anthropic.ToolUseBlock => c.type === "tool_use");
  if (!use) throw new Error(`Model did not answer with ${req.name}`);
  return use.input as T;
}

async function askClaudeCode<T>(req: JsonRequest): Promise<T> {
  await fs.mkdir(req.workDir, { recursive: true });
  const outFile = path.join(req.workDir, `${req.name}.json`);
  await fs.rm(outFile, { force: true });
  const imageList = (req.images ?? []).map((im) => `  ${im.label}: ${im.path}`).join("\n");
  const prompt = `${req.system}

${req.user}
${imageList ? `\nImages to open with the Read tool and look at carefully:\n${imageList}\n` : ""}
Return ONLY a JSON object matching this schema (no prose):
${JSON.stringify(req.schema, null, 1)}

Write the JSON object to ${outFile} with the Write tool. Write nothing else.`;

  const bin = process.env.CLAUDE_CODE_BIN || "claude";
  await new Promise<void>((resolve, reject) => {
    // The prompt goes in on stdin: large scripts blow past the OS argument-size limit (E2BIG).
    const p = spawn(
      bin,
      ["-p", "--allowedTools", "Read,Write", "--permission-mode", "acceptEdits", "--output-format", "text"],
      { cwd: req.workDir, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CLAUDECODE: "" } },
    );
    p.stdin.on("error", () => {});
    p.stdin.end(prompt);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.stdout.on("data", () => {});
    p.on("error", (e) => reject(new Error(`Could not start Claude Code (${bin}): ${e.message}`)));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Claude Code exited ${code}: ${err.slice(-2000)}`))));
  });
  const raw = await fs.readFile(outFile, "utf8").catch(() => {
    throw new Error(`Claude Code finished but did not write ${req.name}.json`);
  });
  return parseJsonLoose<T>(raw);
}

/** Accepts JSON possibly wrapped in a code fence or prose. */
export function parseJsonLoose<T>(raw: string): T {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = /\{[\s\S]*\}/.exec(trimmed);
    if (!m) throw new Error("No JSON object found in the answer");
    try {
      return JSON.parse(m[0]);
    } catch {
      // trailing commas, unescaped quotes, truncated tails: repair rather than fail the check
      return JSON.parse(jsonrepair(m[0]));
    }
  }
}
