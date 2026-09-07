(function (root) {
  "use strict";
  const Core = root.LearnBilingualCore;

  class ScrollSync {
    constructor(panes, enabled = true) {
      this.panes = panes;
      this.enabled = enabled;
      this.active = 0;
      this.expected = panes.map(pane => pane.scrollTop);
      this.pairs = [[0, 0]];
      this.frame = 0;
      this.dirty = true;
      this.events = new AbortController();
      const options = { passive: true, signal: this.events.signal };
      panes.forEach((pane, index) => {
        const intent = () => {
          this.active = index;
          this.expected[index] = null;
        };
        for (const type of ["wheel", "pointerdown", "touchstart", "keydown"]) {
          pane.addEventListener(type, intent, options);
        }
        pane.addEventListener("scroll", () => {
          if (this.expected[index] !== null && Math.abs(pane.scrollTop - this.expected[index]) < 1.5) return;
          intent();
          this.schedule();
        }, options);
        pane.addEventListener("load", () => this.refresh(), { capture: true, signal: this.events.signal });
      });
      this.observer = new ResizeObserver(() => this.refresh());
      panes.forEach(pane => {
        this.observer.observe(pane);
        const article = pane.querySelector("article");
        if (article) this.observer.observe(article);
      });
      this.refresh();
    }

    measure() {
      const anchors = this.panes.map(pane => {
        const paneTop = pane.getBoundingClientRect().top;
        return [...pane.querySelectorAll("h2[id], h3[id], h4[id], h5[id], h6[id]")].map(heading => ({
          id: heading.id,
          top: heading.getBoundingClientRect().top - paneTop + pane.scrollTop - 16
        }));
      });
      const limits = this.panes.map(pane => Math.max(0, pane.scrollHeight - pane.clientHeight));
      this.pairs = Core.anchorPairs(anchors[0], anchors[1], limits[0], limits[1]);
      this.dirty = false;
    }

    refresh() {
      this.dirty = true;
      this.schedule();
    }

    schedule() {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        if (this.dirty) this.measure();
        if (!this.enabled) return;
        const target = 1 - this.active;
        const pane = this.panes[target];
        const position = Core.mapScroll(this.panes[this.active].scrollTop, this.pairs, this.active);
        this.expected[target] = position;
        pane.scrollTop = position;
        this.expected[target] = pane.scrollTop;
      });
    }

    from(index) {
      this.active = index;
      this.expected[index] = null;
      this.schedule();
    }

    setEnabled(value) {
      this.enabled = value;
      this.schedule();
    }

    destroy() {
      cancelAnimationFrame(this.frame);
      this.observer.disconnect();
      this.events.abort();
    }
  }

  root.LearnBilingualSync = ScrollSync;
})(globalThis);
