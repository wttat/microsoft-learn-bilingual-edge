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
      localeTitles: Object.fromEntries([...root.querySelectorAll(".pane")].map(p =>
        [p.dataset.locale, p.querySelector("h1")?.textContent])),
      busy: Boolean(root.querySelector('[aria-busy="true"]')),
      text: root.querySelector(".columns").textContent
    } : null;
  })()`);
}

async function waitReading(page, expected, locale = "zh-cn") {
  return waitFor(async () => {
    const state = await reading(page);
    if (state?.open && !state.busy && state.text.includes("文章请求与当前页面不符")) {
      assert.fail("合法的同标签页单元切换被后台误拒绝：" + state.text);
    }
    return state?.localeTitles[locale] === expected && state.titles.length === 2 && state;
  }, `双语正文：${expected}`);
}

async function navigationButtons(page) {
  return page.evaluate(`(() => {
    const root = ${SHADOW};
    if (!root) return null;
    return Object.fromEntries(["previous", "next"].map(direction => {
      const button = root.querySelector('[data-action="' + direction + '"]');
      const rect = button.getBoundingClientRect();
      return [direction, { disabled: button.disabled, title: button.title,
        x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }];
    }));
  })()`);
}

async function clickNavigation(page, direction) {
  const button = await waitFor(async () => {
    const buttons = await navigationButtons(page);
    return buttons && !buttons[direction].disabled && buttons[direction];
  }, `${direction === "previous" ? "上一页" : "下一页"}可点击`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", { type, x: button.x, y: button.y, button: "left", clickCount: 1 });
  }
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
    await page.evaluate(`${SHADOW}.querySelector('[data-action="close"]').click()`);
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

    await page.evaluate(`${SHADOW}.querySelector('[data-action="close"]').click()`);
    await page.evaluate('document.querySelector(\'button[aria-controls="module-menu"]\').click()');
    const intro = await waitFor(() => page.evaluate(`(() => {
      const link = [...document.querySelectorAll("#module-menu a[href]")].find(a =>
        a.href.startsWith(${JSON.stringify(moduleURL)}) && !a.href.startsWith(${JSON.stringify(spaceURL)}));
      return link && { url: link.href, title: link.querySelector("span").textContent.trim() };
    })()`), "同一模块的首个单元");
    await page.send("Page.navigate", { url: intro.url });
    await waitReading(page, intro.title);
    const before = await page.evaluate("performance.timeOrigin");
    await page.evaluate(`${SHADOW}.querySelector('[data-action="close"]').click()`);
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

  await t.test("导航只采用官方单元顺序或明确前后页链接，保留版本并正确处理边界", async () => {
    const sources = (await Promise.all(["core.js", "article.js"].map(file =>
      fs.readFile(path.join(ROOT, file), "utf8")))).join("\n");
    await page.evaluate(sources);
    const result = await page.evaluate(`(() => {
      const base = "https://learn.microsoft.com/zh-cn/training/modules/example/current?view=net-9.0&preserve-view=true#part";
      const doc = new DOMParser().parseFromString(\`<html><head><meta name="schema" content="ModuleUnit"></head><body>
        <div id="module-menu">
        <a href="https://evil.test/first">外站</a>
        <a href="/en-us/training/modules/example/foreign">其他语言</a>
        <a href="../other-module/unit">其他模块</a>
        <a href="first/"><span>第一单元</span></a>
        <a href="current/">当前单元</a>
        <a href="summary/?view=net-10.0&keep=1#finish">最后单元</a>
        <a href="summary/">重复链接</a>
        <a href="javascript:alert(1)">危险链接</a>
        </div></body></html>\`, "text/html");
      const middle = LearnBilingualArticle.pageNavigation(doc, base);
      const first = LearnBilingualArticle.pageNavigation(doc, base.replace("/current?", "/first?"));
      const last = LearnBilingualArticle.pageNavigation(doc, base.replace("/current?", "/summary?"));
      const menu = doc.querySelector("#module-menu");
      const entries = [...menu.childNodes];
      menu.replaceChildren();
      const pending = LearnBilingualArticle.pageNavigation(doc, base);
      menu.append(...entries);
      const restored = LearnBilingualArticle.pageNavigation(doc, base);
      const article = new DOMParser().parseFromString(\`<html><head>
        <link rel="prev" href="javascript:alert(1)">
        <link rel="prev" href="before?view=net-8.0">
        <link rel="next" href="https://evil.test/next">
        </head><body><main>
        <a rel="next" href="current?view=net-10.0">同页版本</a>
        <a rel="next" href="after?keep=1#section">后续文章</a>
        </main></body></html>\`, "text/html");
      const explicit = LearnBilingualArticle.pageNavigation(article, "https://learn.microsoft.com/zh-cn/guide/current?view=net-9.0");
      const empty = LearnBilingualArticle.pageNavigation(new DOMParser().parseFromString("<main></main>", "text/html"), base);
      return { middle, first, last, pending, restored, explicit, empty };
    })()`);
    assert.equal(result.middle.previous.title, "第一单元");
    assert.equal(result.middle.previous.url, "https://learn.microsoft.com/zh-cn/training/modules/example/first?view=net-9.0&preserve-view=true");
    assert.equal(result.middle.next.url, "https://learn.microsoft.com/zh-cn/training/modules/example/summary?view=net-10.0&keep=1&preserve-view=true#finish");
    assert.equal(result.first.previous, null);
    assert.match(result.first.previousReason, /第一页/);
    assert.equal(result.last.next, null);
    assert.match(result.last.nextReason, /最后一页/);
    assert.equal(result.pending.previous, null);
    assert.equal(result.pending.next, null);
    assert.match(result.pending.nextReason, /尚未就绪/);
    assert.deepEqual(result.restored, result.middle);
    assert.equal(result.explicit.previous.url, "https://learn.microsoft.com/zh-cn/guide/before?view=net-8.0");
    assert.equal(result.explicit.next.url, "https://learn.microsoft.com/zh-cn/guide/after?keep=1&view=net-9.0#section");
    assert.equal(result.empty.previous, null);
    assert.equal(result.empty.next, null);
  });

  await t.test("顶部按钮无需收起即可前后翻页，关闭自动打开和交换左右后仍保持对照", async () => {
    const unit = "https://learn.microsoft.com/zh-cn/training/modules/introduction-copilot-spaces/2-create-first-space";
    await page.send("Page.navigate", { url: unit });
    await waitReading(page, "创建第一个空间");
    await waitFor(async () => {
      const buttons = await navigationButtons(page);
      return buttons && !buttons.previous.disabled && !buttons.next.disabled;
    }, "官方单元目录自动就绪");
    const units = await page.evaluate(`[...document.querySelectorAll("#module-menu a[href]")].map(a =>
      ({url:a.href, title:a.querySelector("span").textContent.trim()}))`);
    const index = units.findIndex(item => Core.pageKey(item.url) === Core.pageKey(unit));
    assert.ok(index > 0 && index < units.length - 1);
    const buttons = await navigationButtons(page);
    assert.ok(buttons.previous.title.includes(units[index - 1].title));
    assert.ok(buttons.next.title.includes(units[index + 1].title));
    await page.evaluate(`${SHADOW}.querySelectorAll('input[type="checkbox"]')[1].click()`);
    await page.evaluate(`${SHADOW}.querySelector('[data-action="swap"]').click()`);
    await waitFor(() => worker.evaluate('chrome.storage.local.get(["auto","swapped"]).then(v => v.auto === false && v.swapped === true)'),
      "关闭自动打开并记住左右交换");

    const before = await page.evaluate("performance.timeOrigin");
    await clickNavigation(page, "previous");
    await waitReading(page, units[index - 1].title);
    assert.notEqual(before, await page.evaluate("performance.timeOrigin"), "新文档也应恢复手动打开的对照模式");
    assert.equal(Core.pageKey(await page.evaluate("location.href")), Core.pageKey(units[index - 1].url));
    assert.equal((await reading(page)).open, true);
    assert.equal(await page.evaluate(`${SHADOW}.querySelector(".pane").dataset.locale`), "en-us");
    assert.equal(await worker.evaluate('chrome.storage.local.get("auto").then(v => v.auto)'), false);
    if (index === 1) {
      await waitFor(async () => {
        const controls = await navigationButtons(page);
        return controls.previous.disabled && controls.previous.title.includes("第一页");
      }, "首个单元目录就绪后禁用上一页");
      assert.match((await navigationButtons(page)).previous.title, /第一页/);
    }
    await clickNavigation(page, "next");
    await waitReading(page, "创建第一个空间");
    await clickNavigation(page, "next");
    await waitReading(page, units[index + 1].title);
    assert.equal(Core.pageKey(await page.evaluate("location.href")), Core.pageKey(units[index + 1].url));
    await clickNavigation(page, "previous");
    await waitReading(page, "创建第一个空间");
    await waitFor(async () => {
      const controls = await navigationButtons(page);
      return !controls.previous.disabled && !controls.next.disabled;
    }, "返回当前单元后恢复前后页按钮");
    if (process.env.ARTIFACTS_DIR) {
      const screenshot = await page.send("Page.captureScreenshot", { format: "png" });
      await fs.writeFile(path.join(process.env.ARTIFACTS_DIR, "learn-bilingual-page-buttons.png"), Buffer.from(screenshot.data, "base64"));
    }

    const last = units.at(-1);
    await page.send("Page.navigate", { url: last.url });
    await waitFor(() => page.evaluate(`document.querySelector("#module-unit-title")?.textContent.trim() === ${JSON.stringify(last.title)} &&
      Boolean(${SHADOW}?.querySelector(".launcher button"))`), "直接打开最后单元");
    assert.equal((await reading(page)).open, false, "跳转意图不应泄露到后续无关导航");
    await page.evaluate(`${SHADOW}.querySelector(".launcher button").click()`);
    await waitReading(page, last.title);
    await waitFor(async () => {
      const controls = await navigationButtons(page);
      return controls?.next.disabled && controls.next.title.includes("最后一页");
    }, "最后单元禁用下一页");

    await page.send("Page.navigate", { url: "https://learn.microsoft.com/zh-cn/azure/storage/common/storage-account-overview" });
    await waitFor(() => page.evaluate(`Boolean(${SHADOW}?.querySelector(".launcher button"))`), "普通文档手动入口");
    await page.evaluate(`${SHADOW}.querySelector(".launcher button").click()`);
    await waitReading(page, "存储帐户概述");
    const unavailable = await navigationButtons(page);
    assert.equal(unavailable.previous.disabled, true);
    assert.equal(unavailable.next.disabled, true);
    assert.match(unavailable.previous.title, /未提供官方上一页/);
    assert.match(unavailable.next.title, /未提供官方下一页/);

    const englishURL = unit.replace("/zh-cn/", "/en-us/");
    await page.send("Page.navigate", { url: englishURL });
    await waitFor(() => page.evaluate(`document.querySelector("#module-unit-title")?.textContent.trim() === "Creating your first space" &&
      Boolean(${SHADOW}?.querySelector(".launcher button"))`), "英文入口");
    await page.evaluate(`${SHADOW}.querySelector(".launcher button").click()`);
    await waitReading(page, "Creating your first space", "en-us");
    await clickNavigation(page, "previous");
    await waitReading(page, units[index - 1].title);
    assert.equal(Core.pageKey(await page.evaluate("location.href")),
      Core.pageKey(units[index - 1].url.replace("/zh-cn/", "/en-us/")));
  });
});
