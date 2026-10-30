(() => {
  "use strict";

  // Text that shows up in subscription prompts.
  const PROMPT_TEXT = /\b(subscri(be|bers?|ption|ptions)|sign in to (continue|read)|log in to (continue|read)|create (a )?free account|register (to|for free)|free (articles?|stories)|article limit|reached your|unlock (this|full|unlimited)|become a member|members? only|support (our|independent) journalism)\b/i;

  // Iframe sources that belong to paywall vendors.
  const VENDOR_FRAME = /(tinypass\.com|piano\.io|poool\.fr|pelcro\.com|zephr\.com|laterpay\.net)/i;

  // Overlay parts from known vendors. Hidden on sight.
  const VENDOR_SELECTORS = [
    ".tp-modal",
    ".tp-backdrop",
    ".tp-iframe-wrapper",
    "#poool-widget",
    "[id^='poool-']"
  ].join(",");

  // Names sites give their own paywall boxes. Only hidden when the box reads
  // like a prompt, never when it holds the article itself.
  const GENERIC_SELECTORS = [
    "[class*='paywall' i]",
    "[id*='paywall' i]",
    "[class*='regwall' i]",
    "[id*='regwall' i]",
    "[data-testid*='paywall' i]"
  ].join(",");

  // Classes sites put on <html> or <body> to freeze scrolling.
  const LOCK_CLASSES = ["tp-modal-open", "modal-open", "no-scroll", "noscroll", "scroll-lock", "overflow-hidden"];

  const ARTICLE_SELECTORS = "article, [itemprop='articleBody'], .article-body, .article-content, .story-body, .entry-content, main";

  // Points on screen (fractions of the viewport) checked for covering layers.
  const POINTS = [[0.5, 0.5], [0.5, 0.25], [0.5, 0.8], [0.5, 0.96], [0.2, 0.5], [0.8, 0.5]];

  // A layer that appears this soon after a click or keypress was probably
  // opened by the user (a login box, a menu) and is left alone.
  const USER_GRACE_MS = 2000;

  const hiddenEls = new Set();
  const spared = new WeakSet();
  let removedCount = 0;
  let paywallSeen = false;
  let lastUserAction = 0;
  let enabled = true;

  for (const type of ["pointerdown", "keydown"]) {
    window.addEventListener(type, () => { lastUserAction = Date.now(); }, { capture: true, passive: true });
  }

  // ---------- helpers ----------

  function viewport() {
    return { vw: window.innerWidth, vh: window.innerHeight };
  }

  function coverage(rect) {
    const { vw, vh } = viewport();
    const w = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0));
    const h = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
    return (w * h) / (vw * vh);
  }

  function holdsArticle(el) {
    if (el.matches("article, [itemprop='articleBody']")) return true;
    if (el.querySelector("article, [itemprop='articleBody']")) return true;
    return el.querySelectorAll("p").length > 6 || (el.textContent || "").length > 4000;
  }

  function visibleText(el) {
    return (el.innerText || el.textContent || "").trim();
  }

  function looksLikePrompt(el) {
    if (holdsArticle(el)) return false;
    if (el.querySelector("input[type='password']")) return false;
    if (PROMPT_TEXT.test(visibleText(el))) return true;
    for (const f of el.querySelectorAll("iframe")) {
      if (VENDOR_FRAME.test(f.src || "")) return true;
    }
    return false;
  }

  function userOpened(el) {
    if (spared.has(el)) return true;
    if (Date.now() - lastUserAction < USER_GRACE_MS) {
      spared.add(el);
      return true;
    }
    return false;
  }

  function isHiddenByUs(el) {
    return el.style.getPropertyValue("display") === "none" &&
      el.style.getPropertyPriority("display") === "important";
  }

  function hide(el) {
    if (!el || !el.isConnected || isHiddenByUs(el)) return false;
    // Hidden rather than deleted, so pages built on React and similar
    // frameworks do not crash when they later touch the node.
    el.style.setProperty("display", "none", "important");
    if (!hiddenEls.has(el)) {
      hiddenEls.add(el);
      removedCount++;
    }
    paywallSeen = true;
    return true;
  }

  function reapplyHidden() {
    for (const el of hiddenEls) {
      if (!el.isConnected) {
        hiddenEls.delete(el);
      } else if (!isHiddenByUs(el)) {
        el.style.setProperty("display", "none", "important");
      }
    }
  }

  // Outermost fixed or sticky ancestor that is not a page wrapper.
  function overlayRoot(el, posCache) {
    let root = null;
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      let pos = posCache.get(n);
      if (pos === undefined) {
        pos = getComputedStyle(n).position;
        posCache.set(n, pos);
      }
      if (pos === "fixed" || pos === "sticky") {
        if (holdsArticle(n)) break;
        root = n;
      }
    }
    return root;
  }

  function layersOnScreen() {
    const { vw, vh } = viewport();
    const posCache = new Map();
    const roots = new Set();
    for (const [fx, fy] of POINTS) {
      const stack = document.elementsFromPoint(vw * fx, vh * fy).slice(0, 12);
      for (const el of stack) {
        const root = overlayRoot(el, posCache);
        if (root) roots.add(root);
      }
    }
    return roots;
  }

  // Top bars (site headers) are never touched, even if they say "Subscribe".
  function isTopBar(rect) {
    const { vh } = viewport();
    return rect.top <= 1 && rect.height < vh * 0.25;
  }

  // ---------- fixes ----------

  function unlockScroll() {
    const html = document.documentElement;
    const body = document.body;
    for (const el of [html, body]) {
      if (!el) continue;
      for (const c of LOCK_CLASSES) el.classList.remove(c);
    }
    const hs = getComputedStyle(html);
    if (hs.overflowY === "hidden" || hs.overflowY === "clip") {
      html.style.setProperty("overflow-y", "auto", "important");
    }
    if (body) {
      const bs = getComputedStyle(body);
      if (bs.overflowY === "hidden" || bs.overflowY === "clip") {
        body.style.setProperty("overflow-y", "visible", "important");
      }
      if (bs.position === "fixed") {
        body.style.setProperty("position", "static", "important");
        body.style.setProperty("top", "auto", "important");
      }
    }
  }

  function articleRoots() {
    const all = [...document.querySelectorAll(ARTICLE_SELECTORS)];
    return all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
  }

  // Undo blur, fade masks and height clamps on article text.
  function unclipArticle() {
    let budget = 3000;
    for (const root of articleRoots()) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let n = root; n && budget-- > 0; n = walker.nextNode()) {
        const cs = getComputedStyle(n);

        if (cs.filter && cs.filter.includes("blur")) {
          n.style.setProperty("filter", "none", "important");
        }
        if (cs.maskImage && cs.maskImage !== "none") {
          n.style.setProperty("mask-image", "none", "important");
        }
        if (cs.userSelect === "none" && n === root) {
          n.style.setProperty("user-select", "text", "important");
        }

        const clipped = (cs.overflowY === "hidden" || cs.overflowY === "clip") &&
          n.scrollHeight > n.clientHeight + 80 &&
          n.querySelectorAll("p").length >= 2;
        if (clipped) {
          n.style.setProperty("max-height", "none", "important");
          n.style.setProperty("height", "auto", "important");
          n.style.setProperty("overflow", "visible", "important");
        }

        // Gradient "fade to white" layers placed over the last paragraph.
        const fade = cs.position === "absolute" &&
          cs.backgroundImage.includes("gradient") &&
          (n.textContent || "").trim().length < 10 &&
          !n.querySelector("img, picture, video, svg, canvas");
        if (fade) hide(n);
      }
    }
  }

  // ---------- main pass ----------

  function scan(full) {
    if (!enabled || !document.body) return;
    let hits = 0;

    // 1. Known vendor overlay parts.
    for (const el of document.querySelectorAll(VENDOR_SELECTORS)) {
      if (hide(el)) hits++;
    }

    // 2. Site named paywall boxes that read like a prompt.
    for (const el of document.querySelectorAll(GENERIC_SELECTORS)) {
      if (isHiddenByUs(el) || el === document.body || el === document.documentElement) continue;
      if (looksLikePrompt(el) && !userOpened(el) && hide(el)) hits++;
    }

    // 3. Fixed or sticky layers covering a real chunk of the screen.
    for (const root of layersOnScreen()) {
      const rect = root.getBoundingClientRect();
      if (isTopBar(rect) || coverage(rect) < 0.08) continue;
      if (looksLikePrompt(root) && !userOpened(root) && hide(root)) hits++;
    }

    // 4. Dimmed backdrops left behind once the prompt is gone.
    if (paywallSeen) {
      const { vw, vh } = viewport();
      const top = document.elementFromPoint(vw / 2, vh / 2);
      for (const root of layersOnScreen()) {
        const rect = root.getBoundingClientRect();
        const bare = visibleText(root).length < 20 &&
          !root.querySelector("input, button, iframe, video, img, a");
        if (coverage(rect) > 0.6 && bare && top && root.contains(top) && !userOpened(root) && hide(root)) hits++;
      }
    }

    if (paywallSeen && (hits > 0 || full)) {
      unlockScroll();
      unclipArticle();
    }

    reapplyHidden();
  }

  // ---------- scheduling ----------

  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      scan(false);
    }, 300);
  }

  function siteKey() {
    return location.hostname.replace(/^www\./, "");
  }

  function start() {
    scan(true);
    for (const ms of [600, 1500, 3000, 6000, 10000, 20000]) {
      setTimeout(() => scan(true), ms);
    }

    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"]
    });
    // After the page settles, stop watching style changes to save work.
    setTimeout(() => {
      observer.disconnect();
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }, 45000);

    window.addEventListener("scroll", schedule, { passive: true });
  }

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "getStats") {
      sendResponse({ removed: removedCount, enabled });
    }
    return false;
  });

  api.storage.local.get({ disabledHosts: [] }).then(({ disabledHosts }) => {
    const host = siteKey();
    enabled = !disabledHosts.some((d) => host === d || host.endsWith("." + d));
    if (enabled) start();
  });
})();
