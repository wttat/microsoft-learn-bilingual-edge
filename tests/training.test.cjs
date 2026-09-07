"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { launch, waitFor, delay } = require("./cdp.cjs");
const Core = require("../core.js");
const ROOT = path.resolve(__dirname, "..");
const MODULE = "training/modules/introduction-prompt-engineering-with-github-copilot";
const UNIT = MODULE + "/3-github-copilot-user-prompt-process-flow";
const SHADOW = 'document.querySelector("#learn-bilingual-reader")?.shadowRoot';

function unitFixture(schema = "ModuleUnit") {
  return `<!doctype html><html lang="zh-cn"><head>
    <meta name="locale" content="zh-cn"><meta name="page_type" content="learn">
    <meta name="schema" content="${schema}"><meta name="ms.topic" content="unit"></head>
    <body><main id="main" lang="zh-cn">
    <nav data-bi-name="module-nav">不应导入的单元导航</nav>
    <div class="content"><div class="modular-content-container">
    <div id="unit-inner-section">
    <h1 id="module-unit-title">培训单元标题</h1>
    <div class="xp-tag">不应导入的经验值和完成状态</div>
    <ul id="module-unit-metadata"><li>不应导入的学习时长</li></ul>
    <div id="module-unit-notification-container">不应导入的通知</div>
    <div id="module-unit-content">
    <p>这里是完整的官方培训单元正文，只应显示正文和单元标题。</p>
    <h2 id="stable-section">章节标题</h2><ul><li>正文列表</li></ul>
    <pre><code>const value = 1;</code></pre>
    <img src="../../github/example/media/unit.png" alt="正文图片">
    <script>window.untrustedExecuted = true</script>
    </div>
    <div id="next-section"><h2>不应导入的下一单元</h2><a href="4-next">继续</a></div>
    </div></div></div>
    <section id="ms--unit-user-feedback">不应导入的反馈</section>
    </main></body></html>`;
}

async function readerState(page) {
  return page.evaluate(`(() => {
    const root = ${SHADOW};
    if (!root) return null;
    return {
      open: root.querySelector("dialog").open,
      panes: [...root.querySelectorAll(".pane")].map(p => ({
        title: p.querySelector("h1")?.textContent,
        top: p.scrollTop, max: p.scrollHeight - p.clientHeight,
        anchors: [...p.querySelectorAll("h2[id],h3[id],h4[id],h5[id],h6[id]")].map(h => ({
          id: h.id, top: h.getBoundingClientRect().top - p.getBoundingClientRect().top + p.scrollTop - 16
        })),
        rect: { x: p.getBoundingClientRect().x, y: p.getBoundingClientRect().y, width: p.clientWidth }
      }))
    };
  })()`);
}

