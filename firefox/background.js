"use strict";

// Firefox (MV2) background. Blocks paywall vendor requests with webRequest and
// owns the per site off switch.

// Keep in step with chromium/rules.json.
const BLOCKED_HOSTS = [
  "tinypass.com", // Piano (legacy domain, still widely used)
  "piano.io",     // Piano
  "poool.fr",     // Poool
  "pelcro.com",   // Pelcro
  "zephr.com",    // Zephr
  "laterpay.net"  // LaterPay
];

const BLOCKED_TYPES = ["script", "xmlhttprequest", "sub_frame"];

let disabledHosts = new Set();
const blockedPerTab = new Map();

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isDisabled(host) {
  for (const d of disabledHosts) {
    if (host === d || host.endsWith("." + d)) return true;
  }
  return false;
}

// The site the user is actually on. A request made from inside a vendor
// iframe has the vendor as its document, so walk up to the top level page.
function topLevelUrl(details) {
  const chain = details.frameAncestors;
  if (chain && chain.length) return chain[chain.length - 1].url;
  return details.documentUrl || details.originUrl || "";
}

const ready = browser.storage.local.get({ disabledHosts: [] }).then(({ disabledHosts: list }) => {
  disabledHosts = new Set(list);
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.disabledHosts) {
    disabledHosts = new Set(changes.disabledHosts.newValue || []);
  }
});

async function setSite(site, enabled) {
  await ready;
  let list = [...disabledHosts];
  if (enabled) {
    list = list.filter((d) => !(site === d || site.endsWith("." + d)));
  } else if (!list.includes(site)) {
    list.push(site);
  }
  disabledHosts = new Set(list);
  await browser.storage.local.set({ disabledHosts: list });
}

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    const pageHost = hostOf(topLevelUrl(details));
    if (pageHost && isDisabled(pageHost)) return {};
    if (details.tabId >= 0) {
      blockedPerTab.set(details.tabId, (blockedPerTab.get(details.tabId) || 0) + 1);
    }
    return { cancel: true };
  },
  {
    urls: BLOCKED_HOSTS.flatMap((h) => [`*://${h}/*`, `*://*.${h}/*`]),
    types: BLOCKED_TYPES
  },
  ["blocking"]
);

// Reset the per tab counter on each new page load.
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId >= 0) blockedPerTab.delete(details.tabId);
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

browser.tabs.onRemoved.addListener((tabId) => blockedPerTab.delete(tabId));

browser.runtime.onMessage.addListener((msg) => {
  if (!msg) return undefined;
  if (msg.type === "getBlocked") {
    return Promise.resolve(blockedPerTab.get(msg.tabId) || 0);
  }
  if (msg.type === "setSite") {
    return setSite(msg.site, msg.enabled).then(() => true);
  }
  return undefined;
});
