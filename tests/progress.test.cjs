"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { CDP, launch, waitFor, delay } = require("./cdp.cjs");
const ROOT = path.resolve(__dirname, "..");
const SHADOW = 'document.querySelector("#learn-bilingual-reader")?.shadowRoot';
const STORAGE = "https://learn.microsoft.com/en-us/azure/storage/common/storage-account-overview";
const TRAINING = "https://learn.microsoft.com/zh-cn/training/modules/introduction-prompt-engineering-with-github-copilot/3-github-copilot-user-prompt-process-flow";

async function openPage(page, url) {
  const previous = (await page.send("Page.getFrameTree")).frameTree.frame.loaderId;
  await page.send("Page.navigate", { url });
  await waitFor(async () => (await page.send("Page.getFrameTree")).frameTree.frame.loaderId !== previous,
    "新文章已提交");
  await waitFor(() => page.evaluate(`Boolean(${SHADOW}?.querySelector(".launcher button"))`), "对照入口");
  await page.evaluate(`(() => {
    const root = ${SHADOW};
    if (!root.querySelector("dialog").open) root.querySelector(".launcher button").click();
  })()`);
  await waitFor(() => page.evaluate(`${SHADOW}?.querySelectorAll("article h1").length === 2`), "官方双语正文");
  await delay(300);
}

async function setProgress(page, locale, from, to = from, fraction = 0) {
  return page.evaluate(`(() => {
    const pane = ${SHADOW}.querySelector('.pane[data-locale="${locale}"]');
    const find = id => [...pane.querySelectorAll("[id]")].find(node => node.id === id);
    const first = find(${JSON.stringify(from)}).getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 16;
    const last = find(${JSON.stringify(to)}).getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 16;
    pane.scrollTop = first + (last - first) * ${fraction};
    return pane.scrollTop;
  })()`);
}

