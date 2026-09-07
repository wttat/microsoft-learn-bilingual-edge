"use strict";
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.counter = 0;
    this.pending = new Map();
    this.events = new Map();
    socket.addEventListener("message", event => {
      const packet = JSON.parse(event.data);
      if (packet.id) {
        const pending = this.pending.get(packet.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(packet.id);
        if (packet.error) pending.reject(new Error(JSON.stringify(packet.error)));
        else pending.resolve(packet.result);
      } else {
        for (const listener of this.events.get(packet.method) || []) listener(packet.params);
      }
    });
    socket.addEventListener("close", () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("浏览器调试连接已关闭"));
      }
      this.pending.clear();
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new CDP(socket);
  }

  on(name, listener) {
    if (!this.events.has(name)) this.events.set(name, []);
    this.events.get(name).push(listener);
  }

  send(method, params = {}) {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`浏览器命令超时：${method}`));
      }, 45000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || JSON.stringify(response.exceptionDetails));
    }
    return response.result.value;
  }

  close() { this.socket.close(); }
}

async function waitFor(fn, message, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(150);
  }
  throw new Error(`等待超时：${message}`);
}

async function launch(root) {
  const executable = [
    process.env.EDGE_PATH,
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe")
  ].filter(Boolean).find(existsSync);
  if (!executable) throw new Error("未找到 Edge；请用 EDGE_PATH 指定浏览器可执行文件。");
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "learn-bilingual-smoke-"));
  const child = spawn(executable, [
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    "--window-size=1440,1000", `--user-data-dir=${profile}`,
    `--disable-extensions-except=${root}`, `--load-extension=${root}`, "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  child.stderr.on("data", chunk => { errors = (errors + chunk.toString()).slice(-6000); });
  let browser;
  let page;
  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    const portText = await waitFor(async () => {
      try {
        const text = await fs.readFile(portFile, "utf8");
        return text.includes("/devtools/browser/") && text;
      } catch (error) {
        if (["ENOENT", "EBUSY"].includes(error.code)) return false;
        throw error;
      }
    }, "Edge 调试端口启动", 30000);
    const [port, endpoint] = portText.trim().split(/\r?\n/);
    browser = await CDP.connect(`ws://127.0.0.1:${port}${endpoint}`);
    const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    page = await CDP.connect(targets.find(target => target.id === targetId).webSocketDebuggerUrl);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    return {
      browser, page, profile, port,
      async close() {
        page.close();
        await browser.send("Browser.close");
        browser.close();
        await delay(1200);
        await fs.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
      }
    };
  } catch (error) {
    page?.close();
    browser?.close();
    child.kill();
    await delay(1500);
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
    throw new Error(`${error.message}\n${errors}\n临时配置目录：${profile}`);
  }
}

module.exports = { CDP, launch, waitFor, delay };
