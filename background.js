"use strict";
importScripts("core.js");

const Core = globalThis.LearnBilingualCore;
const pending = new Map();
const TIMEOUT = 20000;
const MAX_BYTES = 6 * 1024 * 1024;

function validateSender(message, sender) {
  if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0) {
    throw Core.fail("INVALID_SENDER", "请求来源无效。");
  }
  Core.trustedURL(sender.url);
  Core.trustedURL(sender.tab.url);
  if (typeof message.url !== "string" || typeof message.requestId !== "string" ||
      !message.requestId || message.requestId.length > 100) {
    throw Core.fail("INVALID_MESSAGE", "文章请求与当前页面不符。");
  }
  const pageURL = Core.pageKey(message.url);
  // sender.url stays at document creation after SPA navigation; tab.url is browser-supplied and current.
  if (message.type === "load-pair" && Core.pageKey(sender.tab.url) !== pageURL) {
    throw Core.fail("INVALID_MESSAGE", "文章请求与当前页面不符。");
  }
  return pageURL;
}

async function readHTML(response) {
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    throw Core.fail("TOO_LARGE", "官方页面超过可读取的大小限制。");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw Core.fail("TOO_LARGE", "官方页面超过可读取的大小限制。");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const decoder = new TextDecoder();
  return chunks.map(chunk => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
}

async function fetchOfficial(value, parentSignal) {
  const url = Core.normalizeURL(value);
  url.hash = "";
  url.searchParams.delete("accept");
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal.addEventListener("abort", abort, { once: true });
  if (parentSignal.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT);
  try {
    const response = await fetch(url.href, {
      signal: controller.signal,
      credentials: "omit",
      redirect: "manual",
      referrerPolicy: "no-referrer",
      headers: { Accept: "text/html" }
    });
    // Manual redirects are opaque in Chromium. Never follow a redirect to an unapproved host.
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      throw Core.fail("REDIRECT", "官方地址发生了重定向；可能缺少此语言或文章已迁移。请先打开官方原文，再重新对照。");
    }
    if (response.status === 404) throw Core.fail("NOT_FOUND", "官方未找到此语言版本（HTTP 404）。");
    if (!response.ok) throw Core.fail("HTTP", `官方页面读取失败（HTTP ${response.status}），请稍后重试。`);
    Core.trustedURL(response.url);
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/html")) {
      throw Core.fail("CONTENT_TYPE", "官方返回的不是 HTML 正文页面。");
    }
    return { ok: true, url: response.url, html: await readHTML(response) };
  } catch (error) {
    if (timedOut) return { ok: false, code: "TIMEOUT", message: "读取官方页面超时（20 秒），请重试。" };
    if (parentSignal.aborted) return { ok: false, code: "CANCELLED", message: "已取消旧的文章请求。" };
    console.warn("Learn 中英对照：官方页面读取失败", url.href, error);
    return {
      ok: false, code: error.code || "NETWORK",
      message: error.code ? error.message : "无法连接官方页面，请检查网络后重试。"
    };
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", abort);
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || !["load-pair", "cancel-pair"].includes(message.type)) return false;
  let pageURL;
  try {
    pageURL = validateSender(message, sender);
  } catch (error) {
    console.warn("Learn 中英对照：已拒绝无效请求", error);
    respond({ ok: false, message: error.message });
    return false;
  }
  const tabId = sender.tab.id;
  if (message.type === "cancel-pair") {
    const previous = pending.get(tabId);
    const cancelled = previous?.id === message.requestId && previous.url === pageURL;
    if (cancelled) previous.controller.abort();
    respond({ ok: true, cancelled });
    return false;
  }
  pending.get(tabId)?.controller.abort();
  const request = { id: message.requestId, url: pageURL, controller: new AbortController() };
  pending.set(tabId, request);
  const urls = Core.pairURLs(message.url);
  Promise.all(Core.LOCALES.map(locale => fetchOfficial(urls[locale], request.controller.signal)))
    .then(results => respond({ ok: true, results: Object.fromEntries(Core.LOCALES.map((locale, i) => [locale, results[i]])) }))
    .catch(error => {
      console.error("Learn 中英对照：请求处理失败", error);
      respond({ ok: false, message: "扩展后台处理失败，请重试或重新加载扩展。" });
    })
    .finally(() => {
      if (pending.get(tabId) === request) pending.delete(tabId);
    });
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  pending.get(tabId)?.controller.abort();
  pending.delete(tabId);
});

chrome.action.onClicked.addListener(async tab => {
  try {
    Core.normalizeURL(tab.url);
    await chrome.tabs.sendMessage(tab.id, { type: "toggle-reader" });
    await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
    await chrome.action.setTitle({ tabId: tab.id, title: "打开或收起 Learn 官方中英对照" });
  } catch (error) {
    console.warn("Learn 中英对照：无法打开阅读器", error);
    await chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
    await chrome.action.setTitle({
      tabId: tab.id,
      title: "请打开 Learn 中英文文章；若刚加载或更新扩展，请先刷新网页。"
    });
  }
});