async function closeReader(page, method = "button") {
  if (method === "escape") {
    for (const type of ["keyDown", "keyUp"]) {
      await page.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    }
  } else {
    const point = await page.evaluate(`(() => {
      const rect = ${SHADOW}.querySelector('[data-action="close"]').getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await page.send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
    }
  }
  await waitFor(() => page.evaluate(`!${SHADOW}.querySelector("dialog").open`), "收起返回原页");
  await delay(150);
}

async function originalPoint(page, from, to = from, fraction = 0) {
  return page.evaluate(`(() => {
    const first = document.getElementById(${JSON.stringify(from)}).getBoundingClientRect().top;
    const last = document.getElementById(${JSON.stringify(to)}).getBoundingClientRect().top;
    return { point: first + (last - first) * ${fraction}, y: scrollY, max: document.scrollingElement.scrollHeight - innerHeight };
  })()`);
}

test("收起后按对照阅读进度返回原页", { timeout: 180000 }, async t => {
  const edge = await launch(ROOT);
  const { page } = edge;
  t.after(() => edge.close());

  await t.test("英文原页按章节内进度恢复，不返回打开前位置，并保留原页样式", async () => {
    await openPage(page, STORAGE);
    await closeReader(page);
    const before = await page.evaluate(`(() => {
      document.documentElement.style.setProperty("overflow", "auto", "important");
      document.body.style.setProperty("overflow", "visible");
      window.scrollTo({top: 300, behavior: "instant"});
      return { y: scrollY, html: document.documentElement.style.overflow,
        priority: document.documentElement.style.getPropertyPriority("overflow"), body: document.body.style.overflow };
    })()`);
    await page.evaluate(`${SHADOW}.querySelector(".launcher button").click()`);
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
    await delay(150);
    const readerTop = await setProgress(page, "en-us", "storage-account-name", "storage-account-workloads", 0.4);
    await delay(150);
    await closeReader(page);
    const after = await originalPoint(page, "storage-account-name", "storage-account-workloads", 0.4);
    assert.ok(Math.abs(after.point - 16) < 3, `原页对应阅读点应接近栏顶：${JSON.stringify(after)}`);
    assert.ok(Math.abs(after.y - before.y) > 100);
    assert.ok(Math.abs(after.y - readerTop) > 100, "不同排版不能直接复制 scrollTop");
    assert.deepEqual(await page.evaluate(`({
      html: document.documentElement.style.overflow,
      priority: document.documentElement.style.getPropertyPriority("overflow"), body: document.body.style.overflow
    })`), { html: before.html, priority: before.priority, body: before.body });
    if (process.env.ARTIFACTS_DIR) {
      const screenshot = await page.send("Page.captureScreenshot", { format: "png" });
      await fs.writeFile(path.join(process.env.ARTIFACTS_DIR, "learn-bilingual-original-progress.png"), Buffer.from(screenshot.data, "base64"));
    }
  });

  await t.test("中文原页在交换左右、关闭同步后跟随最后操作的英文栏，Esc 行为相同", async () => {
    await openPage(page, STORAGE.replace("/en-us/", "/zh-cn/"));
    await page.evaluate(`(() => {
      const root = ${SHADOW};
      if (root.querySelector('input[type="checkbox"]').checked) root.querySelector('input[type="checkbox"]').click();
      if (root.querySelector(".pane").dataset.locale !== "en-us") root.querySelector('[data-action="swap"]').click();
    })()`);
    await setProgress(page, "zh-cn", "types-of-storage-accounts");
    await delay(100);
    const rect = await page.evaluate(`(() => {
      const pane = ${SHADOW}.querySelector('.pane[data-locale="en-us"]');
      const box = pane.getBoundingClientRect();
      return { x: box.x + pane.clientWidth / 2, y: box.y + 180 };
    })()`);
    await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...rect, deltaX: 0, deltaY: 600 });
    await delay(150);
    await setProgress(page, "en-us", "storage-account-name", "storage-account-workloads", 0.25);
    await delay(150);
    await closeReader(page, "escape");
    const point = await originalPoint(page, "storage-account-name", "storage-account-workloads", 0.25);
    assert.ok(Math.abs(point.point - 16) < 4, `应跟随英文栏进度而不是仍在前面的中文栏：${JSON.stringify(point)}`);
    await page.evaluate(`${SHADOW}.querySelector(".launcher button").click()`);
    await closeReader(page);
    assert.ok(Math.abs((await originalPoint(page, "storage-account-name", "storage-account-workloads", 0.25)).point - 16) < 4,
      "重新打开再收起但未改变进度时，不应改用另一栏的旧进度");
    await page.evaluate(`${SHADOW}.querySelector(".launcher button").click()`);
    await setProgress(page, "zh-cn", "storage-account-name");
    await delay(150);
    await closeReader(page);
    assert.ok(Math.abs((await originalPoint(page, "storage-account-name")).point - 16) < 3);
  });

  await t.test("培训单元返回进度时避开原页顶部固定单元菜单", async () => {
    await openPage(page, TRAINING);
    await waitFor(() => page.evaluate(`[...document.querySelectorAll("#module-unit-content img")].every(img => img.complete)`),
      "原页培训插图完成布局");
    await setProgress(page, "zh-cn", "2-proxy-filter");
    await delay(150);
    await closeReader(page);
    const point = await originalPoint(page, "2-proxy-filter");
    const menuBottom = await page.evaluate(`document.querySelector('[data-bi-name="module-nav"]').parentElement.getBoundingClientRect().bottom`);
    assert.ok(point.point >= menuBottom + 8 && point.point <= menuBottom + 24,
      `阅读标题不应被菜单遮住：${JSON.stringify({point: point.point, menuBottom})}`);
  });

  await t.test("没有共有锚点时仅按正文范围映射比例，末尾不跳到站点页脚", async () => {
    await openPage(page, STORAGE);
    await page.evaluate(`(() => {
      const root = ${SHADOW};
      const input = root.querySelector('input[type="checkbox"]');
      if (input.checked) input.click();
      for (const heading of document.querySelectorAll("main .content h2[id], main .content h3[id], main .content h4[id]")) {
        heading.removeAttribute("id");
      }
      const footer = document.createElement("footer");
      footer.style.height = "4000px";
      footer.textContent = "测试用站点页脚，不属于正文";
      document.body.append(footer);
      const pane = root.querySelector('.pane[data-locale="en-us"]');
      pane.scrollTop = (pane.scrollHeight - pane.clientHeight) / 2;
    })()`);
    await delay(150);
    await closeReader(page);
    const result = await page.evaluate(`(() => {
      const blocks = [...document.querySelectorAll("main .content")];
      const title = blocks.map(b => b.querySelector("h1")).find(Boolean);
      const bodies = blocks.filter(b => b.querySelector("p,pre,table,ul,ol,dl,h2,h3") && b.textContent.trim().length > 20);
      const start = title.getBoundingClientRect().top + scrollY - 16;
      const end = Math.max(...bodies.map(b => b.getBoundingClientRect().bottom + scrollY)) - innerHeight + 16;
      return { y: scrollY, expected: start + (end - start) / 2 };
    })()`);
    assert.ok(Math.abs(result.y - result.expected) < 3, JSON.stringify(result));
    await page.evaluate(`${SHADOW}.querySelector(".launcher button").click()`);
    await page.evaluate(`(() => {
      const pane = ${SHADOW}.querySelector('.pane[data-locale="en-us"]');
      pane.scrollTop = pane.scrollHeight;
    })()`);
    await delay(150);
    await closeReader(page);
    const bottom = await page.evaluate(`Math.max(...[...document.querySelectorAll("main .content")]
      .filter(b => b.querySelector("p,pre,table,ul,ol,dl,h2,h3") && b.textContent.trim().length > 20)
      .map(b => b.getBoundingClientRect().bottom))`);
    assert.ok(Math.abs(bottom - (await page.evaluate("innerHeight")) + 16) < 3);
  });

  await t.test("单栏失败仍跟随可读版本，读取失败或尚在加载时保留原位置", async () => {
    await openPage(page, STORAGE.replace("/en-us/", "/zh-cn/"));
    const targets = await (await fetch(`http://127.0.0.1:${edge.port}/json/list`)).json();
    const worker = await CDP.connect(targets.find(item =>
      item.type === "service_worker" && item.url.endsWith("/background.js")).webSocketDebuggerUrl);
    await worker.evaluate(`(() => {
      globalThis.__progressFetch = fetch;
      globalThis.__progressMode = "partial";
      globalThis.fetch = async (url, options) => {
        if (__progressMode === "slow") {
          return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("cancelled"))));
        }
        if (__progressMode === "all" || new URL(url).pathname.startsWith("/zh-cn/")) {
          return new Response("", { status: 404 });
        }
        return __progressFetch(url, options);
      };
    })()`);
    try {
      await page.evaluate(`${SHADOW}.querySelector('[data-action="reload"]').click()`);
      await waitFor(() => page.evaluate(`${SHADOW}.querySelector('.pane[data-locale="zh-cn"]').textContent.includes("HTTP 404") &&
        Boolean(${SHADOW}.querySelector('.pane[data-locale="en-us"] article'))`), "仅英文可读");
      await setProgress(page, "en-us", "storage-account-name");
      await delay(100);
      await closeReader(page);
      assert.ok(Math.abs((await originalPoint(page, "storage-account-name")).point - 16) < 3);
      for (const mode of ["all", "slow"]) {
        await page.evaluate("window.scrollTo({top:450,behavior:'instant'})");
        const before = await page.evaluate("scrollY");
        await worker.evaluate(`__progressMode = ${JSON.stringify(mode)}`);
        await page.evaluate(`${SHADOW}.querySelector(".launcher button").click()`);
        await page.evaluate(`${SHADOW}.querySelector('[data-action="reload"]').click()`);
        if (mode === "all") {
          await waitFor(() => page.evaluate(`${SHADOW}.querySelectorAll(".message.error").length === 2`), "两个版本均失败");
        }
        await closeReader(page);
        assert.equal(await page.evaluate("scrollY"), before, "没有成功读取的正文时不应伪造阅读进度");
      }
    } finally {
      await worker.evaluate("globalThis.fetch = __progressFetch");
      worker.close();
    }
  });

  await t.test("没有滚动空间时返回标题，SPA 变更不把旧文章进度写到新页", async () => {
    await openPage(page, STORAGE);
    await page.evaluate(`(() => {
      const root = ${SHADOW};
      const input = root.querySelector('input[type="checkbox"]');
      if (input.checked) input.click();
      const article = root.querySelector('.pane[data-locale="en-us"] article');
      article.replaceChildren(article.querySelector("h1"));
      article.parentElement.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    })()`);
    await delay(150);
    await closeReader(page);
    const title = await page.evaluate('document.querySelector("main .content h1").getBoundingClientRect().top');
    assert.ok(Math.abs(title - 16) < 3);
    await openPage(page, STORAGE);
    await setProgress(page, "en-us", "storage-account-name");
    await delay(100);
    await page.evaluate(`(() => {
      const auto = ${SHADOW}.querySelectorAll('input[type="checkbox"]')[1];
      if (auto.checked) auto.click();
      history.pushState({}, "", location.pathname + "?progress-navigation=1");
      window.scrollTo({top:230,behavior:"instant"});
    })()`);
    await waitFor(() => page.evaluate(`!${SHADOW}.querySelector("dialog").open`), "地址变更收起旧文章");
    assert.equal(await page.evaluate("scrollY"), 230, "内部导航清理不能覆盖新页面位置");
  });
});
