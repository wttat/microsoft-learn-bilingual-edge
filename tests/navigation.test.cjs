"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { CDP, launch, waitFor, delay } = require("./cdp.cjs");
const Core = require("../core.js");
const ROOT = path.resolve(__dirname, "..");
const MODULE = "https://learn.microsoft.com/zh-cn/training/modules/introduction-prompt-engineering-with-github-copilot/";
const START = MODULE + "3-github-copilot-user-prompt-process-flow";
const SUMMARY = MODULE + "7-summary";
const SHADOW = 'document.querySelector("#learn-bilingual-reader")?.shadowRoot';

async function reading(page) {
  return page.evaluate(`(() => {
    const root = ${SHADOW};
    return root ? {
      open: root.querySelector("dialog").open,
      titles: [...root.querySelectorAll("article h1")].map(h => h.textContent),
      busy: Boolean(root.querySelector('[aria-busy="true"]')),
      text: root.querySelector(".columns").textContent
    } : null;
  })()`);
}

async function waitReading(page, expected) {
  return waitFor(async () => {
    const state = await reading(page);
    if (state?.open && !state.busy && state.text.includes("文章请求与当前页面不符")) {
      assert.fail("合法的同标签页单元切换被后台误拒绝：" + state.text);
    }
    return state?.titles[0] === expected && state.titles.length === 2 && state;
  }, `双语正文：${expected}`);
}

