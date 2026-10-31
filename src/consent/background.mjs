// Background half of cookie banner handling and Global Privacy Control,
// shared by the Firefox and Chromium builds. Bundled to consent-bg.js, which
// sets globalThis.UnveilPrivacy for each browser's background.js to call.

import { evalSnippets, filterCompactRules } from "@duckduckgo/autoconsent";

const api = globalThis.browser ?? globalThis.chrome;

// DuckDuckGo's own extension defaults, with logging off.
const CONSENT_CONFIG = {
  autoAction: "optOut",
  disabledCmps: [],
  enablePrehide: true,
  enableCosmeticRules: true,
  enableGeneratedRules: true,
  enableHeuristicDetection: true,
  enablePopupMutationObserver: true,
  detectRetries: 20,
  isMainWorld: false,
  prehideTimeout: 2000,
  visualTest: false,
  logs: { lifecycle: false, rulesteps: false, detectionsteps: false, evals: false, errors: false, messages: false, waits: false },
  performanceLoggingEnabled: false,
  heuristicPopupSearchTimeout: 100,
  enableHeuristicHitTest: false,
  heuristicMode: "tier1"
};

export const DEFAULT_OPTIONS = { consentEnabled: true, gpcEnabled: true };

export async function getOptions() {
  return api.storage.local.get(DEFAULT_OPTIONS);
}

let rulesPromise = null;
function loadRules() {
  rulesPromise ??= fetch(api.runtime.getURL("compact-rules.json")).then((r) => r.json());
  return rulesPromise;
}

function reply(tabId, frameId, message) {
  return Promise.resolve(api.tabs.sendMessage(tabId, { unveilConsent: message }, { frameId })).catch(() => {});
}

// Handles one message from consent-content.js. `onHandled(tabId)` is called
// when a banner on that tab was dealt with, so the popup can count it.
export async function handleConsentMessage(message, sender, onHandled) {
  const tabId = sender.tab ? sender.tab.id : -1;
  const frameId = sender.frameId || 0;
  if (tabId < 0 || !message) return;

  switch (message.type) {
    case "init": {
      const { consentEnabled } = await getOptions();
      const url = sender.url || message.url || "";
      const rules = consentEnabled
        ? { autoconsent: [], compact: filterCompactRules(await loadRules(), { url, mainFrame: frameId === 0 }) }
        : { autoconsent: [] };
      await reply(tabId, frameId, { type: "initResp", config: { ...CONSENT_CONFIG, enabled: consentEnabled }, rules });
      break;
    }
    case "eval": {
      // Only named snippets from the library run in the page, never free text.
      const func = evalSnippets[message.snippetId];
      let result = false;
      if (func) {
        try {
          const [res] = await api.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world: "MAIN", func });
          result = res ? res.result : false;
        } catch {
          result = false;
        }
      }
      await reply(tabId, frameId, { type: "evalResp", id: message.id, result });
      break;
    }
    case "autoconsentDone":
      if (onHandled) onHandled(tabId);
      break;
    default:
      break;
  }
}

// navigator.globalPrivacyControl for page scripts. The Sec-GPC header is set
// by each browser's background, since Firefox and Chromium do that differently.
const GPC_SCRIPT = {
  id: "unveil-gpc",
  js: ["gpc-main.js"],
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_start",
  allFrames: true,
  world: "MAIN"
};

export async function syncGpcScript(enabled) {
  const existing = await api.scripting.getRegisteredContentScripts({ ids: [GPC_SCRIPT.id] });
  if (enabled && !existing.length) {
    await api.scripting.registerContentScripts([GPC_SCRIPT]);
  } else if (!enabled && existing.length) {
    await api.scripting.unregisterContentScripts({ ids: [GPC_SCRIPT.id] });
  }
}

export function isConsentMessage(msg) {
  return !!(msg && typeof msg === "object" && msg.unveilConsent);
}
