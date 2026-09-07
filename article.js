(function (root) {
  "use strict";
  const Core = root.LearnBilingualCore;
  const ALLOWED = new Set((
    "h1 h2 h3 h4 h5 h6 p div section article span a ul ol li dl dt dd pre code " +
    "blockquote table thead tbody tfoot tr th td caption colgroup col strong b em i " +
    "s del ins u sub sup br hr img figure figcaption details summary kbd samp var abbr time"
  ).split(" "));
  const DROP = new Set((
    "script style link meta base iframe frame frameset object embed applet svg math " +
    "form input button select textarea option template noscript canvas video audio source track " +
    "nav aside header footer"
  ).split(" "));
  const CHROME = [
    "nav", "aside", "footer", "#article-header", "#article-metadata", "#article-footer",
    "#ms--in-this-article", "#ms--feedback", "#feedback", ".feedback",
    "[data-bi-name='site-feedback-section']", "[data-bi-name='right-toc']",
    "[data-bi-name='pageactions']", "[data-test-id='site-user-feedback-footer']",
    ".moniker-display-boilerplate.is-hidden"
  ].join(",");

  function meta(doc, name) {
    return doc.querySelector(`meta[name="${name}"]`)?.getAttribute("content")?.trim() || "";
  }

  function hasBodyContent(element) {
    return Boolean(element?.querySelector("p, pre, table, ul, ol, dl, h2, h3") &&
      element.textContent.trim().length > 20);
  }

  function articleParts(doc) {
    const type = meta(doc, "page_type").toLowerCase();
    const trainingUnit = ["learn", "unit"].includes(type) && meta(doc, "schema").toLowerCase() === "moduleunit";
    if (!trainingUnit && !["conceptual", "reference", "dotnet", "unit"].includes(type)) return null;
    const main = doc.querySelector("main#main") || doc.querySelector("main");
    if (!main) return null;
    if (trainingUnit) {
      // The enclosing .content also contains progress, duration and next-unit controls.
      const title = main.querySelector("h1#module-unit-title");
      const body = main.querySelector("#module-unit-content");
      if (!title?.textContent.trim() || !hasBodyContent(body)) return null;
      return { main, title, bodies: [body] };
    }
    const blocks = [...main.querySelectorAll(".content")].filter(element =>
      !element.parentElement?.closest(".content") && !element.closest(CHROME));
    const title = blocks.map(element => element.querySelector("h1")).find(Boolean);
    const bodies = blocks.filter(hasBodyContent);
    if (!title || !bodies.length) return null;
    return { main, title, bodies };
  }

  function navigationLink(element, current) {
    const href = element.getAttribute("href");
    if (!href || href.startsWith("#")) return null;
    let url;
    try {
      url = Core.normalizeURL(new URL(href, current).href);
    } catch (error) {
      if (error instanceof TypeError || ["INVALID_URL", "NOT_ARTICLE_URL"].includes(error.code)) return null;
      throw error;
    }
    if (Core.localeOf(url.href) !== Core.localeOf(current.href)) return null;
    for (const key of ["view", "viewFallbackFrom", "preserve-view"]) {
      if (!url.searchParams.has(key) && current.searchParams.has(key)) {
        url.searchParams.set(key, current.searchParams.get(key));
      }
    }
    return {
      url: url.href,
      title: (element.getAttribute("title") || element.querySelector("span")?.textContent || element.textContent).trim()
    };
  }

  function pageNavigation(doc, currentURL) {
    const current = Core.normalizeURL(currentURL);
    const result = {
      previous: null, next: null,
      previousReason: "此页未提供官方上一页链接",
      nextReason: "此页未提供官方下一页链接"
    };
    if (meta(doc, "schema").toLowerCase() === "moduleunit") {
      const parent = current.pathname.slice(0, current.pathname.lastIndexOf("/") + 1);
      const seen = new Set();
      const units = [...doc.querySelectorAll("#module-menu a[href]")].map(link => navigationLink(link, current))
        .filter(link => {
          if (!link) return false;
          const pathname = new URL(link.url).pathname;
          if (pathname.slice(0, pathname.lastIndexOf("/") + 1) !== parent || seen.has(pathname)) return false;
          seen.add(pathname);
          return true;
        });
      const index = units.findIndex(link => new URL(link.url).pathname === current.pathname);
      if (index < 0) {
        result.previousReason = result.nextReason = "官方单元目录尚未就绪或未包含当前页";
      } else {
        result.previous = units[index - 1] || null;
        result.next = units[index + 1] || null;
        result.previousReason = "已经是本模块第一页";
        result.nextReason = "已经是本模块最后一页";
      }
      return result;
    }
    for (const [direction, rel] of [["previous", "prev"], ["next", "next"]]) {
      result[direction] = [...doc.querySelectorAll(`head link[rel~="${rel}"][href], main a[rel~="${rel}"][href]`)]
        .map(link => navigationLink(link, current))
        .find(link => link && new URL(link.url).pathname !== current.pathname) || null;
    }
    return result;
  }

  function sanitizeNode(node, output, baseURL, view = "") {
    if (node.nodeType === 3) return output.createTextNode(node.textContent);
    if (node.nodeType !== 1) return null;
    const tag = node.localName.toLowerCase();
    if (DROP.has(tag) || node.matches(CHROME)) return null;
    if (view && node.hasAttribute("data-moniker") &&
        !node.getAttribute("data-moniker").trim().split(/\s+/).includes(view)) return null;
    if (!ALLOWED.has(tag)) {
      const fragment = output.createDocumentFragment();
      for (const child of node.childNodes) {
        const clean = sanitizeNode(child, output, baseURL, view);
        if (clean) fragment.append(clean);
      }
      return fragment;
    }
    const clean = output.createElement(tag);
    const id = node.getAttribute("id") || (tag === "a" ? node.getAttribute("name") : "");
    if (id) clean.id = id;
    for (const attribute of ["title", "lang", "dir"]) {
      if (node.hasAttribute(attribute)) clean.setAttribute(attribute, node.getAttribute(attribute));
    }
    const classes = [...node.classList].filter(value =>
      /^(NOTE|TIP|WARNING|CAUTION|IMPORTANT)$/.test(value) ||
      (tag === "code" && /^language-[\w-]+$/.test(value)));
    if (classes.length) clean.className = classes.join(" ");
    if (tag === "a") {
      const href = Core.safeURL(node.getAttribute("href") || "", baseURL);
      if (node.hasAttribute("href") && href) {
        clean.href = href;
        clean.target = "_blank";
        clean.rel = "noopener noreferrer";
        clean.referrerPolicy = "no-referrer";
      }
    }
    if (tag === "img") {
      const src = Core.safeURL(node.getAttribute("src") || "", baseURL, true);
      if (!src || !node.getAttribute("src")) {
        const placeholder = output.createElement("span");
        placeholder.className = "image-notice";
        placeholder.textContent = `［图片未载入：${node.getAttribute("alt") || "非 Learn 站内图片，请查看官方原文"}］`;
        return placeholder;
      }
      clean.src = src;
      clean.alt = node.getAttribute("alt") || "官方正文图片";
      clean.loading = "eager";
      clean.decoding = "async";
      clean.referrerPolicy = "no-referrer";
      for (const attribute of ["width", "height"]) {
        const value = node.getAttribute(attribute);
        if (/^\d{1,5}$/.test(value || "")) clean.setAttribute(attribute, value);
      }
    }
    for (const attribute of tag === "td" || tag === "th" ? ["colspan", "rowspan"] : []) {
      const value = node.getAttribute(attribute);
      if (/^\d{1,3}$/.test(value || "")) clean.setAttribute(attribute, value);
    }
    if (tag === "th" && ["row", "col", "rowgroup", "colgroup"].includes(node.getAttribute("scope"))) {
      clean.setAttribute("scope", node.getAttribute("scope"));
    }
    if (tag === "ol" && /^-?\d+$/.test(node.getAttribute("start") || "")) {
      clean.setAttribute("start", node.getAttribute("start"));
    }
    if (tag === "details") clean.open = true;
    for (const child of node.childNodes) {
      const result = sanitizeNode(child, output, baseURL, view);
      if (result) clean.append(result);
    }
    return clean;
  }

  function extractArticle(html, finalURL, requestedLocale, output = document) {
    Core.trustedURL(finalURL);
    if (typeof html !== "string" || html.length > 6 * 1024 * 1024) {
      throw Core.fail("INVALID_HTML", "官方页面过大或正文格式无效。");
    }
    // Template contents have no browsing context: neither scripts nor image requests run.
    const template = output.createElement("template");
    template.innerHTML = html;
    const doc = template.content;
    const canonicalValue = doc.querySelector('link[rel="canonical"]')?.getAttribute("href");
    const canonical = canonicalValue ? new URL(canonicalValue, finalURL).href : "";
    Core.validateLanguage({
      requestedLocale, finalURL, canonical,
      contentLocale: meta(doc, "ms.contentlocale"),
      locale: meta(doc, "locale"),
      mainLanguage: doc.querySelector("main")?.getAttribute("lang") || ""
    });
    const parts = articleParts(doc);
    if (!parts) throw Core.fail("NOT_ARTICLE", "此官方页面不是可提取的正文文章，或 Learn 页面结构已变化。请查看官方原文。");
    let view = "";
    if (parts.bodies.some(body => body.matches("[data-moniker]") || body.querySelector("[data-moniker]"))) {
      view = new URL(finalURL).searchParams.get("view") || meta(doc, "default_moniker");
      const available = [...doc.querySelectorAll('meta[name="monikers"]')].map(node => node.getAttribute("content"));
      if (!view || (available.length && !available.includes(view))) {
        throw Core.fail("VERSION_UNAVAILABLE", "此官方页面无法确认所选文档版本，请在官方原文选择可用版本后重新对照。");
      }
    }
    const article = output.createElement("article");
    article.className = "article";
    article.lang = requestedLocale;
    if (!parts.bodies.some(body => body.contains(parts.title))) {
      article.append(sanitizeNode(parts.title, output, finalURL, view));
    }
    for (const body of parts.bodies) {
      const clean = sanitizeNode(body, output, finalURL, view);
      if (clean) article.append(clean);
    }
    if (article.textContent.trim().length < 30) {
      throw Core.fail("EMPTY_ARTICLE", "官方页面中没有可读取的正文。");
    }
    return {
      article,
      title: parts.title.textContent.trim(),
      identity: Core.articleKey(canonical || finalURL),
      version: view,
      url: finalURL
    };
  }

  root.LearnBilingualArticle = { articleParts, pageNavigation, extractArticle, sanitizeNode };
})(globalThis);
