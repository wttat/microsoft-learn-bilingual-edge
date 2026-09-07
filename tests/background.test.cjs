"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const Core = require("../core.js");
const code = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const PAGE = "https://learn.microsoft.com/en-us/azure/storage/common/storage-account-overview?view=azure#name";

function harness(fetcher, timers = {}) {
  let listener;
  let onRemoved;
  const warnings = [];
  const session = new Map();
  const storage = {
    async get(key) {
      if (timers.storageFailure) throw new Error("storage unavailable");
      return { [key]: session.get(key) };
    },
    async set(values) {
      if (timers.storageFailure) throw new Error("storage unavailable");
      for (const [key, value] of Object.entries(values)) session.set(key, value);
    },
    async remove(key) {
      if (timers.storageFailure) throw new Error("storage unavailable");
      session.delete(key);
    }
  };
  vm.runInNewContext(code, {
    importScripts() {}, LearnBilingualCore: Core, fetch: fetcher, AbortController, TextDecoder,
    setTimeout: timers.setTimeout || setTimeout, clearTimeout: timers.clearTimeout || clearTimeout,
    console: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
    chrome: {
      runtime: { id: "test-extension", onMessage: { addListener(fn) { listener = fn; } } },
      storage: { session: storage },
      tabs: { onRemoved: { addListener(fn) { onRemoved = fn; } } },
      action: { onClicked: { addListener() {} } }
    }
  });
  function message(overrides = {}, senderOverrides = {}) {
    return new Promise(resolve => listener(
      { type: "load-pair", url: PAGE, requestId: "1", ...overrides },
      { id: "test-extension", tab: { id: 7, url: PAGE }, frameId: 0, url: PAGE, ...senderOverrides }, resolve
    ));
  }
  return { message, warnings, session, removeTab: tabId => onRemoved(tabId) };
}

function htmlResponse(url, status = 200) {
  const response = new Response("<html><p>official</p></html>", {
    status, headers: { "content-type": "text/html" }
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

test("后台并发读取两个官方版本，保留 view，去掉 hash，禁用凭据和重定向", async () => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const worker = harness(async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 2) release();
    await gate;
    return htmlResponse(url);
  });
  const result = await worker.message();
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.includes("/zh-cn/"));
  assert.ok(calls[1].url.includes("/en-us/"));
  for (const call of calls) {
    assert.ok(call.url.endsWith("?view=azure"));
    assert.equal(call.options.redirect, "manual");
    assert.equal(call.options.credentials, "omit");
  }
  assert.equal(result.results["zh-cn"].ok, true);
  assert.equal(result.results["en-us"].ok, true);
});

test("404、非成功 HTTP、重定向、非 HTML 和网络故障均明确失败", async () => {
  for (const [fetcher, expected] of [
    [async url => htmlResponse(url, 404), "NOT_FOUND"],
    [async url => htmlResponse(url, 503), "HTTP"],
    [async () => ({ type: "opaqueredirect", status: 0 }), "REDIRECT"],
    [async url => ({ ok: true, status: 200, url, headers: new Headers({ "content-type": "application/json" }) }), "CONTENT_TYPE"],
    [async () => { throw new TypeError("network"); }, "NETWORK"]
  ]) {
    const result = await harness(fetcher).message();
    assert.equal(result.results["zh-cn"].ok, false);
    assert.equal(result.results["zh-cn"].code, expected);
    assert.equal(result.results["en-us"].code, expected);
  }
});

test("超时可恢复，再次请求能够成功", async () => {
  let shouldTimeout = true;
  const worker = harness(async (url, { signal }) => {
    if (!shouldTimeout) return htmlResponse(url);
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("abort"))));
  }, { setTimeout: fn => setTimeout(fn, 10) });
  const failed = await worker.message();
  assert.equal(failed.results["zh-cn"].code, "TIMEOUT");
  shouldTimeout = false;
  const success = await worker.message({ requestId: "2" });
  assert.equal(success.results["zh-cn"].ok, true);
});

test("正文大小限制同时覆盖 Content-Length 与实际流式字节", async () => {
  for (const declared of [true, false]) {
    const worker = harness(async url => {
      const response = new Response(declared ? "small" : "x".repeat(6 * 1024 * 1024 + 1), {
        headers: {
          "content-type": "text/html",
          ...(declared ? { "content-length": String(6 * 1024 * 1024 + 1) } : {})
        }
      });
      Object.defineProperty(response, "url", { value: url });
      return response;
    });
    const result = await worker.message();
    assert.equal(result.results["zh-cn"].code, "TOO_LARGE");
    assert.equal(result.results["en-us"].code, "TOO_LARGE");
  }
});

test("新请求取消陈旧并发读取，取消消息仅影响对应请求", async () => {
  let slow = true;
  const worker = harness(async (url, { signal }) => {
    if (!slow) return htmlResponse(url);
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("abort"))));
  });
  const first = worker.message({ requestId: "old" });
  slow = false;
  const second = worker.message({ requestId: "new" });
  assert.equal((await first).results["zh-cn"].code, "CANCELLED");
  assert.equal((await second).results["zh-cn"].ok, true);
});

