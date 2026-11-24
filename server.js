import express from "express";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { TOOLS, runTool, getSystemInfo } from "./lib/tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch {}

const PORT = Number(process.env.PORT || 3030);
const HOST = "127.0.0.1";
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:3b";
const MAX_STEPS = 8;
const PENDING_TTL_MS = 10 * 60 * 1000;

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

// Local-only guard: reject foreign host headers and cross-origin writes.
app.use((req, res, next) => {
  const host = String(req.headers.host || "");
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
    return res.status(403).json({ error: "Local access only." });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      return res.status(403).json({ error: "Origins outside localhost are not allowed." });
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, "public")));

const pending = new Map();

function systemPrompt() {
  const now = new Date().toLocaleString("en-GB", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `You are J.A.R.V.I.S., the user's personal AI assistant running entirely on their Mac through a local Ollama model. Dry British wit, calm, precise, loyal. Occasionally address the user as "sir", but not in every sentence.

Current date and time: ${now}.

Rules:
- Everything you say is spoken aloud. Reply in plain text: no markdown, no headings, no bullet lists unless explicitly asked. Usually one to three short sentences. Be direct.
- You can control this Mac with tools. Use them proactively when the user wants an action performed: opening apps and URLs, volume, media playback, files, screenshots, notifications, clipboard, system status, shell commands, locking the screen.
- Prefer the dedicated tool over run_shell. Only use run_shell when no specific tool fits.
- App control: when the user asks to open, launch or start an app, call open_app immediately. When they ask to close, quit or kill an app, call quit_app immediately. When they ask what is open or running, call list_running_apps. Pass the name or alias exactly as the user said it ("chrome", "vscode", "whatsapp") because the tools resolve aliases. Never use run_shell for opening or quitting apps.
- Web search: when the user asks to search, google, look up or find something online — including "search in Safari" — call web_search immediately with their query. It opens the results in Safari. Never build a search URL yourself and never use safari.com or any made-up URL.
- Opening a link: use open_url with the real URL, and pass app "Safari" when the user asks for a specific browser.
- After opening a search or a link, do not paste the URL or a markdown link into your reply; just say briefly what you opened.
- Act first, talk after: call the tool before replying, then confirm in one short sentence. Do not ask for permission to open or quit an app.
- For anything about battery, CPU, memory, RAM, disk or uptime, always call system_info first. Never guess hardware values, and never use the volume tools for those questions.
- Call each tool at most once per step, and only when it is actually needed.
- Some tools return status "confirmation_required". When that happens the system pauses and asks the user for authorization. Do not retry the tool; just briefly say you need authorization.
- Never fabricate tool output. If a tool fails, state the failure briefly and offer a sensible next step.
- If the user asks something that does not require the computer, answer from your own knowledge.
- Never claim to have completed an action unless a tool confirmed it.`;
}

async function ollamaChat(model, messages) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      tools: TOOLS,
      stream: false,
      options: { temperature: 0.2, num_ctx: 8192 },
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama error ${res.status}: ${text.slice(0, 300) || "unknown error"}`);
  }
  return res.json();
}

function normalizeCall(tc) {
  const name = tc?.function?.name || tc?.name || "";
  let args = tc?.function?.arguments ?? tc?.arguments ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  return { name, args: args && typeof args === "object" ? args : {} };
}

async function executeCalls(state, calls) {
  for (let i = 0; i < calls.length; i++) {
    const { name, args } = normalizeCall(calls[i]);
    const result = name
      ? await runTool(name, args)
      : { ok: false, error: "Malformed tool call." };

    if (result?.status === "confirmation_required") {
      const token = crypto.randomUUID();
      pending.set(token, {
        state,
        tool: name,
        args,
        remaining: calls.slice(i + 1),
        summary: result.summary,
        createdAt: Date.now(),
      });
      return {
        reply: `Authorization required, sir. ${result.summary}`,
        steps: state.steps,
        requiresConfirmation: { token, tool: name, summary: result.summary, args },
      };
    }

    state.messages.push({
      role: "tool",
      tool_name: name || "unknown",
      content: JSON.stringify(result).slice(0, 6000),
    });
    state.steps.push({ name: name || "unknown", args, result });
  }
  return null;
}

// Replies are spoken aloud; small models still emit markdown links, so strip them.
function cleanReply(text) {
  return String(text || "")
    .replace(/\[([^\]]*)\]\((?:https?:\/\/|mailto:)[^)]*\)/g, "$1")
    .replace(/<(?:https?:\/\/)[^>\s]*>/gi, "")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

async function advance(state) {
  for (let step = 0; step < MAX_STEPS; step++) {
    const data = await ollamaChat(state.model, state.messages);
    const msg = data?.message || {};

    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      state.messages.push({
        role: "assistant",
        content: msg.content || "",
        tool_calls: msg.tool_calls,
      });
      const waiting = await executeCalls(state, msg.tool_calls);
      if (waiting) return waiting;
      continue;
    }

    const reply = cleanReply(msg.content || "");
    return { reply: reply || "At your service, sir.", steps: state.steps };
  }
  return { reply: "I have reached my step limit on that task, sir.", steps: state.steps };
}

function sanitizeMessages(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim()
    )
    .slice(-24)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
}

app.get("/api/status", async (_req, res) => {
  let ollama = false;
  let models = [];
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) {
      const data = await r.json();
      models = (data.models || []).map((m) => m.name).sort();
      ollama = true;
    }
  } catch {}
  res.json({
    ollama,
    models,
    defaultModel: DEFAULT_MODEL,
    platform: process.platform,
    hostname: os.hostname(),
  });
});

app.get("/api/sysinfo", async (_req, res) => {
  try {
    res.json(await getSystemInfo());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/chat", async (req, res) => {
  const { messages, model } = req.body || {};
  const chosen = typeof model === "string" && model.trim() ? model.trim() : DEFAULT_MODEL;
  const state = {
    model: chosen,
    messages: [{ role: "system", content: systemPrompt() }, ...sanitizeMessages(messages)],
    steps: [],
  };
  try {
    res.json(await advance(state));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/confirm", async (req, res) => {
  const { token, approve } = req.body || {};
  const record = pending.get(token);
  if (!record) {
    return res
      .status(404)
      .json({ error: "That authorization request has expired. Ask me again." });
  }
  pending.delete(token);

  try {
    const result =
      approve === true
        ? await runTool(record.tool, record.args, { force: true })
        : { ok: false, denied: true, error: "The user denied authorization." };

    record.state.messages.push({
      role: "tool",
      tool_name: record.tool,
      content: JSON.stringify(result).slice(0, 6000),
    });
    record.state.steps.push({
      name: record.tool,
      args: record.args,
      result,
      approved: approve === true,
    });

    const waiting = await executeCalls(record.state, record.remaining || []);
    if (waiting) return res.json(waiting);

    res.json(await advance(record.state));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [token, record] of pending) {
    if (now - record.createdAt > PENDING_TTL_MS) pending.delete(token);
  }
}, 60000).unref();

app.listen(PORT, HOST, () => {
  console.log(`\n  J.A.R.V.I.S. online  →  http://${HOST}:${PORT}`);
  console.log(`  Core: ${OLLAMA_URL}  ·  model: ${DEFAULT_MODEL}\n`);
});