test("培训单元识别回归", { timeout: 180000 }, async t => {
  const edge = await launch(ROOT);
  const { page } = edge;
  t.after(() => edge.close());
  const sources = (await Promise.all(
    ["core.js", "article.js"].map(file => fs.readFile(path.join(ROOT, file), "utf8"))
  )).join("\n");

  await t.test("learn＋ModuleUnit 只提取单元正文，排除模块目录和不完整结构", async () => {
    await page.evaluate(sources);
    const result = await page.evaluate(`(() => {
      const template = document.createElement("template");
      template.innerHTML = ${JSON.stringify(unitFixture())};
      const parts = LearnBilingualArticle.articleParts(template.content);
      if (!parts) return { recognized: false };
      const item = LearnBilingualArticle.extractArticle(${JSON.stringify(unitFixture())},
        "https://learn.microsoft.com/zh-cn/${UNIT}", "zh-cn");
      return { recognized: true, title: item.title, bodyId: parts.bodies[0].id,
        text: item.article.textContent, headings: item.article.querySelectorAll("h1").length,
        code: item.article.querySelector("pre code")?.textContent,
        image: item.article.querySelector("img")?.src,
        scripts: item.article.querySelectorAll("script").length };
    })()`);
    assert.equal(result.recognized, true, "截图中的 learn / ModuleUnit 模板必须被识别");
    assert.equal(result.title, "培训单元标题");
    assert.equal(result.bodyId, "module-unit-content");
    assert.equal(result.headings, 1);
    assert.ok(!result.text.includes("不应导入"));
    assert.equal(result.code, "const value = 1;");
    assert.equal(result.image, "https://learn.microsoft.com/zh-cn/training/github/example/media/unit.png");
    assert.equal(result.scripts, 0);
    for (const html of [
      unitFixture("Module"),
      unitFixture("LearningPath"),
      unitFixture().replace('id="module-unit-content"', 'id="missing-body"'),
      unitFixture().replace('id="module-unit-title"', 'id="missing-title"'),
      unitFixture().replace(/<div id="module-unit-content">[\s\S]*?<\/div>/, '<div id="module-unit-content"></div>')
    ]) {
      const recognized = await page.evaluate(`(() => {
        const template = document.createElement("template");
        template.innerHTML = ${JSON.stringify(html)};
        return Boolean(LearnBilingualArticle.articleParts(template.content));
      })()`);
      assert.equal(recognized, false);
    }
  });

  await t.test("截图中的真实中英文培训单元自动对照、双向滚动并可收起恢复", async () => {
    for (const locale of ["zh-cn", "en-us"]) {
      const url = `https://learn.microsoft.com/${locale}/${UNIT}`;
      await page.send("Page.navigate", { url });
      await waitFor(() => page.evaluate(`location.href === ${JSON.stringify(url)} && document.readyState === "complete" &&
        Boolean(document.querySelector("#module-unit-content"))`),
        "截图对应的官方培训单元已加载");
      await page.evaluate(sources);
      assert.equal(await page.evaluate("Boolean(LearnBilingualArticle.articleParts(document))"), true,
        `${locale} 页面不应再被识别为不支持的文章`);
      await waitFor(async () => (await readerState(page))?.panes.every(pane => pane.title), "官方双语培训正文");
      let state = await readerState(page);
      assert.equal(state.open, true);
      assert.equal(state.panes[0].title, "GitHub Copilot 用户提示进程流");
      assert.equal(state.panes[1].title, "GitHub Copilot user prompt process flow");
      assert.ok(state.panes.every(pane => pane.anchors.some(h => h.id === "1-secure-prompt-transmission-and-context-gathering")));
      const content = await page.evaluate(`(() => {
        const root = ${SHADOW};
        return {
          images: root.querySelectorAll("article img").length,
          unwanted: root.querySelectorAll("article #module-unit-metadata, article .xp-tag, article #next-section, article #ms--unit-user-feedback").length
        };
      })()`);
      assert.equal(content.images, 4);
      assert.equal(content.unwanted, 0);
      await waitFor(() => page.evaluate(`[...${SHADOW}.querySelectorAll("article img")].every(img => img.complete && img.naturalWidth > 0)`),
        "培训单元官方插图加载完成");
      for (const index of [0, 1]) {
        const rect = (await readerState(page)).panes[index].rect;
        const previous = (await readerState(page)).panes[index].top;
        await page.send("Input.dispatchMouseEvent", {
          type: "mouseWheel", x: rect.x + rect.width / 2, y: rect.y + 180, deltaX: 0, deltaY: 500
        });
        await delay(600);
        state = await readerState(page);
        assert.ok(state.panes[index].top > previous);
        const [left, right] = state.panes;
        const pairs = Core.anchorPairs(left.anchors, right.anchors, left.max, right.max);
        assert.ok(Math.abs(Core.mapScroll(left.top, pairs) - right.top) < 5, "培训单元双向滚动应保持章节对齐");
      }
      if (locale === "zh-cn" && process.env.ARTIFACTS_DIR) {
        const screenshot = await page.send("Page.captureScreenshot", { format: "png" });
        await fs.writeFile(path.join(process.env.ARTIFACTS_DIR, "learn-bilingual-training-fixed.png"), Buffer.from(screenshot.data, "base64"));
      }
      await page.evaluate(`${SHADOW}.querySelector('[data-action="close"]').click()`);
      assert.equal((await readerState(page)).open, false);
      assert.ok(await page.evaluate('document.querySelector("#module-unit-content").textContent.length > 500'));
      await page.evaluate(`${SHADOW}.querySelector(".launcher button").click()`);
      assert.equal((await readerState(page)).open, true);
    }
  });

  await t.test("同一课程的模块目录页仍不自动展开", async () => {
    const url = `https://learn.microsoft.com/zh-cn/${MODULE}/`;
    await page.send("Page.navigate", { url });
    await waitFor(() => page.evaluate(`location.href === ${JSON.stringify(url)} && document.readyState === "complete" &&
      Boolean(document.querySelector('meta[name="schema"]'))`),
      "官方模块目录页加载完成");
    await page.evaluate(sources);
    assert.equal(await page.evaluate('document.querySelector(\'meta[name="schema"]\').content'), "Module");
    assert.equal(await page.evaluate("Boolean(LearnBilingualArticle.articleParts(document))"), false);
    await delay(1000);
    assert.equal(await page.evaluate(`Boolean(${SHADOW}?.querySelector("dialog[open]"))`), false);
  });
});
