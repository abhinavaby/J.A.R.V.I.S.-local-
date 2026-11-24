import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

const execFileP = promisify(execFile);
const HOME = os.homedir();
const IS_MAC = process.platform === "darwin";

function expandPath(p) {
  if (!p || typeof p !== "string") return HOME;
  let s = p.trim();
  if (s === "~") return HOME;
  if (s.startsWith("~/")) s = path.join(HOME, s.slice(2));
  return path.resolve(s);
}

async function run(bin, args, { timeout = 20000 } = {}) {
  try {
    const { stdout, stderr } = await execFileP(bin, args, {
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env,
    });
    return { ok: true, output: (stdout || stderr || "").trim().slice(0, 4000) };
  } catch (err) {
    const message = err.killed
      ? `Command timed out after ${Math.round(timeout / 1000)}s`
      : String(err.stderr || err.message || err);
    return { ok: false, error: message.trim().slice(0, 1500) };
  }
}

async function shell(command, timeout = 20000) {
  try {
    const { stdout, stderr } = await execFileP("/bin/zsh", ["-lc", command], {
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env,
    });
    return {
      ok: true,
      stdout: stdout.trim().slice(0, 4000),
      stderr: stderr.trim().slice(0, 1000),
    };
  } catch (err) {
    const message = err.killed
      ? `Command timed out after ${Math.round(timeout / 1000)}s`
      : String(err.stderr || err.stdout || err.message || err);
    return { ok: false, error: message.trim().slice(0, 1500) };
  }
}

function appleString(s) {
  return String(s ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .slice(0, 800);
}

async function osascript(lines, timeout = 20000) {
  return run("osascript", lines.flatMap((line) => ["-e", line]), { timeout });
}

function pbcopy(text) {
  return new Promise((resolve) => {
    try {
      const proc = spawn("pbcopy");
      proc.on("error", () => resolve(false));
      proc.on("close", (code) => resolve(code === 0));
      proc.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

const APP_ALIASES = new Map([
  ["chrome", "Google Chrome"],
  ["google chrome", "Google Chrome"],
  ["vscode", "Visual Studio Code"],
  ["vs code", "Visual Studio Code"],
  ["vs-code", "Visual Studio Code"],
  ["visual studio code", "Visual Studio Code"],
  ["xcode", "Xcode"],
  ["iterm", "iTerm"],
  ["iterm2", "iTerm"],
  ["terminal", "Terminal"],
  ["settings", "System Settings"],
  ["system settings", "System Settings"],
  ["system preferences", "System Settings"],
  ["app store", "App Store"],
  ["appstore", "App Store"],
  ["calc", "Calculator"],
  ["calculator", "Calculator"],
  ["whatsapp", "WhatsApp"],
  ["telegram", "Telegram"],
  ["slack", "Slack"],
  ["discord", "Discord"],
  ["zoom", "zoom.us"],
  ["music", "Music"],
  ["apple music", "Music"],
  ["notes", "Notes"],
  ["mail", "Mail"],
  ["calendar", "Calendar"],
  ["photos", "Photos"],
  ["messages", "Messages"],
  ["facetime", "FaceTime"],
  ["maps", "Maps"],
  ["figma", "Figma"],
  ["cursor", "Cursor"],
  ["intellij", "IntelliJ IDEA"],
  ["pycharm", "PyCharm"],
  ["docker", "Docker"],
  ["chatgpt", "ChatGPT"],
  ["claude", "Claude"],
  ["ollama", "Ollama"],
  ["keynote", "Keynote"],
  ["pages", "Pages"],
  ["numbers", "Numbers"],
  ["safari", "Safari"],
  ["firefox", "Firefox"],
  ["edge", "Microsoft Edge"],
  ["brave", "Brave Browser"],
  ["preview", "Preview"],
  ["activity monitor", "Activity Monitor"],
  ["activity", "Activity Monitor"],
  ["finder", "Finder"],
]);

function aliasFor(name) {
  const raw = String(name || "").trim();
  if (!raw) return raw;
  const base = raw.replace(/\.app$/i, "").split("/").pop();
  return APP_ALIASES.get(base.toLowerCase()) || base;
}

let appCache = { at: 0, apps: [] };

async function listInstalledApps() {
  if (Date.now() - appCache.at < 60000 && appCache.apps.length) return appCache.apps;
  const roots = ["/Applications", "/System/Applications", path.join(HOME, "Applications")];
  const apps = [];
  const scan = async (dir, depth) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.endsWith(".app")) {
        apps.push({ name: entry.name.slice(0, -4), path: path.join(dir, entry.name) });
      } else if (depth > 0 && !entry.name.startsWith(".")) {
        await scan(path.join(dir, entry.name), depth - 1);
      }
    }
  };
  for (const root of roots) await scan(root, 1);
  appCache = { at: Date.now(), apps };
  return apps;
}

async function resolveAppPath(name) {
  const apps = await listInstalledApps();
  const target = name.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const app of apps) {
    if (/helper/i.test(app.name)) continue;
    const n = app.name.toLowerCase();
    const score = n === target ? 100 : n.startsWith(target) ? 80 : n.includes(target) ? 60 : 0;
    if (score > bestScore) {
      best = app;
      bestScore = score;
    }
  }
  return best;
}

async function runningApps() {
  let stdout = "";
  try {
    ({ stdout } = await execFileP("ps", ["-axo", "comm="], {
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    }));
  } catch {
    return [];
  }
  const found = new Map();
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/\/([^/]+)\.app\/Contents\/MacOS\/([^/]+)$/);
    if (!match) continue;
    const appName = match[1];
    const processName = match[2];
    if (/helper|widget/i.test(appName) || /helper|widget/i.test(processName)) continue;
    found.set(appName.toLowerCase(), {
      app: appName,
      process: processName,
      path: line.trim(),
    });
  }
  return [...found.values()];
}

