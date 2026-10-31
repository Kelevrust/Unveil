// Exercises the built Firefox background (consent-bg.js + background.js) with
// a stubbed WebExtension API. Firefox itself cannot be driven headless with an
// extension loaded here, so this checks the blocking, per site, cookie banner
// and Global Privacy Control logic directly.
//   node build.mjs && node tests/firefox_background.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const dist = (f) => fileURLToPath(new URL(`../dist/firefox/${f}`, import.meta.url));
const manifest = JSON.parse(readFileSync(dist("manifest.json"), "utf8"));

let store = { disabledHosts: [] };
const listeners = { block: null, mainFrame: null, message: null, headers: null };
const sentToTabs = [];
const executed = [];
let registered = [];
const browser = {
  storage: {
    local: {
      get: async (d) => ({ ...d, ...store }),
      set: async (v) => { store = { ...store, ...v }; }
    },
    onChanged: { addListener: () => {} }
  },
  webRequest: {
    onBeforeRequest: {
      addListener: (fn, filter, extra) => {
        if (extra && extra.includes("blocking")) listeners.block = fn;
        else listeners.mainFrame = fn;
      }
    },
    onBeforeSendHeaders: {
      addListener: (fn) => { listeners.headers = fn; },
      removeListener: () => { listeners.headers = null; },
      hasListener: (fn) => listeners.headers === fn
    }
  },
  scripting: {
    executeScript: async (opts) => { executed.push(opts); return [{ result: opts.func() }]; },
    getRegisteredContentScripts: async ({ ids }) => registered.filter((r) => ids.includes(r.id)),
    registerContentScripts: async (list) => { registered.push(...list); },
    unregisterContentScripts: async ({ ids }) => { registered = registered.filter((r) => !ids.includes(r.id)); }
  },
  tabs: {
    onRemoved: { addListener: () => {} },
    sendMessage: async (tabId, msg, opts) => { sentToTabs.push({ tabId, msg, opts }); }
  },
  runtime: {
    onMessage: { addListener: (fn) => { listeners.message = fn; } },
    getURL: (p) => p
  }
};

// The page the "eval" snippet runs against, for the Osano check.
const fakePage = { Osano: { cm: { dialogOpen: true } } };
const context = vm.createContext({
  browser, URL, Promise, console, setTimeout, clearTimeout, structuredClone, TextEncoder, TextDecoder, atob, btoa,
  fetch: async (p) => ({ json: async () => JSON.parse(readFileSync(dist(p), "utf8")) }),
  window: fakePage
});
// Load the background scripts in manifest order, as Firefox does.
for (const f of manifest.background.scripts) vm.runInContext(readFileSync(dist(f), "utf8"), context, { filename: f });
await new Promise((r) => setTimeout(r, 20));

const results = [];
const check = (name, ok) => results.push([name, !!ok]);
const send = (msg, sender = {}) => listeners.message(msg, sender);
const req = (documentUrl, frameAncestors = []) =>
  listeners.block({ tabId: 7, documentUrl, frameAncestors, url: "https://cdn.tinypass.com/x.js" });

check("vendor script on a news page is cancelled", req("https://www.news.com/story").cancel === true);
check("blocked count reported", (await send({ type: "getBlocked", tabId: 7 })) === 1);

listeners.mainFrame({ tabId: 7 });
check("new page load resets the count", (await send({ type: "getBlocked", tabId: 7 })) === 0);

await send({ type: "setSite", site: "news.com", enabled: false });
check("site off: stored", store.disabledHosts.includes("news.com"));
check("site off: top level request allowed", !req("https://www.news.com/story").cancel);
check("site off: subdomain covered", !req("https://cooking.news.com/r").cancel);
check("site off: request from inside vendor iframe allowed",
  !req("https://experience.piano.io/frame", [{ url: "https://www.news.com/story" }]).cancel);