test("消息拒绝伪造来源、iframe、任意主机和不属于当前页的文章", async () => {
  let calls = 0;
  const worker = harness(async url => { calls++; return htmlResponse(url); });
  for (const [message, sender] of [
    [{ url: "https://evil.test/en-us/x" }, {}],
    [{ url: "https://learn.microsoft.com/en-us/other" }, {}],
    [{}, { frameId: 1 }], [{}, { id: "other-extension" }],
    [{}, { url: "https://evil.test/en-us/azure" }],
    [{}, { tab: { id: 7, url: "https://evil.test/en-us/azure" } }],
    [{}, { tab: { id: 7 } }],
    [{ requestId: 123 }, {}]
  ]) assert.equal((await worker.message(message, sender)).ok, false);
  assert.equal(calls, 0);
});

test("SPA 页面使用浏览器提供的当前标签页地址，保留原始文档来源校验", async () => {
  const current = "https://learn.microsoft.com/en-us/training/modules/example/7-summary?view=test#section";
  const calls = [];
  const worker = harness(async url => { calls.push(url); return htmlResponse(url); });
  const result = await worker.message({ url: current }, { url: PAGE, tab: { id: 7, url: current } });
  assert.equal(result.ok, true);
  assert.equal(result.results["en-us"].ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1], current.split("#")[0]);
  const before = calls.length;
  assert.equal((await worker.message({ url: PAGE }, { tab: { id: 7, url: current } })).ok, false);
  assert.equal((await worker.message({ url: current }, {
    url: "https://evil.test/en-us/source", tab: { id: 7, url: current }
  })).ok, false);
  assert.equal(calls.length, before);
});

test("切换单元后可取消旧地址的请求，但必须匹配请求 ID 和原地址", async () => {
  const worker = harness(async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("abort")));
  }));
  const first = worker.message({ requestId: "old" });
  const current = "https://learn.microsoft.com/en-us/training/modules/example/7-summary";
  const sender = { tab: { id: 7, url: current } };
  const wrongId = await worker.message({ type: "cancel-pair", requestId: "other" }, sender);
  const wrongURL = await worker.message({ type: "cancel-pair", requestId: "old", url: current }, sender);
  const cancelled = await worker.message({ type: "cancel-pair", requestId: "old" }, sender);
  const result = await first;
  assert.equal(wrongId.cancelled, false);
  assert.equal(wrongURL.cancelled, false);
  assert.equal(cancelled.cancelled, true);
  assert.equal(result.results["zh-cn"].code, "CANCELLED");
});

test("阅读模式按标签页保存，目标页只恢复一次且不触发正文请求", async () => {
  let calls = 0;
  const worker = harness(async url => { calls++; return htmlResponse(url); });
  const destination = "https://learn.microsoft.com/en-us/training/modules/example/next?view=test#section";
  const prepare = await worker.message({ type: "navigation-state", destination });
  assert.equal(prepare.ok, true);
  assert.equal(worker.session.get("reader-navigation:7").url, destination.split("#")[0]);
  assert.equal((await worker.message({ type: "navigation-state" }, { tab: { id: 8, url: PAGE } })).resume, false);
  assert.ok(worker.session.has("reader-navigation:7"));
  const resume = () => worker.message(
    { type: "navigation-state", url: destination },
    { url: destination, tab: { id: 7, url: destination } }
  );
  assert.equal((await resume()).resume, true);
  assert.equal((await resume()).resume, false);
  assert.equal(worker.session.size, 0);
  assert.equal(calls, 0);
});

test("过期或不匹配的跳转状态不会自动打开其他页，关闭标签页清理状态", async () => {
  const worker = harness(async url => htmlResponse(url));
  const destination = "https://learn.microsoft.com/en-us/training/modules/example/next";
  await worker.message({ type: "navigation-state", destination });
  assert.equal((await worker.message({ type: "navigation-state" })).resume, false);
  assert.equal(worker.session.size, 0);
  worker.session.set("reader-navigation:7", { url: Core.pageKey(PAGE), expires: 0 });
  assert.equal((await worker.message({ type: "navigation-state" })).resume, false);
  assert.equal(worker.session.size, 0);
  await worker.message({ type: "navigation-state", destination });
  worker.session.set("reader-navigation:8", { url: destination, expires: Date.now() + 60000 });
  worker.removeTab(7);
  assert.equal(worker.session.has("reader-navigation:7"), false);
  assert.equal(worker.session.has("reader-navigation:8"), true);
});

test("拒绝非法跳转目标和来源，不把存储故障当作跳转成功", async () => {
  const worker = harness(async url => htmlResponse(url));
  for (const destination of [
    PAGE, "javascript:alert(1)", "https://evil.test/en-us/next",
    "https://learn.microsoft.com/zh-cn/next", "https://learn.microsoft.com/en-us/"
  ]) assert.equal((await worker.message({ type: "navigation-state", destination })).ok, false);
  const destination = "https://learn.microsoft.com/en-us/training/modules/example/next";
  assert.equal((await worker.message({ type: "navigation-state", destination }, { frameId: 1 })).ok, false);
  assert.equal((await worker.message({ type: "navigation-state", destination }, {
    tab: { id: 7, url: destination }
  })).ok, false);
  assert.equal(worker.session.size, 0);
  const broken = harness(async url => htmlResponse(url), { storageFailure: true });
  for (const message of [{ type: "navigation-state", destination }, { type: "navigation-state" }]) {
    const result = await broken.message(message);
    assert.equal(result.ok, false);
    assert.match(result.message, /无法保存或恢复阅读状态/);
  }
});