async function foregroundApps() {
  let stdout = "";
  try {
    ({ stdout } = await execFileP("lsappinfo", ["list"], {
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    }));
  } catch {
    return runningApps();
  }
  const apps = [];
  const blocks = stdout.split(/\n(?=\s*\d+\)\s+")/);
  for (const block of blocks) {
    const head = block.match(/^\s*\d+\)\s+"([^"]+)"/);
    if (!head || !/type="Foreground"/.test(block)) continue;
    const exec = block.match(/executable path="([^"]+)"/);
    const processName = exec ? exec[1].split("/").pop() : head[1];
    if (/helper|widget/i.test(head[1]) || /helper|widget/i.test(processName)) continue;
    apps.push({ app: head[1], process: processName, path: exec ? exec[1] : "" });
  }
  return apps.length ? apps : runningApps();
}

function findRunning(list, target) {
  const t = target.toLowerCase();
  return (
    list.find((x) => x.app.toLowerCase() === t) ||
    list.find((x) => x.process.toLowerCase() === t) ||
    list.find((x) => x.app.toLowerCase().includes(t)) ||
    null
  );
}

const DANGEROUS_PATTERNS = [
  /\brm\b/i,
  /\bsudo\b/i,
  /\bdoas\b/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\bkill(all)?\b/i,
  /\bpkill\b/i,
  /\bmkfs\b/i,
  /\bdd\b/i,
  /\bdiskutil\b/i,
  /\blaunchctl\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bpmset\b/i,
  /\bsystemsetup\b/i,
  /\bfind\b[\s\S]*-delete\b/i,
  /\bgit\s+(clean|reset)\b/i,
  /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/i,
  /:\(\)\s*\{/,
  />\s*\/dev\/(sd|disk)/i,
];

export function isDangerous(command) {
  return DANGEROUS_PATTERNS.some((re) => re.test(command));
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function sampleCpu() {
  const first = os.cpus();
  await new Promise((r) => setTimeout(r, 250));
  const second = os.cpus();
  let idle = 0;
  let total = 0;
  for (let i = 0; i < first.length; i++) {
    const a = first[i].times;
    const b = second[i].times;
    idle += b.idle - a.idle;
    total +=
      b.user - a.user + (b.nice - a.nice) + (b.sys - a.sys) + (b.idle - a.idle) + (b.irq - a.irq);
  }
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - idle / total) * 100));
}