check("other sites still blocked", req("https://other.org/a").cancel === true);
check("vendor iframe on another site still blocked",
  req("https://experience.piano.io/frame", [{ url: "https://other.org/a" }]).cancel === true);

await send({ type: "setSite", site: "cooking.news.com", enabled: true });
check("turning it back on from a subdomain clears the parent entry", !store.disabledHosts.includes("news.com"));
check("site back on: blocked again", req("https://www.news.com/story").cancel === true);

// ---------- Global Privacy Control ----------

check("GPC on by default: header listener attached", typeof listeners.headers === "function");
const out = listeners.headers({ requestHeaders: [{ name: "Accept", value: "*/*" }, { name: "sec-gpc", value: "0" }] }).requestHeaders;
check("GPC header set to 1, replacing any existing one",
  out.filter((h) => h.name.toLowerCase() === "sec-gpc").length === 1 && out.find((h) => h.name === "Sec-GPC").value === "1");
check("GPC page script registered in the page's own world",
  registered.length === 1 && registered[0].world === "MAIN" && registered[0].js[0] === "gpc-main.js" && registered[0].allFrames);

await send({ type: "setOption", key: "gpcEnabled", value: false });
check("GPC off: header listener removed and page script unregistered", listeners.headers === null && registered.length === 0);
await send({ type: "setOption", key: "gpcEnabled", value: true });
check("GPC back on", typeof listeners.headers === "function" && registered.length === 1);
await send({ type: "setOption", key: "notARealOption", value: true });
check("unknown options are ignored", !("notARealOption" in store));

// ---------- cookie banners ----------

const consent = (m, frameId = 0) => send({ unveilConsent: m }, { tab: { id: 9 }, frameId, url: "https://shop.example/" });
const lastReply = () => sentToTabs[sentToTabs.length - 1];
const settle = () => new Promise((r) => setTimeout(r, 20));

consent({ type: "init", url: "https://shop.example/" });
await settle();
let r = lastReply();
check("init answered to the same tab and frame", r && r.tabId === 9 && r.opts.frameId === 0 && r.msg.unveilConsent.type === "initResp");
check("init config takes the reject path", r.msg.unveilConsent.config.enabled === true && r.msg.unveilConsent.config.autoAction === "optOut");
check("init carries the compact rules for this URL", !!r.msg.unveilConsent.rules.compact && r.msg.unveilConsent.rules.compact.r.length > 50);

consent({ type: "eval", id: "e1", snippetId: "EVAL_OSANO_DETECT" }, 3);
await settle();
r = lastReply();
check("named snippet runs in the page's own world, in the asking frame",
  executed.at(-1).world === "MAIN" && executed.at(-1).target.frameIds[0] === 3);
check("snippet result goes back to that frame", r.opts.frameId === 3 && r.msg.unveilConsent.type === "evalResp" && r.msg.unveilConsent.id === "e1" && r.msg.unveilConsent.result === true);

const before = executed.length;
consent({ type: "eval", id: "e2", code: "alert(1)" });
await settle();
check("free text code is never run", executed.length === before && lastReply().msg.unveilConsent.result === false);

consent({ type: "autoconsentDone", cmp: "osano", url: "https://shop.example/", isCosmetic: false });
await settle();
check("handled banner counted for the tab", (await send({ type: "getBanners", tabId: 9 })) === 1);
listeners.mainFrame({ tabId: 9 });
check("banner count resets on a new page", (await send({ type: "getBanners", tabId: 9 })) === 0);

await send({ type: "setOption", key: "consentEnabled", value: false });
consent({ type: "init", url: "https://shop.example/" });
await settle();
check("banners off: init tells the frame to stand down", lastReply().msg.unveilConsent.config.enabled === false);

for (const [name, ok] of results) console.log((ok ? "PASS " : "FAIL ") + name);
console.log(`${results.filter((r) => r[1]).length}/${results.length} passed`);
process.exitCode = results.every((r) => r[1]) ? 0 : 1;
