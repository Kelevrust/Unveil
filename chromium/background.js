"use strict";

// Chromium (MV3) background. Vendor blocking is the static rule in rules.json.
// This worker keeps the per site off switch in sync as one dynamic rule and
// answers the popup. Service workers sleep, so nothing lives in memory.

const VENDOR_RULESET = "vendors";
const SITE_OFF_RULE_ID = 1;

// One "allowAllRequests" rule covering every site the user switched off. It
// outranks the block rule for the whole frame tree of those pages, including
// requests made from inside a vendor iframe, so subscriber logins keep working.
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

// Matched rule history is per tab, not per page, so remember when each tab
// last started loading and only count matches after that.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") {
    chrome.storage.session.set({ ["loadStart:" + tabId]: Date.now() });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove("loadStart:" + tabId);
});

async function blockedCount(tabId) {
  const key = "loadStart:" + tabId;
  const { [key]: since = 0 } = await chrome.storage.session.get(key);
  const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId, minTimeStamp: since });
  return rulesMatchedInfo.filter((m) => m.rule.rulesetId === VENDOR_RULESET).length;
}

chrome.runtime.onInstalled.addListener(() => { syncSiteOffRule(); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === "getBlocked") {
    blockedCount(msg.tabId).then(sendResponse, () => sendResponse(0));
    return true;
  }
  if (msg.type === "setSite") {
    setSite(msg.site, msg.enabled).then(() => sendResponse(true), () => sendResponse(false));
    return true;
  }
  return false;
});