test("培训单元导航和请求校验回归", { timeout: 180000 }, async t => {
  const edge = await launch(ROOT);
  const { page } = edge;
  t.after(() => edge.close());
  await page.send("Page.navigate", { url: START });
  await waitReading(page, "GitHub Copilot 用户提示进程流");
  const targets = await (await fetch(`http://127.0.0.1:${edge.port}/json/list`)).json();
  const target = targets.find(item => item.type === "service_worker" && item.url.endsWith("/background.js"));
  assert.ok(target);
  const worker = await CDP.connect(target.webSocketDebuggerUrl);
  t.after(() => worker.close());
  await worker.send("Runtime.enable");
  await worker.evaluate(`(() => {
    globalThis.__navigationMessages = [];
    chrome.runtime.onMessage.addListener((message, sender) => {
      __navigationMessages.push({
        type: message.type, url: message.url, senderURL: sender.url,
        tabURL: sender.tab?.url, documentId: sender.documentId
      });
    });
  })()`);

  await t.test("通过官方模块菜单切换到总结，重试及前进后退均可读取", async () => {
    await page.evaluate(`${SHADOW}.querySelector(".toolbar").lastElementChild.click()`);
    await page.evaluate('document.querySelector(\'button[aria-controls="module-menu"]\').click()');
    await delay(500);
    await waitFor(() => page.evaluate(`Boolean([...document.querySelectorAll("#module-menu a[href]")]
      .find(a => a.href === ${JSON.stringify(SUMMARY)} || a.href === ${JSON.stringify(SUMMARY + "/")}))`),
      "官方模块菜单中的总结链接", 10000);
    const before = await page.evaluate("performance.timeOrigin");
    await page.evaluate(`[...document.querySelectorAll("#module-menu a[href]")]
      .find(a => a.href === ${JSON.stringify(SUMMARY)} || a.href === ${JSON.stringify(SUMMARY + "/")}).click()`);
    await waitFor(() => page.evaluate(`(location.href === ${JSON.stringify(SUMMARY)} || location.href === ${JSON.stringify(SUMMARY + "/")}) &&
      document.querySelector("#module-unit-title")?.textContent.trim() === "总结"`), "官方页面切换到总结");
    const state = await waitReading(page, "总结");
    assert.equal(state.titles[1], "Summary");
    assert.equal(before, await page.evaluate("performance.timeOrigin"), "应覆盖真实同文档导航，而非整页刷新");
    const messages = await worker.evaluate("__navigationMessages");
    const request = messages.find(message => message.type === "load-pair" && message.url.startsWith(SUMMARY));
    assert.ok(request);
    assert.equal(request.senderURL, START);
    assert.equal(request.tabURL, request.url);
    await page.evaluate(`${SHADOW}.querySelector('[data-action="reload"]').click()`);
    await waitReading(page, "总结");
    if (process.env.ARTIFACTS_DIR) {
      const screenshot = await page.send("Page.captureScreenshot", { format: "png" });
      await fs.writeFile(path.join(process.env.ARTIFACTS_DIR, "learn-bilingual-summary-fixed.png"), Buffer.from(screenshot.data, "base64"));
    }
    await page.evaluate("history.back()");
    await waitFor(() => page.evaluate(`location.href === ${JSON.stringify(START)}`), "返回第三单元");
    await waitReading(page, "GitHub Copilot 用户提示进程流");
    await page.evaluate("history.forward()");
    await waitFor(() => page.evaluate(`location.href === ${JSON.stringify(SUMMARY)}`), "前进到总结单元");
    await waitReading(page, "总结");
  });

  await t.test("同文档 replaceState 改变查询参数后仍校验当前地址", async () => {
    await page.send("Page.navigate", { url: START });
    await waitFor(() => page.evaluate(`location.href === ${JSON.stringify(START)} && document.readyState === "complete"`),
      "重新打开第三单元");
    await waitReading(page, "GitHub Copilot 用户提示进程流");
    await page.evaluate('history.replaceState(history.state, "", location.pathname + "?bilingual-navigation=1#inbound-flow")');
    await waitFor(() => page.evaluate(`${SHADOW}?.querySelector(".original")?.href.includes("bilingual-navigation=1")`),
      "阅读器更新到新的查询参数");
    await delay(200);
    await waitReading(page, "GitHub Copilot 用户提示进程流");
  });

  await t.test("创建第一个空间支持直接打开、官方单元菜单切换及重试", async () => {
    const moduleURL = "https://learn.microsoft.com/zh-cn/training/modules/introduction-copilot-spaces/";
    const spaceURL = moduleURL + "2-create-first-space";
    await page.send("Page.navigate", { url: spaceURL });
    await waitFor(() => page.evaluate(`location.href === ${JSON.stringify(spaceURL)} && document.readyState === "complete"`),
      "创建第一个空间页面加载完成");
    let state = await waitReading(page, "创建第一个空间");
    assert.equal(state.titles[1], "Creating your first space");
    const manifest = JSON.parse(await fs.readFile(path.join(ROOT, "manifest.json"), "utf8"));
    assert.equal(await worker.evaluate("chrome.runtime.getManifest().version"), manifest.version);
    assert.deepEqual(await page.evaluate(`[...${SHADOW}.querySelectorAll(".column-header h2")].map(h => h.textContent)`),
      ["中文", "英文"]);
    assert.equal(await page.evaluate(`Boolean(${SHADOW}.querySelector('[data-action="swap"]'))`), true);

    await page.evaluate(`${SHADOW}.querySelector(".toolbar").lastElementChild.click()`);
    await page.evaluate('document.querySelector(\'button[aria-controls="module-menu"]\').click()');
    const intro = await waitFor(() => page.evaluate(`(() => {
      const link = [...document.querySelectorAll("#module-menu a[href]")].find(a =>
        a.href.startsWith(${JSON.stringify(moduleURL)}) && !a.href.startsWith(${JSON.stringify(spaceURL)}));
      return link && { url: link.href, title: link.querySelector("span").textContent.trim() };
    })()`), "同一模块的首个单元");
    await page.send("Page.navigate", { url: intro.url });
    await waitReading(page, intro.title);
    const before = await page.evaluate("performance.timeOrigin");
    await page.evaluate(`${SHADOW}.querySelector(".toolbar").lastElementChild.click()`);
    await page.evaluate('document.querySelector(\'button[aria-controls="module-menu"]\').click()');
    await waitFor(() => page.evaluate(`Boolean([...document.querySelectorAll("#module-menu a[href]")]
      .find(a => a.href === ${JSON.stringify(spaceURL)} || a.href === ${JSON.stringify(spaceURL + "/")}))`),
      "官方模块菜单中的创建第一个空间链接");
    await page.evaluate(`[...document.querySelectorAll("#module-menu a[href]")]
      .find(a => a.href === ${JSON.stringify(spaceURL)} || a.href === ${JSON.stringify(spaceURL + "/")}).click()`);
    await waitFor(() => page.evaluate(`document.querySelector("#module-unit-title")?.textContent.trim() === "创建第一个空间"`),
      "官方页面切换到创建第一个空间");
    state = await waitReading(page, "创建第一个空间");
    assert.equal(state.titles[1], "Creating your first space");
    assert.equal(before, await page.evaluate("performance.timeOrigin"), "应通过官方 SPA 导航进入该单元");
    const request = (await worker.evaluate("__navigationMessages"))
      .filter(message => message.type === "load-pair" && message.url.startsWith(spaceURL)).at(-1);
    assert.ok(request);
    assert.notEqual(Core.pageKey(request.senderURL), Core.pageKey(request.url));
    assert.equal(Core.pageKey(request.tabURL), Core.pageKey(request.url));
    await page.evaluate(`${SHADOW}.querySelector('[data-action="reload"]').click()`);
    await waitReading(page, "创建第一个空间");
    if (process.env.ARTIFACTS_DIR) {
      const screenshot = await page.send("Page.captureScreenshot", { format: "png" });
      await fs.writeFile(path.join(process.env.ARTIFACTS_DIR, "learn-bilingual-first-space.png"), Buffer.from(screenshot.data, "base64"));
    }
  });
});