async function readBattery() {
  const r = await run("pmset", ["-g", "batt"]);
  if (!r.ok) return null;
  const percent = r.output.match(/(\d+)%/);
  const onAc = /AC Power/i.test(r.output);
  const charging = onAc && !/discharging/i.test(r.output);
  return { percent: percent ? Number(percent[1]) : null, charging, onAc };
}

async function readDisk() {
  const r = await run("df", ["-k", "/"]);
  if (!r.ok) return null;
  const parts = (r.output.split("\n")[1] || "").trim().split(/\s+/);
  if (parts.length < 4) return null;
  const total = Number(parts[1]) * 1024;
  const used = Number(parts[2]) * 1024;
  if (!total) return null;
  return { total, used, free: total - used };
}

// os.freemem() reports cached pages as used on macOS, so use vm_stat's
// free + inactive + speculative + purgeable pages as the real headroom.
async function readMemory() {
  const total = os.totalmem();
  if (IS_MAC) {
    const r = await run("vm_stat");
    if (r.ok) {
      const pageSize = r.output.match(/page size of (\d+) bytes/);
      const size = pageSize ? Number(pageSize[1]) : 4096;
      const pages = (label) => {
        const m = r.output.match(new RegExp(`${label}:\\s+(\\d+)`));
        return m ? Number(m[1]) : 0;
      };
      const availablePages =
        pages("Pages free") +
        pages("Pages inactive") +
        pages("Pages speculative") +
        pages("Pages purgeable");
      const available = Math.min(total, availablePages * size);
      return { total, used: total - available, available };
    }
  }
  const free = os.freemem();
  return { total, used: total - free, available: free };
}

export async function getSystemInfo() {
  const [cpuLoad, battery, disk, memory] = await Promise.all([
    sampleCpu(),
    readBattery(),
    readDisk(),
    readMemory(),
  ]);
  return {
    platform: process.platform,
    hostname: os.hostname(),
    uptimeSec: Math.round(os.uptime()),
    cpuCount: os.cpus().length,
    cpuLoad: Math.round(cpuLoad * 10) / 10,
    loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    memTotal: memory.total,
    memUsed: memory.used,
    memAvailable: memory.available,
    battery,
    disk,
  };
}

const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });

function tool(name, description, properties = {}, required = []) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required },
    },
  };
}

