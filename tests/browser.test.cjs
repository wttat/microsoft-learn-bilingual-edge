"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { CDP, launch, waitFor, delay } = require("./cdp.cjs");
const Core = require("../core.js");
const ROOT = path.resolve(__dirname, "..");
const SHADOW = 'document.querySelector("#learn-bilingual-reader")?.shadowRoot';
const PAGE = "https://learn.microsoft.com/en-us/azure/storage/common/storage-account-overview";

function fixture(locale = "zh-cn", contentLocale = locale, type = "conceptual") {
  return `<!doctype html><html lang="${locale}"><head>
    <meta name="locale" content="${locale}"><meta name="ms.contentlocale" content="${contentLocale}">
    <meta name="page_type" content="${type}">
    <link rel="canonical" href="https://learn.microsoft.com/${locale}/azure/test"></head>
    <body><nav>站点导航不应出现</nav><main id="main" lang="${locale}"><div data-main-column>
    <div class="content"><h1 id="overview">官方标题</h1></div>
    <nav><h2 id="ms--in-this-article">目录不应出现</h2></nav>
    <div class="content"><p onclick="window.pwned=1">这里是用于验证安全抽取的官方示例正文。</p>
    <h2 id="stable-id">翻译后的章节标题</h2><ul><li>列表条目</li></ul>
    <pre><code class="language-js">const answer = 42;</code></pre>
    <table><tr><th scope="col">表头</th><td colspan="2">表格单元</td></tr></table>
    <a href="../next?view=v1#section">相对链接</a><a href="#stable-id">章节链接</a>
    <a href="javascript:window.pwned=2">危险链接</a>
    <img src="./media/official.png" alt="示例图" onerror="window.pwned=3">
    <img src="https://evil.test/tracker.png">
    <script>window.pwned=4</script><iframe src="https://evil.test/"></iframe>
    <object data="https://evil.test/x"></object><svg onload="window.pwned=5"><script>x</script></svg>
    <style>body { display:none }</style><div style="background:url(https://evil.test/x)" onmouseover="x()">保留文本</div>
    <form><input autofocus onfocus="x()"></form><custom-tag>未知标签内的文本</custom-tag>
    </div><footer class="content"><p>反馈与页脚不应出现，反馈与页脚不应出现。</p></footer>
    </div></main></body></html>`;
}

async function snapshot(page) {
  return page.evaluate(`(() => {
    const s = ${SHADOW};
    if (!s) return null;
    return {
      opened: s.querySelector("dialog").open,
      status: s.querySelector(".status").textContent,
      panes: [...s.querySelectorAll(".pane")].map(p => ({
        locale: p.dataset.locale,
        top: p.scrollTop, max: p.scrollHeight - p.clientHeight,
        title: p.querySelector("h1")?.textContent, text: p.textContent,
        tables: p.querySelectorAll("table").length,
        anchors: [...p.querySelectorAll("h2[id],h3[id],h4[id],h5[id],h6[id]")].map(h => ({
          id: h.id, top: h.getBoundingClientRect().top - p.getBoundingClientRect().top + p.scrollTop - 16
        })),
        rect: { x: p.getBoundingClientRect().x, y: p.getBoundingClientRect().y,
          width: p.clientWidth, height: p.clientHeight }
      }))
    };
  })()`);
}

function assertAligned(state) {
  const [left, right] = state.panes;
  const pairs = Core.anchorPairs(left.anchors, right.anchors, left.max, right.max);
  assert.ok(Math.abs(Core.mapScroll(left.top, pairs) - right.top) < 5,
    `滚动未对齐：左 ${left.top}，右 ${right.top}，预期右 ${Core.mapScroll(left.top, pairs)}`);
}

async function wheel(page, index, delta) {
  const state = await snapshot(page);
  const rect = state.panes[index].rect;
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseWheel", x: rect.x + rect.width / 2, y: rect.y + Math.min(200, rect.height / 2),
    deltaX: 0, deltaY: delta
  });
  await delay(700);
  return snapshot(page);
}

