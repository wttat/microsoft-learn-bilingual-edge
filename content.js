(function () {
  "use strict";
  if (globalThis.__learnBilingualInstalled) return;
  globalThis.__learnBilingualInstalled = true;

  const Core = globalThis.LearnBilingualCore;
  const Article = globalThis.LearnBilingualArticle;
  const defaults = { sync: true, auto: true, swapped: false };
  let settings = { ...defaults };
  let ui;
  let sync;
  let opened = false;
  let loaded = false;
  let generation = 0;
  let request;
  let route = location.href;
  let eligible = false;
  let savedPage;
  let ready = false;
  let autoAttempted = false;
  let resumeRequested = false;
  let navigating = false;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function status(text) {
    ui.status.textContent = text;
  }

  function makeUI() {
    if (ui) return;
    const host = document.createElement("div");
    host.id = "learn-bilingual-reader";
    host.style.setProperty("all", "initial", "important");
    const shadow = host.attachShadow({ mode: "open" });
    const stylesheet = element("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = chrome.runtime.getURL("reader.css");
    const launcher = element("div", "launcher floating-control");
    const notice = element("p");
    notice.hidden = true;
    notice.setAttribute("role", "status");
    const launch = element("button", "", "中英对照");
    launch.addEventListener("click", () => openReader());
    launcher.append(notice, launch);
    const dialog = element("dialog", "reader");
    dialog.setAttribute("aria-label", "Microsoft Learn 官方中英文对照阅读器");
    const toolbar = element("div", "toolbar");
    toolbar.append(element("strong", "", "Learn 官方中英对照"));
    const pageButtons = {};
    const pageNavigation = element("div", "page-navigation");
    pageNavigation.setAttribute("role", "group");
    pageNavigation.setAttribute("aria-label", "文章导航");
    for (const [direction, label] of [["previous", "上一页"], ["next", "下一页"]]) {
      const button = element("button", "", label);
      button.dataset.action = direction;
      button.disabled = true;
      button.title = "正在读取官方导航";
      button.addEventListener("click", () => navigatePage(direction));
      pageButtons[direction] = button;
      pageNavigation.append(button);
    }
    toolbar.append(pageNavigation);
    const syncInput = checkbox("同步滚动", settings.sync, async value => {
      settings.sync = value;
      sync?.setEnabled(value);
      await saveSettings();
    });
    const autoInput = checkbox("自动打开", settings.auto, async value => {
      settings.auto = value;
      await saveSettings();
    });
    const swap = element("button", "", "交换中英位置");
    swap.dataset.action = "swap";
    swap.addEventListener("click", async () => {
      settings.swapped = !settings.swapped;
      applyColumnOrder();
      await saveSettings();
    });
    const retry = element("button", "", "重新读取");
    retry.dataset.action = "reload";
    retry.addEventListener("click", () => loadPair());
    const close = element("button", "floating-control floating-close", "收起 · 返回原页");
    close.dataset.action = "close";
    close.title = "收起对照并返回原页（Esc）";
    close.addEventListener("click", closeReader);
    toolbar.append(syncInput.label, autoInput.label, swap, retry);
    const message = element("p", "status");
    message.setAttribute("role", "status");
    const columns = element("div", "columns");
    const panes = Core.LOCALES.map((locale, index) => {
      const column = element("section", "column");
      const header = element("header", "column-header");
      const heading = element("h2", "", index === 0 ? "中文" : "英文");
      const original = element("a", "original", "打开官方原文 ↗");
      original.target = "_blank";
      original.rel = "noopener noreferrer";
      original.referrerPolicy = "no-referrer";
      const pane = element("div", "pane");
      pane.tabIndex = 0;
      pane.lang = locale;
      pane.dataset.locale = locale;
      pane.setAttribute("role", "region");
      pane.setAttribute("aria-label", index === 0 ? "中文正文，独立滚动区域" : "英文正文，独立滚动区域");
      pane.addEventListener("click", event => anchorClick(event, index));
      pane.addEventListener("error", event => {
        if (event.target.localName === "img") {
          event.target.replaceWith(element("span", "image-notice", "［官方图片加载失败，请在官方原文中查看］"));
          sync?.refresh();
        }
      }, true);
      header.append(heading, original);
      column.append(header, pane);
      columns.append(column);
      return { column, pane, original, url: "" };
    });
    dialog.append(toolbar, close, message, columns);
    dialog.addEventListener("cancel", event => {
      event.preventDefault();
      closeReader();
    });
    shadow.append(stylesheet, launcher, dialog);
    document.documentElement.append(host);
    ui = {
      host, shadow, dialog, launcher, close, notice, status: message, panes, columns, swap, syncInput, autoInput, pageButtons,
      stylesReady: false, stylesFailed: false, wantsOpen: false
    };
    applyColumnOrder();
    stylesheet.addEventListener("load", () => {
      ui.stylesReady = true;
      if (ui.wantsOpen) openReader();
    });
    stylesheet.addEventListener("error", () => {
      console.error("Learn 中英对照：阅读器样式加载失败");
      ui.stylesFailed = true;
      closeReader();
      notice.textContent = "阅读器样式加载失败，请在扩展管理页重新加载扩展并刷新网页。";
      notice.hidden = false;
    });
  }

  function checkbox(text, checked, change) {
    const label = element("label");
    const input = element("input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", () => change(input.checked));
    label.append(input, document.createTextNode(text));
    return { label, input };
  }

  function applyColumnOrder() {
    const first = ui.panes[settings.swapped ? 1 : 0].column;
    if (ui.columns.firstElementChild !== first) {
      const positions = ui.panes.map(({ pane }) => ({ top: pane.scrollTop, left: pane.scrollLeft }));
      // Move whole columns, but keep the locale-indexed pane references used by fetching and scrolling.
      ui.columns.insertBefore(first, ui.columns.firstElementChild);
      ui.panes.forEach(({ pane }, index) => {
        pane.scrollTop = positions[index].top;
        pane.scrollLeft = positions[index].left;
      });
      sync?.refresh();
    }
    ui.swap.setAttribute("aria-pressed", String(settings.swapped));
    ui.swap.title = settings.swapped ? "当前左侧英文、右侧中文；点击交换" : "当前左侧中文、右侧英文；点击交换";
  }

  async function saveSettings() {
    try {
      await chrome.storage.local.set(settings);
    } catch (error) {
      console.error("Learn 中英对照：设置保存失败", error);
      status("设置保存失败；本页仍按当前选择工作。请重新加载扩展后再试。");
    }
  }

  function updateNavigation() {
    if (!opened) return;
    if (!canRead()) {
      for (const button of Object.values(ui.pageButtons)) {
        button.disabled = true;
        button.title = "当前页面正文尚未就绪";
      }
      return;
    }
    const navigation = Article.pageNavigation(document, location.href);
    for (const [direction, label] of [["previous", "上一页"], ["next", "下一页"]]) {
      const button = ui.pageButtons[direction];
      const target = navigation[direction];
      button.disabled = navigating || !target;
      button.title = navigating ? "正在切换页面" : target ? `${label}：${target.title || "打开官方页面"}` : navigation[`${direction}Reason`];
    }
  }

  async function navigatePage(direction) {
    if (!opened || navigating) return;
    try {
      const source = Core.pageKey(location.href);
      const navigation = Article.pageNavigation(document, location.href);
      const target = navigation[direction];
      if (!target) {
        status(navigation[`${direction}Reason`]);
        return;
      }
      navigating = true;
      updateNavigation();
      status(`正在打开${direction === "previous" ? "上一页" : "下一页"}…`);
      const response = await chrome.runtime.sendMessage({
        type: "navigation-state", url: location.href, requestId: crypto.randomUUID(), destination: target.url
      });
      if (!response?.ok) throw Core.fail("NAVIGATION", response?.message || "扩展后台未响应，请重试。");
      if (Core.pageKey(location.href) !== source) {
        watchPage();
        return;
      }
      cancelRequest();
      location.assign(target.url);
    } catch (error) {
      console.error("Learn 中英对照：切换页面失败", error);
      status(error.code ? error.message : "切换页面失败，请重试或在官方原文中继续。");
    } finally {
      navigating = false;
      updateNavigation();
    }
  }

  async function resumeNavigation() {
    try {
      Core.normalizeURL(location.href);
    } catch (error) {
      if (["INVALID_URL", "NOT_ARTICLE_URL"].includes(error.code)) return false;
      throw error;
    }
    const response = await chrome.runtime.sendMessage({
      type: "navigation-state", url: location.href, requestId: crypto.randomUUID()
    });
    if (!response?.ok) throw Core.fail("NAVIGATION", response?.message || "扩展后台未响应，请刷新页面。");
    return response.resume === true;
  }

  function canRead() {
    try {
      Core.normalizeURL(location.href);
    } catch (error) {
      if (!["INVALID_URL", "NOT_ARTICLE_URL"].includes(error.code)) throw error;
      return false;
    }
    return Boolean(Article.articleParts(document));
  }

  function openReader() {
    makeUI();
    if (!canRead()) {
      ui.notice.textContent = "此页没有可识别的 Learn 中英文正文。请打开 /zh-cn/ 或 /en-us/ 下的文档文章或培训单元；首页、课程目录和搜索页不适用。";
      ui.notice.hidden = false;
      return;
    }
    if (opened) return;
    if (ui.stylesFailed) {
      ui.notice.textContent = "阅读器样式加载失败，请在扩展管理页重新加载扩展并刷新网页。";
      ui.notice.hidden = false;
      return;
    }
    // Wait for the fixed-height panes before loading content or applying a chapter hash.
    if (!ui.stylesReady) {
      ui.wantsOpen = true;
      return;
    }
    ui.wantsOpen = false;
    ui.launcher.hidden = false;
    const launcherRect = ui.launcher.getBoundingClientRect();
    savedPage = {
      x: window.scrollX, y: window.scrollY, focus: document.activeElement,
      styles: [document.documentElement, document.body].map(node => ({
        node, value: node.style.getPropertyValue("overflow"),
        priority: node.style.getPropertyPriority("overflow")
      }))
    };
    savedPage.styles.forEach(({ node }) => node.style.setProperty("overflow", "hidden", "important"));
    // Hiding page scrollbars changes the fixed-position viewport; keep the launcher's screen position.
    ui.close.style.right = `${document.documentElement.clientWidth - launcherRect.right}px`;
    ui.close.style.bottom = `${document.documentElement.clientHeight - launcherRect.bottom}px`;
    ui.notice.hidden = true;
    ui.launcher.hidden = true;
    ui.dialog.showModal();
    opened = true;
    updateNavigation();
    ui.panes[settings.swapped ? 1 : 0].pane.focus({ preventScroll: true });
    if (!loaded) loadPair();
    else connectSync();
  }

  function cancelRequest() {
    generation++;
    if (!request) return;
    const previous = request;
    request = null;
    chrome.runtime.sendMessage({ type: "cancel-pair", ...previous }).catch(error => {
      console.warn("Learn 中英对照：无法通知后台取消请求，旧结果仍会被忽略", error);
    });
  }

  function closeReader() {
    if (ui) ui.wantsOpen = false;
    if (!opened) return;
    opened = false;
    cancelRequest();
    sync?.destroy();
    sync = null;
    ui.dialog.close();
    ui.launcher.hidden = false;
    for (const { node, value, priority } of savedPage.styles) {
      if (value) node.style.setProperty("overflow", value, priority);
      else node.style.removeProperty("overflow");
    }
    savedPage.focus?.focus({ preventScroll: true });
    window.scrollTo({ left: savedPage.x, top: savedPage.y, behavior: "instant" });
  }

  function showPaneMessage(index, title, text, retry = false) {
    const pane = ui.panes[index].pane;
    const box = element("div", retry ? "message error" : "message");
    box.setAttribute("role", retry ? "alert" : "status");
    box.append(element("h3", "", title), element("p", "", text));
    if (retry) {
      const button = element("button", "", "重试读取官方版本");
      button.addEventListener("click", () => loadPair());
      box.append(button);
    }
    pane.replaceChildren(box);
  }

  async function loadPair() {
    if (!opened) return;
    cancelRequest();
    const current = generation;
    loaded = false;
    sync?.destroy();
    sync = null;
    const urls = Core.pairURLs(location.href);
    ui.panes.forEach((entry, index) => {
      entry.url = urls[Core.LOCALES[index]];
      entry.original.href = entry.url;
      entry.pane.scrollTop = 0;
      entry.pane.setAttribute("aria-busy", "true");
      showPaneMessage(index, "正在读取官方正文…", "仅访问 Microsoft Learn，不进行翻译。");
    });
    status("正在并发读取官方中文和英文版本；可随时收起返回原页。");
    request = { url: location.href, requestId: crypto.randomUUID() };
    try {
      const response = await chrome.runtime.sendMessage({ type: "load-pair", ...request });
      if (current !== generation || !opened) return;
      if (!response?.ok) throw Core.fail("BACKGROUND", response?.message || "扩展后台没有响应，请刷新页面后重试。");
      const articles = Core.LOCALES.map((locale, index) => {
        const result = response.results[locale];
        if (!result?.ok) {
          showPaneMessage(index, "此官方版本暂不可用", result?.message || "官方页面读取失败，请重试。", true);
          return null;
        }
        try {
          const article = Article.extractArticle(result.html, result.url, locale);
          ui.panes[index].url = article.url;
          return article;
        } catch (error) {
          console.warn("Learn 中英对照：正文提取失败", locale, error);
          showPaneMessage(index, "此官方版本暂不可用", error.code ? error.message : "无法安全读取官方正文，请查看官方原文或重试。", true);
          return null;
        }
      });
      if (articles[0] && articles[1] && articles[0].identity !== articles[1].identity) {
        articles.fill(null);
        ui.panes.forEach((_, index) => showPaneMessage(index, "官方文章地址不一致", "两个官方版本指向了不同文章，已停止对照。请打开官方原文确认地址后再试。", true));
      } else if (articles[0] && articles[1] && articles[0].version !== articles[1].version) {
        articles.fill(null);
        ui.panes.forEach((_, index) => showPaneMessage(index, "官方文档版本不一致", "两个语言页面的默认文档版本不同，请在官方原文选择相同的 view 版本后重新对照。", true));
      } else if (articles[0] && articles[1] &&
          articles[0].article.textContent.replace(/\s+/g, "") === articles[1].article.textContent.replace(/\s+/g, "")) {
        articles[0] = null;
        showPaneMessage(0, "未发现独立的官方中文正文", "中英文正文完全相同，可能发生了官方语言回退。未将相同内容作为中文译文展示。", true);
      }
      articles.forEach((article, index) => {
        if (article) ui.panes[index].pane.replaceChildren(article.article);
      });
      loaded = articles.some(Boolean);
      status(articles.every(Boolean)
        ? "仅展示微软官方已有版本，不做翻译或语义差异判断。滚动任一栏，按共有章节对齐；无共有章节时按比例同步。"
        : "部分官方版本不可用，详情见对应栏。可阅读已加载的正文，或重试；不以其他语言冒充译文。");
      if (articles.every(Boolean)) connectSync();
      scrollHash(location.hash);
    } catch (error) {
      if (current !== generation || !opened) return;
      console.error("Learn 中英对照：读取失败", error);
      ui.panes.forEach((_, index) => showPaneMessage(index, "读取失败", error.code ? error.message : "无法联系扩展后台，请重新加载扩展并刷新页面后重试。", true));
      status("读取未完成；原网页保持不变。");
    } finally {
      if (current === generation) {
        request = null;
        ui.panes.forEach(({ pane }) => pane.removeAttribute("aria-busy"));
      }
    }
  }

  function connectSync() {
    sync?.destroy();
    sync = null;
    if (ui.panes.every(({ pane }) => pane.querySelector("article"))) {
      sync = new globalThis.LearnBilingualSync(ui.panes.map(({ pane }) => pane), settings.sync);
    }
  }

  function jump(index, hash) {
    const pane = ui.panes[index].pane;
    let id;
    try {
      id = decodeURIComponent(hash.replace(/^#/, ""));
    } catch (error) {
      console.warn("Learn 中英对照：无效章节锚点", error);
      status("章节链接格式无效，请在官方原文中查看。");
      return false;
    }
    const target = [...pane.querySelectorAll("[id]")].find(node => node.id === id);
    if (id && !target) return false;
    pane.scrollTop = target ? target.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 16 : 0;
    sync?.from(index);
    return true;
  }

  function scrollHash(hash) {
    if (!hash || !ui) return;
    const preferred = Core.localeOf(location.href) === "en-us" ? 1 : 0;
    if (!jump(preferred, hash)) jump(1 - preferred, hash);
  }

  function anchorClick(event, index) {
    const link = event.target.closest("a[href]");
    if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const url = new URL(link.href);
    const base = new URL(ui.panes[index].url);
    if (url.origin === base.origin && url.pathname === base.pathname &&
        url.search === base.search && (url.hash || link.href.endsWith("#"))) {
      event.preventDefault();
      if (!jump(index, url.hash)) status("此版本未找到该章节锚点；请通过栏头的官方原文链接查看。");
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== "toggle-reader" || sender.id !== chrome.runtime.id) return false;
    if (opened || ui?.wantsOpen) closeReader();
    else openReader();
    respond({ ok: true });
    return false;
  });

  function watchPage() {
    if (!ready) return;
    if (location.href !== route) {
      const previous = new URL(route);
      const next = new URL(location.href);
      route = location.href;
      if (previous.pathname === next.pathname && previous.search === next.search) {
        if (opened) scrollHash(next.hash);
        return;
      }
      closeReader();
      loaded = false;
      eligible = false;
      autoAttempted = false;
      resumeRequested = false;
      if (ui) ui.launcher.hidden = true;
    }
    if (!eligible) eligible = canRead();
    if (eligible && !autoAttempted) {
      autoAttempted = true;
      makeUI();
      ui.launcher.hidden = opened;
      if (settings.auto || resumeRequested) openReader();
      resumeRequested = false;
    }
    updateNavigation();
  }

  chrome.storage.local.get(defaults).then(async values => {
    settings = { sync: values.sync !== false, auto: values.auto !== false, swapped: values.swapped === true };
    if (ui) {
      ui.syncInput.input.checked = settings.sync;
      ui.autoInput.input.checked = settings.auto;
      applyColumnOrder();
      sync?.setEnabled(settings.sync);
    }
    resumeRequested = await resumeNavigation();
  }).catch(error => {
    console.error("Learn 中英对照：设置或阅读状态读取失败", error);
    makeUI();
    ui.notice.textContent = "设置或阅读状态读取失败，请重新加载扩展。";
    ui.notice.hidden = false;
  }).finally(() => {
    ready = true;
    if (resumeRequested) openReader();
    watchPage();
  });
  window.setInterval(watchPage, 750);
})();