export const TOOLS = [
  tool(
    "open_app",
    "Open or launch a macOS application. Accepts friendly names and aliases such as 'chrome', 'vscode', 'whatsapp', 'terminal', 'calculator'. Use this immediately when the user asks to open an app; never use run_shell for this.",
    { app: str("Application name or alias") },
    ["app"]
  ),
  tool(
    "quit_app",
    "Quit or close a running macOS application by name or alias. Use this immediately when the user asks to close, quit or kill an app; never use run_shell for this.",
    { app: str("Application name or alias") },
    ["app"]
  ),
  tool(
    "list_running_apps",
    "List the applications currently running on the Mac, for questions like 'what apps are open?'.",
    {}
  ),
  tool(
    "open_url",
    "Open a specific web address in a browser. Use this for a known URL. For web searches use web_search instead. Optionally name a browser such as Safari.",
    {
      url: str("URL, e.g. https://example.com"),
      app: str("Optional browser to use, e.g. Safari"),
    },
    ["url"]
  ),
  tool(
    "web_search",
    "Search the web and show the results in Safari. Use this immediately whenever the user asks to search, google, look up or find something online, including 'search in Safari'. Pass a different browser in the app field only if the user names one.",
    {
      query: str("What to search for"),
      engine: {
        type: "string",
        enum: ["google", "duckduckgo", "bing", "youtube"],
        description: "Search engine to use, default google",
      },
      app: str("Optional browser to use, defaults to Safari"),
    },
    ["query"]
  ),
  tool("open_path", "Reveal a file or folder in Finder.", {
    path: str("Absolute path or ~ path"),
  }, ["path"]),
  tool(
    "run_shell",
    "Run a zsh shell command on the Mac and return stdout/stderr. Destructive commands require explicit user authorization.",
    { command: str("The shell command to execute") },
    ["command"]
  ),
  tool("read_file", "Read the contents of a text file (up to 50KB).", {
    path: str("Path of the file to read"),
  }, ["path"]),
  tool(
    "write_file",
    "Create or overwrite a file with text content. Overwriting an existing file requires user authorization.",
    { path: str("Path of the file to write"), content: str("Text content") },
    ["path", "content"]
  ),
  tool("list_files", "List files and folders in a directory.", {
    path: str("Directory path (defaults to home)"),
  }),
  tool(
    "search_files",
    "Search for files by name using Spotlight. Returns up to 30 paths.",
    { query: str("File name query"), path: str("Optional folder to search inside") },
    ["query"]
  ),
  tool(
    "system_info",
    "Get live Mac hardware diagnostics: CPU load, memory, battery percentage, disk space and uptime. Always use this for questions about battery, CPU, RAM, disk or uptime.",
    {}
  ),
  tool(
    "set_volume",
    "Set the audio output (speaker) volume. This affects sound, not battery.",
    { level: num("Volume level 0-100") },
    ["level"]
  ),
  tool("get_volume", "Get the current audio output (speaker) volume, 0-100. Not the battery.", {}),
  tool(
    "media_control",
    "Control the active music player (Spotify or Apple Music): play/pause, next track or previous track.",
    {
      action: {
        type: "string",
        enum: ["play_pause", "next", "previous"],
        description: "Media action to perform",
      },
    },
    ["action"]
  ),
  tool("screenshot", "Take a screenshot of the entire screen and save it to the Desktop.", {}),
  tool("notify", "Show a macOS notification.", {
    title: str("Notification title"),
    message: str("Notification body"),
  }, ["message"]),
  tool("clipboard_get", "Read the current clipboard text.", {}),
  tool("clipboard_set", "Copy text to the clipboard.", { text: str("Text to copy") }, ["text"]),
  tool("lock_screen", "Lock the screen immediately.", {}),
];