async function floatingButton(page, selector) {
  return page.evaluate(`(() => {
    const root = ${SHADOW};
    const button = root.querySelector(${JSON.stringify(selector)});
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button.closest(".floating-control"));
    return {
      x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      right: rect.right, bottom: rect.bottom,
      rightGap: innerWidth - rect.right, bottomGap: innerHeight - rect.bottom,
      position: style.position, cssRight: style.right, cssBottom: style.bottom,
      inReader: root.querySelector("dialog").contains(button),
      inToolbar: root.querySelector(".toolbar").contains(button),
      clickable: root.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === button
    };
  })()`);
}

async function clickFloating(page, selector) {
  const rect = await floatingButton(page, selector);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", {
      type, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
      button: "left", clickCount: 1
    });
  }
}

test("真实 Edge 扩展与官方文章端到端", { timeout: 240000 }, async t => {
  const edge = await launch(ROOT);
  const { page, browser } = edge;
  t.after(() => edge.close());

  await t.test("在浏览器 DOM 中抽取、净化、修复链接并拒绝回退和列表页", async () => {
    const sources = await Promise.all(["core.js", "article.js"].map(file => fs.readFile(path.join(ROOT, file), "utf8")));
    await page.evaluate(sources.join("\n"));
    const result = await page.evaluate(`(() => {
      const item = LearnBilingualArticle.extractArticle(${JSON.stringify(fixture())},
        "https://learn.microsoft.com/zh-cn/azure/test", "zh-cn");
      const a = item.article;
      return { html: a.outerHTML, text: a.textContent, title: item.title,
        hrefs: [...a.querySelectorAll("a")].map(x => x.getAttribute("href")),
        images: [...a.querySelectorAll("img")].map(x => x.src),
        bad: a.querySelectorAll("script,iframe,object,svg,style,form,[onclick],[onerror],[style]").length,
        executed: Boolean(window.pwned) };
    })()`);
    assert.equal(result.title, "官方标题");
    assert.equal(result.bad, 0);
    assert.equal(result.executed, false);
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0], "https://learn.microsoft.com/zh-cn/azure/media/official.png");
    assert.equal(result.hrefs[0], "https://learn.microsoft.com/zh-cn/next?view=v1#section");
    assert.equal(result.hrefs[1], "https://learn.microsoft.com/zh-cn/azure/test#stable-id");
    assert.equal(result.hrefs[2], null);
    assert.ok(!result.text.includes("不应出现"));
    assert.ok(result.html.includes("<table>") && result.html.includes("<pre>") && result.html.includes("<ul>"));
    for (const [html, code] of [[fixture("zh-cn", "en-us"), "LANGUAGE_FALLBACK"], [fixture("zh-cn", "zh-cn", "landing"), "NOT_ARTICLE"]]) {
      const actual = await page.evaluate(`(() => {
        try { LearnBilingualArticle.extractArticle(${JSON.stringify(html)},
          "https://learn.microsoft.com/zh-cn/azure/test", "zh-cn"); return "unexpected-success"; }
        catch (e) { return e.code; }
      })()`);
      assert.equal(actual, code);
    }
    const versioned = fixture("zh-cn", "zh-cn", "dotnet")
      .replace("</head>", '<meta name="default_moniker" content="net-10.0"><meta name="monikers" content="net-9.0"><meta name="monikers" content="net-10.0"></head>')
      .replace('<h2 id="stable-id">', '<p data-moniker="net-9.0">只属于第九版</p><p data-moniker="net-10.0">只属于第十版</p><h2 id="stable-id">');
    const versionResult = await page.evaluate(`(() => {
      const a = LearnBilingualArticle.extractArticle(${JSON.stringify(versioned)},
        "https://learn.microsoft.com/zh-cn/azure/test?view=net-9.0", "zh-cn");
      return { text: a.article.textContent, version: a.version };
    })()`);
    assert.equal(versionResult.version, "net-9.0");
    assert.ok(versionResult.text.includes("只属于第九版"));
    assert.ok(!versionResult.text.includes("只属于第十版"));
  });

  await t.test("实际加载 MV3 并获取真实官方中文和英文正文", async () => {
    await page.send("Page.navigate", { url: PAGE });
    await waitFor(async () => {
      const state = await snapshot(page);
      return state?.panes.every(pane => pane.title) && state;
    }, "真实官方双语正文", 90000);
    const targets = await browser.send("Target.getTargets");
    assert.ok(targets.targetInfos.some(target => target.type === "service_worker" && target.url.endsWith("/background.js")),
      "必须实际运行扩展后台，不能用页面脚本模拟扩展加载");
    const state = await snapshot(page);
    assert.equal(state.opened, true);
    assert.match(state.panes[0].title, /存储.*概述/);
    assert.match(state.panes[1].title, /Overview of storage accounts/i);
    assert.ok(state.panes.every(pane => pane.tables > 0 && pane.max > 1000));
    assert.ok(state.panes[0].anchors.some(heading => heading.id === "storage-account-name"));
    assert.ok(state.panes[1].anchors.some(heading => heading.id === "storage-account-name"));
    assert.ok(state.panes.every(pane => !pane.anchors.some(heading => heading.id === "ms--feedback")));
    t.diagnostic(`真实中文：${state.panes[0].title}；真实英文：${state.panes[1].title}`);
  });

  await t.test("真实鼠标滚轮双向驱动、同步关闭与重新启用，无持续回环", async () => {
    let state = await wheel(page, 0, 950);
    assert.ok(state.panes[0].top > 500 && state.panes[1].top > 500);
    assertAligned(state);
    const previous = state.panes[1].top;
    state = await wheel(page, 1, 800);
    assert.ok(state.panes[1].top > previous);
    assertAligned(state);
    state = await wheel(page, 1, -650);
    assertAligned(state);
    const stopped = state.panes.map(pane => pane.top);
    await delay(700);
    assert.deepEqual((await snapshot(page)).panes.map(pane => pane.top), stopped);
    await page.evaluate(`${SHADOW}.querySelector('input[type="checkbox"]').click()`);
    const independent = await wheel(page, 1, 500);
    assert.equal(independent.panes[0].top, stopped[0]);
    assert.ok(independent.panes[1].top > stopped[1]);
    await page.evaluate(`${SHADOW}.querySelector('input[type="checkbox"]').click()`);
    await delay(300);
    assertAligned(await snapshot(page));
  });

  await t.test("栏内锚点导航、布局改变和窗口缩放重新计算同步关系", async () => {
    await page.evaluate(`(() => {
      const a = document.createElement("a");
      a.href = ${JSON.stringify(PAGE + "#storage-account-name")};
      a.textContent = "章节跳转";
      const article = ${SHADOW}.querySelectorAll("article")[1];
      article.prepend(a); a.click(); a.remove();
    })()`);
    await delay(400);
    assertAligned(await snapshot(page));
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 820, deviceScaleFactor: 1, mobile: false });
    await delay(500);
    assertAligned(await snapshot(page));
    const imageHeight = await page.evaluate(`new Promise((resolve, reject) => {
      const image = document.createElement("img");
      image.alt = "验证官方图片延迟载入";
      image.onload = () => resolve(image.getBoundingClientRect().height);
      image.onerror = () => reject(new Error("官方示例图片载入失败"));
      ${SHADOW}.querySelector("article").prepend(image);
      setTimeout(() => { image.src = "https://learn.microsoft.com/en-us/media/open-graph-image.png"; }, 200);
    })`);
    assert.ok(imageHeight > 0);
    await delay(400);
    assertAligned(await snapshot(page));
  });

  await t.test("右下角悬浮收起与原页入口对齐，真实鼠标点击恢复原页并可重新打开", async subtest => {
    subtest.after(async () => {
      if (!(await snapshot(page)).opened) await clickFloating(page, ".launcher button");
    });
    const close = await floatingButton(page, '[data-action="close"]');
    assert.equal(close.position, "fixed");
    assert.ok(close.rightGap >= 24);
    assert.ok(close.bottomGap >= 24);
    assert.equal(close.inReader, true, "收起按钮必须在原生模态框内部才可操作");
    assert.equal(close.inToolbar, false);
    assert.equal(close.clickable, true);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: close.x + close.width / 2, y: close.y + close.height / 2 });
    assert.deepEqual(await page.evaluate(`(() => {
      const style = getComputedStyle(${SHADOW}.querySelector('[data-action="close"]'));
      return [style.color, style.backgroundColor];
    })()`), ["rgb(255, 255, 255)", "rgb(0, 103, 184)"], "鼠标悬停时应保留白字蓝底的可读性");
    await wheel(page, 1, 350);
    assert.deepEqual(await floatingButton(page, '[data-action="close"]'), close, "正文滚动不应移动悬浮按钮");
    await clickFloating(page, '[data-action="close"]');
    assert.equal((await snapshot(page)).opened, false);
    const launcher = await floatingButton(page, ".launcher button");
    assert.equal(launcher.position, "fixed");
    assert.equal(launcher.rightGap, close.rightGap);
    assert.equal(launcher.bottomGap, close.bottomGap);
    assert.equal(launcher.right, close.right, "打开与收起入口应在同一右下角位置");
    assert.equal(launcher.bottom, close.bottom);
    assert.equal(launcher.clickable, true);
    await page.evaluate(`(() => {
      const root = ${SHADOW};
      root.querySelector(".launcher").hidden = true;
      root.querySelector(".launcher button").click();
    })()`);
    const initiallyHidden = await floatingButton(page, '[data-action="close"]');
    assert.equal(initiallyHidden.right, close.right, "原入口临时隐藏时打开阅读器也不能把收起按钮移出屏幕");
    assert.equal(initiallyHidden.bottom, close.bottom);
    assert.equal(initiallyHidden.clickable, true);
    await clickFloating(page, '[data-action="close"]');
    await page.evaluate(`document.documentElement.style.setProperty("overflow", "auto", "important");
      document.body.style.setProperty("overflow", "visible");
      window.scrollTo({ top: 750, behavior: "instant" });`);
    await delay(300);
    const before = await page.evaluate(`({ y: scrollY, html: document.documentElement.style.getPropertyValue("overflow"),
      priority: document.documentElement.style.getPropertyPriority("overflow"), body: document.body.style.overflow })`);
    await clickFloating(page, ".launcher button");
    assert.equal((await snapshot(page)).opened, true);
    await clickFloating(page, '[data-action="close"]');
    await delay(300);
    const after = await page.evaluate(`({ y: scrollY, html: document.documentElement.style.getPropertyValue("overflow"),
      priority: document.documentElement.style.getPropertyPriority("overflow"), body: document.body.style.overflow })`);
    assert.deepEqual(after, before);
    await clickFloating(page, ".launcher button");
    assert.equal((await snapshot(page)).opened, true);
    assert.equal(await page.evaluate('document.querySelectorAll("#learn-bilingual-reader").length'), 1);
    await page.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
    await delay(200);
    const resizedClose = await floatingButton(page, '[data-action="close"]');
    assert.equal(resizedClose.rightGap, close.rightGap);
    assert.equal(resizedClose.bottomGap, close.bottomGap);
    await clickFloating(page, '[data-action="close"]');
    const resizedLauncher = await floatingButton(page, ".launcher button");
    assert.equal(resizedLauncher.right, resizedClose.right);
    assert.equal(resizedLauncher.bottom, resizedClose.bottom);
    await clickFloating(page, ".launcher button");
    for (const type of ["keyDown", "keyUp"]) {
      await page.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    }
    assert.equal((await snapshot(page)).opened, false);
    await clickFloating(page, ".launcher button");
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await delay(200);
    if (process.env.ARTIFACTS_DIR) {
      const screenshot = await page.send("Page.captureScreenshot", { format: "png" });
      await fs.writeFile(path.join(process.env.ARTIFACTS_DIR, "learn-bilingual-floating-close.png"), Buffer.from(screenshot.data, "base64"));
    }
  });

  await t.test("真实扩展界面处理模拟 404、英文回退、同文回退及重试，陈旧结果不能覆盖新请求", async () => {
    const targets = await (await fetch(`http://127.0.0.1:${edge.port}/json/list`)).json();
    const target = targets.find(item => item.type === "service_worker" && item.url.endsWith("/background.js"));
    assert.ok(target);
    const worker = await CDP.connect(target.webSocketDebuggerUrl);
    await worker.send("Runtime.enable");
    const chinese = fixture().replace(/<img[^>]*>/g, "");
    const english = fixture("en-us").replace(/<img[^>]*>/g, "").replace("官方标题", "Official sample");
    await worker.evaluate(`(() => {
      globalThis.__originalFetch = fetch;
      globalThis.__mode = "404";
      globalThis.__releases = [];
      globalThis.fetch = async (url, options) => {
        const locale = new URL(url).pathname.split("/")[1];
        const mode = __mode;
        if (mode === "normal" || (locale === "en-us" && ["404", "fallback"].includes(mode))) {
          return __originalFetch(url, options);
        }
        let html = locale === "zh-cn" ? ${JSON.stringify(chinese)} : ${JSON.stringify(english)};
        if (mode === "fallback") html = ${JSON.stringify(fixture("zh-cn", "en-us"))};
        if (mode === "same" && locale === "en-us") html = ${JSON.stringify(chinese.replaceAll("zh-cn", "en-us"))};
        if (mode === "slow" || mode === "new") html = html.replace("官方标题", mode === "new" ? "新请求的官方中文标题" : "旧请求的中文标题");
        const response = new Response(html, {
          status: mode === "404" ? 404 : 200, headers: { "content-type": "text/html" }
        });
        Object.defineProperty(response, "url", { value: url });
        if (mode === "slow") await new Promise(resolve => __releases.push(resolve));
        return response;
      };
    })()`);
    try {
      const reload = async () => page.evaluate(`${SHADOW}.querySelector('[data-action="reload"]').click()`);
      await reload();
      await waitFor(async () => (await snapshot(page))?.panes[0].text.includes("HTTP 404"), "404 说明");
      assert.ok((await snapshot(page)).panes[1].title);
      await worker.evaluate('__mode = "fallback"');
      await reload();
      await waitFor(async () => (await snapshot(page))?.panes[0].text.includes("已回退"), "语言回退说明");
      assert.ok(!(await snapshot(page)).panes[0].title);
      await worker.evaluate('__mode = "same"');
      await reload();
      await waitFor(async () => (await snapshot(page))?.panes[0].text.includes("完全相同"), "同文回退说明");
      await worker.evaluate('__mode = "slow"');
      await reload();
      await waitFor(() => worker.evaluate("__releases.length === 2"), "两个慢请求已发出");
      await page.evaluate(`${SHADOW}.querySelector('[data-action="close"]').click()`);
      await worker.evaluate('__mode = "new"');
      await page.evaluate(`${SHADOW}.querySelector(".launcher button").click()`);
      await waitFor(async () => (await snapshot(page))?.panes[0].title === "新请求的官方中文标题", "新请求正文");
      await worker.evaluate("__releases.forEach(resolve => resolve())");
      await delay(400);
      assert.equal((await snapshot(page)).panes[0].title, "新请求的官方中文标题");
      await worker.evaluate('__mode = "normal"');
      await reload();
      await waitFor(async () => (await snapshot(page))?.panes[1].title === "Overview of storage accounts", "恢复真实官方请求");
      assert.match((await snapshot(page)).panes[0].title, /存储.*概述/);
      const toggle = `chrome.tabs.query({ url: ${JSON.stringify(PAGE + "*")} }).then(tabs =>
        chrome.tabs.sendMessage(tabs[0].id, { type: "toggle-reader" }))`;
      assert.equal((await worker.evaluate(toggle)).ok, true);
      assert.equal((await snapshot(page)).opened, false);
      assert.equal((await worker.evaluate(toggle)).ok, true);
      assert.equal((await snapshot(page)).opened, true);
    } finally {
      await worker.evaluate("globalThis.fetch = __originalFetch; __releases.forEach(resolve => resolve())");
      worker.close();
    }
  });

  await t.test("自动打开设置保存在本机，关闭后仍可手动展开", async () => {
    await page.evaluate(`${SHADOW}.querySelectorAll('input[type="checkbox"]')[1].click()`);
    await delay(250);
    const previous = (await page.send("Page.getFrameTree")).frameTree.frame.loaderId;
    await page.send("Page.reload");
    await waitFor(async () => (await page.send("Page.getFrameTree")).frameTree.frame.loaderId !== previous, "刷新已提交新文档");
    await waitFor(() => page.evaluate(`Boolean(${SHADOW}?.querySelector(".launcher button"))`), "关闭自动打开后的页面入口");
    assert.equal((await snapshot(page)).opened, false);
    await page.evaluate(`${SHADOW}.querySelector(".launcher button").click()`);
    await waitFor(async () => (await snapshot(page))?.panes.every(pane => pane.title), "手动展开官方正文");
    await page.evaluate(`${SHADOW}.querySelectorAll('input[type="checkbox"]')[1].click()`);
    await delay(250);
  });

  await t.test("真实 .NET 参考文章保留 view 并筛选相应版本的正文", async () => {
    const url = "https://learn.microsoft.com/en-us/dotnet/api/system.string?view=net-9.0";
    await page.send("Page.navigate", { url });
    await waitFor(async () => (await snapshot(page))?.panes.every(pane => pane.title), "真实带版本参数的参考文章", 90000);
    const state = await snapshot(page);
    assert.match(state.panes[0].title, /String/);
    assert.match(state.panes[1].title, /String Class/);
    assert.ok(state.panes[1].text.includes("System.Runtime.dll"));
    const originalLinks = await page.evaluate(`[...${SHADOW}.querySelectorAll(".original")].map(a => a.href)`);
    assert.ok(originalLinks.every(url => url.endsWith("?view=net-9.0")));
    assertAligned(await wheel(page, 1, 600));
  });

  await t.test("中文入口与初始 hash，首页不自动误抓", async () => {
    await page.send("Page.navigate", { url: PAGE.replace("/en-us/", "/zh-cn/") + "#storage-account-name" });
    await waitFor(async () => (await snapshot(page))?.panes.every(pane => pane.title), "中文入口");
    await delay(400);
    const state = await snapshot(page);
    assert.ok(state.panes[0].top > 100, JSON.stringify({
      url: await page.evaluate("location.href"),
      panes: state.panes.map(pane => ({
        title: pane.title, top: pane.top, max: pane.max,
        anchor: pane.anchors.find(anchor => anchor.id === "storage-account-name")
      }))
    }));
    assertAligned(state);
    if (process.env.ARTIFACTS_DIR) {
      const screenshot = await page.send("Page.captureScreenshot", { format: "png" });
      await fs.writeFile(path.join(process.env.ARTIFACTS_DIR, "learn-bilingual-edge.png"), Buffer.from(screenshot.data, "base64"));
    }
    await page.send("Page.navigate", { url: "https://learn.microsoft.com/zh-cn/" });
    await delay(4000);
    assert.equal(await page.evaluate(`Boolean(${SHADOW}?.querySelector("dialog[open]"))`), false);
  });

  await t.test("简化栏头并交换整栏，保留位置、同步、语言归属和保存的顺序", async () => {
    await page.send("Page.navigate", { url: PAGE });
    await waitFor(async () => (await snapshot(page))?.panes.every(pane => pane.title), "交换前的官方正文");
    assert.deepEqual(await page.evaluate(`[...${SHADOW}.querySelectorAll(".column-header h2")].map(h => h.textContent)`),
      ["中文", "英文"]);
    const targets = await (await fetch(`http://127.0.0.1:${edge.port}/json/list`)).json();
    const target = targets.find(item => item.type === "service_worker" && item.url.endsWith("/background.js"));
    assert.ok(target);
    const worker = await CDP.connect(target.webSocketDebuggerUrl);
    await worker.send("Runtime.enable");
    await worker.evaluate(`(() => {
      globalThis.__swapReads = 0;
      globalThis.__swapOriginalFetch = fetch;
      chrome.runtime.onMessage.addListener(message => {
        if (message.type === "load-pair") __swapReads++;
      });
    })()`);
    const swap = () => page.evaluate(`${SHADOW}.querySelector('[data-action="swap"]').click()`);
    const reload = () => page.evaluate(`${SHADOW}.querySelector('[data-action="reload"]').click()`);
    const byLocale = state => Object.fromEntries(state.panes.map(pane => [pane.locale, pane.top]));
    try {
      await page.evaluate(`${SHADOW}.querySelector('input[type="checkbox"]').click()`);
      await page.evaluate(`(() => {
        const panes = [...${SHADOW}.querySelectorAll(".pane")];
        globalThis.__swapArticles = Object.fromEntries(panes.map(p => [p.dataset.locale, p.querySelector("article")]));
        panes[0].scrollTop = 650;
        panes[1].scrollTop = 1350;
      })()`);
      await delay(200);
      const before = byLocale(await snapshot(page));
      await swap();
      await delay(200);
      let state = await snapshot(page);
      assert.deepEqual(state.panes.map(pane => pane.locale), ["en-us", "zh-cn"]);
      assert.ok(state.panes[0].rect.x < state.panes[1].rect.x);
      assert.deepEqual(byLocale(state), before);
      assert.equal(await worker.evaluate("__swapReads"), 0, "交换不能重新请求正文");
      assert.equal(await page.evaluate(`[...${SHADOW}.querySelectorAll(".pane")].every(p =>
        p.querySelector("article") === __swapArticles[p.dataset.locale])`), true, "应移动现有正文，而非重建正文");
      const columns = await page.evaluate(`[...${SHADOW}.querySelectorAll(".column")].map(c => ({
        heading: c.querySelector(".column-header h2").textContent,
        locale: c.querySelector(".pane").dataset.locale,
        url: c.querySelector(".original").href
      }))`);
      assert.deepEqual(columns.map(column => column.heading), ["英文", "中文"]);
      assert.ok(columns.every(column => Core.localeOf(column.url) === column.locale));
      assert.equal(await page.evaluate(`${SHADOW}.querySelector('[data-action="swap"]').getAttribute("aria-pressed")`), "true");
      await swap();
      await delay(150);
      assert.deepEqual((await snapshot(page)).panes.map(pane => pane.locale), ["zh-cn", "en-us"]);
      assert.deepEqual(byLocale(await snapshot(page)), before);
      await swap();
      await page.evaluate(`${SHADOW}.querySelector('input[type="checkbox"]').click()`);
      await delay(300);
      assertAligned(await snapshot(page));
      assertAligned(await wheel(page, 0, 500));
      assertAligned(await wheel(page, 1, 400));
      const synced = byLocale(await snapshot(page));
      await swap();
      await delay(200);
      state = await snapshot(page);
      assertAligned(state);
      for (const pane of state.panes) assert.ok(Math.abs(pane.top - synced[pane.locale]) < 2);
      await swap();
      await delay(200);
      await page.evaluate(`(() => {
        const article = ${SHADOW}.querySelector('article[lang="en-us"]');
        const link = document.createElement("a");
        link.href = ${JSON.stringify(PAGE + "#storage-account-name")};
        link.textContent = "章节跳转";
        article.append(link); link.click(); link.remove();
      })()`);
      await delay(300);
      state = await snapshot(page);
      assertAligned(state);
      const english = state.panes.find(pane => pane.locale === "en-us");
      assert.ok(Math.abs(english.top - english.anchors.find(anchor => anchor.id === "storage-account-name").top) < 2);

      await worker.evaluate(`globalThis.fetch = async (url, options) =>
        new URL(url).pathname.startsWith("/zh-cn/")
          ? new Response("", { status: 404, headers: { "content-type": "text/html" } })
          : __swapOriginalFetch(url, options)`);
      await reload();
      await waitFor(async () => (await snapshot(page))?.panes[1].text.includes("HTTP 404"), "交换后错误仍属于中文栏");
      state = await snapshot(page);
      assert.equal(state.panes[0].title, "Overview of storage accounts");
      assert.equal(state.panes[1].locale, "zh-cn");
      await worker.evaluate("globalThis.fetch = __swapOriginalFetch");
      await reload();
      await waitFor(async () => (await snapshot(page))?.panes.every(pane => pane.title), "交换后的重新读取");
      assert.deepEqual((await snapshot(page)).panes.map(pane => pane.locale), ["en-us", "zh-cn"]);
      await waitFor(() => worker.evaluate('chrome.storage.local.get("swapped").then(values => values.swapped === true)'),
        "左右顺序已保存");
      const previous = (await page.send("Page.getFrameTree")).frameTree.frame.loaderId;
      await page.send("Page.reload");
      await waitFor(async () => (await page.send("Page.getFrameTree")).frameTree.frame.loaderId !== previous, "刷新已提交新文档");
      await waitFor(async () => (await snapshot(page))?.panes.every(pane => pane.title), "刷新后恢复左右顺序");
      state = await snapshot(page);
      assert.deepEqual(state.panes.map(pane => pane.locale), ["en-us", "zh-cn"]);
      assert.equal(state.panes[0].title, "Overview of storage accounts");
      assert.match(state.panes[1].title, /存储.*概述/);
      if (process.env.ARTIFACTS_DIR) {
        const screenshot = await page.send("Page.captureScreenshot", { format: "png" });
        await fs.writeFile(path.join(process.env.ARTIFACTS_DIR, "learn-bilingual-swapped.png"), Buffer.from(screenshot.data, "base64"));
      }
    } finally {
      await worker.evaluate("globalThis.fetch = __swapOriginalFetch");
      worker.close();
    }
  });
});
