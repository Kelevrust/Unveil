// Exercises firefox/background.js with a stubbed WebExtension API.
// Firefox itself cannot be driven headless with an extension loaded here, so
// this checks the blocking and per site logic directly.
//   node tests/firefox_background.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const src = readFileSync(fileURLToPath(new URL("../firefox/background.js", import.meta.url)), "utf8");

let store = { disabledHosts: [] };
const listeners = { block: null, mainFrame: null, message: null };
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
    }
  },
  tabs: { onRemoved: { addListener: () => {} } },
  runtime: { onMessage: { addListener: (fn) => { listeners.message = fn; } } }
};

vm.runInNewContext(src, { browser, URL, Promise, console });
await new Promise((r) => setTimeout(r, 10));

const results = [];
const check = (name, ok) => results.push([name, !!ok]);
const send = (msg) => listeners.message(msg);
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

for (const [name, ok] of results) console.log((ok ? "PASS " : "FAIL ") + name);
console.log(`${results.filter((r) => r[1]).length}/${results.length} passed`);
process.exitCode = results.every((r) => r[1]) ? 0 : 1;