const handlers = {
  async open_app({ app }) {
    if (!app) return { ok: false, error: "No application name given." };
    const requested = String(app).trim();
    const target = aliasFor(requested);

    const direct = await run("open", ["-a", target]);
    if (direct.ok) return { ok: true, message: `Opened ${target}.` };

    const resolved = await resolveAppPath(target);
    if (resolved) {
      const fallback = await run("open", [resolved.path]);
      if (fallback.ok) return { ok: true, message: `Opened ${resolved.name}.` };
      return { ok: false, error: `Could not open ${resolved.name}: ${fallback.error}` };
    }

    return {
      ok: false,
      error: `No application matching "${requested}" was found in /Applications or /System/Applications.`,
    };
  },

  async quit_app({ app }) {
    if (!app) return { ok: false, error: "No application name given." };
    const requested = String(app).trim();
    const target = aliasFor(requested);

    if (/^finder$/i.test(target)) {
      return { ok: false, error: "Finder is managed by macOS and cannot be quit." };
    }

    let match = findRunning(await foregroundApps(), target);
    if (!match) match = findRunning(await runningApps(), target);
    if (!match) return { ok: true, message: `${target} is not running.` };

    const graceful = await osascript(
      [`tell application "${appleString(match.app)}" to quit`],
      6000
    );
    if (graceful.ok) return { ok: true, message: `Quit ${match.app}.` };

    const forced = await run("pkill", ["-TERM", "-x", match.process]);
    if (forced.ok) return { ok: true, message: `Closed ${match.app}.` };

    return {
      ok: false,
      error: `Could not close ${match.app}. Try granting Automation permission to your terminal in System Settings.`,
    };
  },

  async list_running_apps() {
    const list = await foregroundApps();
    const apps = [...new Set(list.map((x) => x.app))]
      .filter((name) => !/^(loginwindow|Dock|SystemUIServer|WindowServer)$/i.test(name))
      .sort((a, b) => a.localeCompare(b));
    return { ok: true, count: apps.length, apps };
  },

  async open_url({ url, app }) {
    if (!url) return { ok: false, error: "No URL given." };
    let target = String(url).trim();
    if (!/^(https?:\/\/|mailto:)/i.test(target)) target = `https://${target}`;
    const browser = app ? aliasFor(String(app).trim()) : "";
    const r = browser
      ? await run("open", ["-a", browser, target])
      : await run("open", [target]);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, message: browser ? `Opened ${target} in ${browser}.` : `Opened ${target}.` };
  },

  async web_search({ query, engine, app }) {
    const q = String(query || "").trim();
    if (!q) return { ok: false, error: "No search query given." };
    const key = String(engine || "google").toLowerCase();
    const browser = app ? aliasFor(String(app).trim()) : "Safari";
    const encoded = encodeURIComponent(q);
    const urls = {
      google: `https://www.google.com/search?q=${encoded}`,
      duckduckgo: `https://duckduckgo.com/?q=${encoded}`,
      bing: `https://www.bing.com/search?q=${encoded}`,
      youtube: `https://www.youtube.com/results?search_query=${encoded}`,
    };
    const url = urls[key] || urls.google;

    const opened = await run("open", ["-a", browser, url]);
    if (opened.ok) {
      return { ok: true, engine: key, url, message: `Searching ${browser} for "${q}".` };
    }
    const fallback = await run("open", [url]);
    return fallback.ok
      ? { ok: true, engine: key, url, message: `Searching for "${q}" in the default browser.` }
      : { ok: false, error: fallback.error };
  },

  async open_path({ path: p }) {
    const target = expandPath(p);
    const r = await run("open", [target]);
    return r.ok
      ? { ok: true, message: `Opened ${target} in Finder.` }
      : { ok: false, error: r.error };
  },

  async run_shell({ command }, ctx = {}) {
    if (typeof command !== "string" || !command.trim()) {
      return { ok: false, error: "No command given." };
    }
    const cmd = command.trim().slice(0, 4000);
    if (!ctx.force && isDangerous(cmd)) {
      return { status: "confirmation_required", summary: `Run shell command: ${cmd}` };
    }
    const r = await shell(cmd);
    return r.ok ? { ok: true, ...r } : r;
  },

  async read_file({ path: p }) {
    const file = expandPath(p);
    try {
      const stat = await fs.stat(file);
      if (stat.isDirectory()) {
        return { ok: false, error: `${file} is a directory. Use list_files instead.` };
      }
      const max = 50000;
      const buf = await fs.readFile(file);
      if (buf.subarray(0, 4000).includes(0)) {
        return { ok: false, error: `${file} appears to be a binary file.` };
      }
      return {
        ok: true,
        path: file,
        size: stat.size,
        truncated: buf.length > max,
        content: buf.subarray(0, max).toString("utf8"),
      };
    } catch (e) {
      return { ok: false, error: `Could not read ${file}: ${e.message}` };
    }
  },

  async write_file({ path: p, content }, ctx = {}) {
    if (!p) return { ok: false, error: "No path given." };
    const file = expandPath(p);
    let exists = false;
    try {
      await fs.access(file);
      exists = true;
    } catch {}
    if (exists && !ctx.force) {
      return { status: "confirmation_required", summary: `Overwrite existing file: ${file}` };
    }
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const text = String(content ?? "");
      await fs.writeFile(file, text, "utf8");
      return { ok: true, message: `Wrote ${text.length} characters to ${file}.` };
    } catch (e) {
      return { ok: false, error: `Could not write ${file}: ${e.message}` };
    }
  },

  async list_files({ path: p }) {
    const dir = expandPath(p);
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const items = entries.slice(0, 200).map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "dir" : "file",
      }));
      return { ok: true, path: dir, count: entries.length, items };
    } catch (e) {
      return { ok: false, error: `Could not list ${dir}: ${e.message}` };
    }
  },

  async search_files({ query, path: p }) {
    if (!query) return { ok: false, error: "No search query given." };
    if (!IS_MAC) return { ok: false, error: "File search uses Spotlight and is macOS-only." };
    const base = p ? expandPath(p) : HOME;
    const r = await run("mdfind", ["-onlyin", base, "-name", String(query)], { timeout: 15000 });
    if (!r.ok) return r;
    const results = r.output.split("\n").filter(Boolean).slice(0, 30);
    return { ok: true, count: results.length, results };
  },

  async system_info() {
    return { ok: true, ...(await getSystemInfo()) };
  },

  async set_volume({ level }) {
    const v = Math.round(Number(level));
    if (!Number.isFinite(v)) return { ok: false, error: "Volume must be a number 0-100." };
    const clamped = Math.max(0, Math.min(100, v));
    const r = await osascript([`set volume output volume ${clamped}`]);
    return r.ok
      ? { ok: true, message: `Volume set to ${clamped}%.` }
      : { ok: false, error: r.error };
  },

  async get_volume() {
    const r = await run("osascript", ["-e", "output volume of (get volume settings)"]);
    return r.ok
      ? { ok: true, volume: Number(r.output) }
      : { ok: false, error: r.error };
  },

  async media_control({ action }) {
    const commands = { play_pause: "playpause", next: "next track", previous: "previous track" };
    const cmd = commands[action];
    if (!cmd) {
      return { ok: false, error: "action must be play_pause, next or previous." };
    }
    for (const app of ["Spotify", "Music"]) {
      const running = await run("pgrep", ["-x", app]);
      if (!running.ok) continue;
      const r = await osascript([`tell application "${app}" to ${cmd}`]);
      if (r.ok) {
        return { ok: true, message: `${action.replace("_", " ")} sent to ${app}.` };
      }
    }
    return { ok: false, error: "No media player is running. Open Spotify or Music first." };
  },

  async screenshot() {
    if (!IS_MAC) return { ok: false, error: "Screenshots are macOS-only in this build." };
    const dest = path.join(HOME, "Desktop", `Jarvis_${stamp()}.png`);
    const r = await run("screencapture", ["-x", dest], { timeout: 15000 });
    return r.ok
      ? { ok: true, message: `Screenshot saved to ${dest}.`, path: dest }
      : { ok: false, error: r.error };
  },

  async notify({ title, message }) {
    const r = await osascript([
      `display notification "${appleString(message || "Task complete.")}" with title "${appleString(
        title || "J.A.R.V.I.S."
      )}"`,
    ]);
    return r.ok ? { ok: true, message: "Notification shown." } : { ok: false, error: r.error };
  },

  async clipboard_get() {
    const r = await run("pbpaste");
    return r.ok ? { ok: true, content: r.output.slice(0, 5000) } : { ok: false, error: r.error };
  },

  async clipboard_set({ text }) {
    const copied = await pbcopy(String(text ?? "").slice(0, 100000));
    return copied
      ? { ok: true, message: "Copied to clipboard." }
      : { ok: false, error: "Could not access the clipboard." };
  },

  async lock_screen() {
    const r = await run("pmset", ["displaysleepnow"]);
    return r.ok ? { ok: true, message: "Locking the display." } : { ok: false, error: r.error };
  },
};

export async function runTool(name, args, ctx = {}) {
  const handler = handlers[name];
  if (!handler) return { ok: false, error: `Unknown tool "${name}".` };
  try {
    const clean = args && typeof args === "object" ? args : {};
    return await handler(clean, ctx);
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
