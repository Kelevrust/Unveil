"use strict";

// Firefox (MV2) background. Blocks paywall vendor requests with webRequest,
// owns the per site off switch, and wires up cookie banner handling and Global
// Privacy Control from consent-bg.js, which the manifest loads first.

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

// ---------- cookie banners and Global Privacy Control ----------
// Shared logic lives in consent-bg.js (UnveilPrivacy). These apply on every
// site, including ones where the paywall features are switched off.

const bannersPerTab = new Map();

function countBanner(tabId) {
  bannersPerTab.set(tabId, (bannersPerTab.get(tabId) || 0) + 1);
}

function addGpcHeader(details) {
  const headers = details.requestHeaders.filter((h) => h.name.toLowerCase() !== "sec-gpc");
  headers.push({ name: "Sec-GPC", value: "1" });
  return { requestHeaders: headers };
}

// The header listener only exists while GPC is on, so it costs nothing when off.
async function applyGpc(enabled) {
  const on = browser.webRequest.onBeforeSendHeaders.hasListener(addGpcHeader);
  if (enabled && !on) {
    browser.webRequest.onBeforeSendHeaders.addListener(addGpcHeader, { urls: ["<all_urls>"] }, ["blocking", "requestHeaders"]);
  } else if (!enabled && on) {
    browser.webRequest.onBeforeSendHeaders.removeListener(addGpcHeader);
  }
  await UnveilPrivacy.syncGpcScript(enabled);
}

async function setOption(key, value) {
  if (!(key in UnveilPrivacy.DEFAULT_OPTIONS)) return;
  await browser.storage.local.set({ [key]: !!value });
  if (key === "gpcEnabled") await applyGpc(!!value);
}

UnveilPrivacy.getOptions().then(({ gpcEnabled }) => applyGpc(gpcEnabled));

// ---------- per tab counters and messages ----------

// Reset the per tab counters on each new page load.
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId >= 0) {
      blockedPerTab.delete(details.tabId);
      bannersPerTab.delete(details.tabId);
    }
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

browser.tabs.onRemoved.addListener((tabId) => {
  blockedPerTab.delete(tabId);
  bannersPerTab.delete(tabId);
});

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return undefined;
  if (UnveilPrivacy.isConsentMessage(msg)) {
    UnveilPrivacy.handleConsentMessage(msg.unveilConsent, sender, countBanner);
    return undefined;
  }
  if (msg.type === "getBlocked") {
    return Promise.resolve(blockedPerTab.get(msg.tabId) || 0);
  }
  if (msg.type === "getBanners") {
    return Promise.resolve(bannersPerTab.get(msg.tabId) || 0);
  }
  if (msg.type === "setSite") {
    return setSite(msg.site, msg.enabled).then(() => true);
  }
  if (msg.type === "setOption") {
    return setOption(msg.key, msg.value).then(() => true);
  }
  return undefined;
});
