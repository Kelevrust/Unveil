"use strict";

// Chromium (MV3) background. Vendor blocking is the static rule in rules.json
// and the Sec-GPC header is the static rule in gpc-rules.json. This worker keeps
// the per site off switch in sync as one dynamic rule, wires up cookie banner
// handling from consent-bg.js, and answers the popup. Service workers sleep,
// so nothing lives in memory.

importScripts("compat.js", "consent-bg.js");

const VENDOR_RULESET = "vendors";
const GPC_RULESET = "gpc";
const SITE_OFF_RULE_ID = 1;

// One "allowAllRequests" rule covering every site the user switched off. It
// outranks the block rule for the whole frame tree of those pages, including
// requests made from inside a vendor iframe, so subscriber logins keep working.
// The GPC header rule has a higher priority still, so it applies there too.
async function syncSiteOffRule() {
  const { disabledHosts } = await chrome.storage.local.get({ disabledHosts: [] });
  const addRules = disabledHosts.length ? [{
    id: SITE_OFF_RULE_ID,
    priority: 2,
    action: { type: "allowAllRequests" },
    condition: { requestDomains: disabledHosts, resourceTypes: ["main_frame"] }
  }] : [];
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [SITE_OFF_RULE_ID],
    addRules
  });
}

async function setSite(site, enabled) {
  let { disabledHosts: list } = await chrome.storage.local.get({ disabledHosts: [] });
  if (enabled) {
    list = list.filter((d) => !(site === d || site.endsWith("." + d)));
  } else if (!list.includes(site)) {
    list.push(site);
  }
  await chrome.storage.local.set({ disabledHosts: list });
  await syncSiteOffRule();
}

// ---------- Global Privacy Control ----------

async function applyGpc(enabled) {
  await chrome.declarativeNetRequest.updateEnabledRulesets(
    enabled ? { enableRulesetIds: [GPC_RULESET] } : { disableRulesetIds: [GPC_RULESET] }
  );
  await UnveilPrivacy.syncGpcScript(enabled);
}

async function setOption(key, value) {
  if (!(key in UnveilPrivacy.DEFAULT_OPTIONS)) return;
  await chrome.storage.local.set({ [key]: !!value });
  if (key === "gpcEnabled") await applyGpc(!!value);
}

// Static rulesets go back to their manifest defaults on every update, so the
// stored choice is reapplied on install, update and browser start.
async function applyStoredState() {
  await syncSiteOffRule();
  const { gpcEnabled } = await UnveilPrivacy.getOptions();
  await applyGpc(gpcEnabled);
}

chrome.runtime.onInstalled.addListener(() => { applyStoredState(); });
chrome.runtime.onStartup.addListener(() => { applyStoredState(); });

// ---------- per tab counters ----------

// Matched rule history is per tab, not per page, so remember when each tab
// last started loading and only count matches after that.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") {
    chrome.storage.session.set({ ["loadStart:" + tabId]: Date.now(), ["banners:" + tabId]: 0 });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(["loadStart:" + tabId, "banners:" + tabId]);
});

async function blockedCount(tabId) {
  const key = "loadStart:" + tabId;
  const { [key]: since = 0 } = await chrome.storage.session.get(key);
  const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId, minTimeStamp: since });
  return rulesMatchedInfo.filter((m) => m.rule.rulesetId === VENDOR_RULESET).length;
}

async function countBanner(tabId) {
  const key = "banners:" + tabId;
  const { [key]: n = 0 } = await chrome.storage.session.get(key);
  await chrome.storage.session.set({ [key]: n + 1 });
}

async function bannerCount(tabId) {
  const key = "banners:" + tabId;
  const { [key]: n = 0 } = await chrome.storage.session.get(key);
  return n;
}

// ---------- messages ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (UnveilPrivacy.isConsentMessage(msg)) {
    UnveilPrivacy.handleConsentMessage(msg.unveilConsent, sender, countBanner);
    return false;
  }
  const answer = (promise, fallback) => {
    promise.then(sendResponse, () => sendResponse(fallback));
    return true;
  };
  if (msg.type === "getBlocked") return answer(blockedCount(msg.tabId), 0);
  if (msg.type === "getBanners") return answer(bannerCount(msg.tabId), 0);
  if (msg.type === "setSite") return answer(setSite(msg.site, msg.enabled).then(() => true), false);
  if (msg.type === "setOption") return answer(setOption(msg.key, msg.value).then(() => true), false);
  return false;
});
