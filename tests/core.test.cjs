"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../core.js");

test("双向语言 URL 对映保留版本查询、重复参数和章节", () => {
  const pairs = Core.pairURLs("https://learn.microsoft.com/EN-us//dotnet/api/system.string/?view=net-9.0&viewFallbackFrom=net-8.0&a=1&a=2#methods");
  assert.equal(pairs["zh-cn"], "https://learn.microsoft.com/zh-cn/dotnet/api/system.string?view=net-9.0&viewFallbackFrom=net-8.0&a=1&a=2#methods");
  assert.equal(Core.pairURLs(pairs["zh-cn"])["en-us"], pairs["en-us"]);
  assert.equal(Core.pageKey(pairs["zh-cn"]), pairs["zh-cn"].split("#")[0]);
  assert.equal(Core.articleKey(pairs["zh-cn"]), Core.articleKey(pairs["en-us"]));
});

test("拒绝其他主机、凭据、危险路径、首页和不支持的语言", () => {
  for (const value of [
    "http://learn.microsoft.com/en-us/test", "https://learn.microsoft.com.evil.test/en-us/test",
    "https://evil.test/en-us/test", "https://user:pass@learn.microsoft.com/en-us/test",
    "https://learn.microsoft.com:444/en-us/test", "https://learn.microsoft.com/en-us/%2ftest",
    "https://learn.microsoft.com/zh-cn/", "https://learn.microsoft.com/",
    "https://learn.microsoft.com/fr-fr/test", "javascript:alert(1)"
  ]) assert.throws(() => Core.pairURLs(value), { code: /INVALID_URL|NOT_ARTICLE_URL/ });
});

test("官方语言验证不能把英文回退冒充中文", () => {
  const valid = {
    requestedLocale: "zh-cn",
    finalURL: "https://learn.microsoft.com/zh-cn/azure/test",
    locale: "zh-cn", mainLanguage: "zh-cn", contentLocale: "zh-cn",
    canonical: "https://learn.microsoft.com/zh-cn/azure/test"
  };
  assert.doesNotThrow(() => Core.validateLanguage(valid));
  for (const patch of [
    { contentLocale: "en-us" }, { mainLanguage: "en-us" },
    { finalURL: "https://learn.microsoft.com/en-us/azure/test" },
    { canonical: "https://learn.microsoft.com/en-us/azure/test" }
  ]) assert.throws(() => Core.validateLanguage({ ...valid, ...patch }), { code: "LANGUAGE_FALLBACK" });
  assert.throws(() => Core.validateLanguage({
    requestedLocale: "zh-cn", finalURL: valid.finalURL
  }), { code: "LANGUAGE_UNKNOWN" });
});

test("链接修复仅允许安全协议，图片只允许 Learn 源", () => {
  const base = "https://learn.microsoft.com/zh-cn/azure/storage/common/overview?view=test";
  assert.equal(Core.safeURL("../images/a.png", base, true), "https://learn.microsoft.com/zh-cn/azure/storage/images/a.png");
  assert.equal(Core.safeURL("#section", base), base + "#section");
  assert.equal(Core.safeURL("https://example.org/docs", base), "https://example.org/docs");
  for (const value of ["javascript:alert(1)", "data:text/html,x", "file:///C:/x", "vbscript:x"]) {
    assert.equal(Core.safeURL(value, base), null);
  }
  assert.equal(Core.safeURL("https://example.org/tracker.png", base, true), null);
  assert.equal(Core.safeURL("data:image/svg+xml,x", base, true), null);
});

test("按稳定 ID 和高度插值双向对齐，而非使用翻译标题", () => {
  const left = [{ id: "name", top: 100 }, { id: "only-zh", top: 200 }, { id: "billing", top: 400 }];
  const right = [{ id: "name", top: 300 }, { id: "billing", top: 900 }];
  const pairs = Core.anchorPairs(left, right, 1000, 2000);
  assert.deepEqual(pairs, [[0, 0], [100, 300], [400, 900], [1000, 2000]]);
  assert.equal(Core.mapScroll(250, pairs), 600);
  assert.equal(Core.mapScroll(600, pairs, 1), 250);
  assert.equal(Core.mapScroll(1000, pairs), 2000);
  for (let top = 0; top <= 1000; top += 5) {
    assert.ok(Math.abs(Core.mapScroll(Core.mapScroll(top, pairs), pairs, 1) - top) < 0.0001);
  }
});

test("无对应章节比例退化，乱序、重复和短页面始终有限", () => {
  assert.equal(Core.mapScroll(250, Core.anchorPairs([], [], 1000, 600)), 150);
  assert.equal(Core.mapScroll(100, Core.anchorPairs([], [], 0, 500)), 0);
  assert.equal(Core.mapScroll(100, Core.anchorPairs([], [], 500, 0), 1), 0);
  const pairs = Core.anchorPairs(
    [{ id: "a", top: 100 }, { id: "b", top: 300 }, { id: "a", top: 400 }, { id: "c", top: 500 }],
    [{ id: "b", top: 100 }, { id: "a", top: 300 }, { id: "c", top: 700 }], 1000, 1000
  );
  assert.deepEqual(pairs, [[0, 0], [100, 300], [500, 700], [1000, 1000]]);
  for (const top of [NaN, Infinity, -10, 0, 0.1, 400, 100000]) {
    assert.ok(Number.isFinite(Core.mapScroll(top, pairs)));
  }
});
