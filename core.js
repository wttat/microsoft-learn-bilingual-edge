(function (root) {
  "use strict";

  const ORIGIN = "https://learn.microsoft.com";
  const LOCALES = ["zh-cn", "en-us"];

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function trustedURL(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw fail("INVALID_URL", "文章地址无效。");
    }
    if (url.origin !== ORIGIN || url.username || url.password ||
        /%2f|%5c|%00/i.test(url.pathname)) {
      throw fail("INVALID_URL", "只允许读取 https://learn.microsoft.com 上的官方文章。");
    }
    return url;
  }

  function normalizeURL(value) {
    const url = trustedURL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    const locale = (segments[0] || "").toLowerCase();
    if (!LOCALES.includes(locale) || segments.length < 2) {
      throw fail("NOT_ARTICLE_URL", "请打开 /zh-cn/ 或 /en-us/ 下的 Learn 文章。");
    }
    segments[0] = locale;
    url.pathname = "/" + segments.join("/");
    return url;
  }

  function localeOf(value) {
    return trustedURL(value).pathname.split("/")[1].toLowerCase();
  }

  function pairURLs(value) {
    const url = normalizeURL(value);
    return Object.fromEntries(LOCALES.map(locale => {
      const counterpart = new URL(url);
      counterpart.pathname = counterpart.pathname.replace(/^\/[^/]+/, "/" + locale);
      return [locale, counterpart.href];
    }));
  }

  function pageKey(value) {
    const url = normalizeURL(value);
    url.hash = "";
    return url.href;
  }

  function articleKey(value) {
    const url = normalizeURL(value);
    return url.pathname.replace(/^\/[^/]+/, "");
  }

  function validateLanguage({ requestedLocale, finalURL, contentLocale, locale, mainLanguage, canonical }) {
    if (!LOCALES.includes(requestedLocale)) {
      throw fail("LANGUAGE", "不支持的语言版本。");
    }
    const signals = [localeOf(finalURL), contentLocale, locale, mainLanguage];
    if (canonical) signals.push(localeOf(canonical));
    if (signals.filter(Boolean).some(value => value.toLowerCase() !== requestedLocale)) {
      throw fail("LANGUAGE_FALLBACK", "官方未提供此语言正文，或已回退到其他语言；未将回退内容作为译文展示。");
    }
    if (!contentLocale && !locale && !mainLanguage) {
      throw fail("LANGUAGE_UNKNOWN", "无法确认官方正文的语言，已停止展示以避免误认译文。");
    }
  }

  function safeURL(value, base, image = false) {
    try {
      const url = new URL(value, base);
      if (url.username || url.password) return null;
      if (image) return url.origin === ORIGIN && url.protocol === "https:" ? url.href : null;
      return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  function clamp(value, maximum) {
    return Math.max(0, Math.min(Number.isFinite(value) ? value : 0, Math.max(0, maximum)));
  }

  function anchorPairs(left, right, leftMax, rightMax) {
    if (!(leftMax > 0) || !(rightMax > 0)) return [[0, 0]];
    const rightById = new Map();
    for (const anchor of right) {
      if (!rightById.has(anchor.id)) rightById.set(anchor.id, anchor.top);
    }
    const pairs = [[0, 0]];
    const seen = new Set();
    for (const anchor of left) {
      if (seen.has(anchor.id)) continue;
      seen.add(anchor.id);
      const target = rightById.get(anchor.id);
      const previous = pairs[pairs.length - 1];
      // Only strictly increasing shared anchors give an invertible two-way map.
      if (anchor.top > previous[0] && target > previous[1] &&
          anchor.top < leftMax && target < rightMax) {
        pairs.push([anchor.top, target]);
      }
    }
    pairs.push([leftMax, rightMax]);
    return pairs;
  }

  function mapScroll(value, pairs, source = 0) {
    if (pairs.length < 2) return 0;
    const target = 1 - source;
    const end = pairs[pairs.length - 1];
    const position = clamp(value, end[source]);
    for (let index = 1; index < pairs.length; index++) {
      const next = pairs[index];
      if (position <= next[source]) {
        const previous = pairs[index - 1];
        const distance = next[source] - previous[source];
        if (distance <= 0) return previous[target];
        return previous[target] + (next[target] - previous[target]) *
          ((position - previous[source]) / distance);
      }
    }
    return end[target];
  }

  const api = {
    ORIGIN, LOCALES, fail, trustedURL, normalizeURL, localeOf, pairURLs,
    pageKey, articleKey, validateLanguage, safeURL, clamp, anchorPairs, mapScroll
  };
  root.LearnBilingualCore = api;
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
