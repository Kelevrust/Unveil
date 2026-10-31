"use strict";

const $ = (id) => document.getElementById(id);

const OPTION_DEFAULTS = { consentEnabled: true, gpcEnabled: true };

function siteOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function covers(entry, site) {
  return site === entry || site.endsWith("." + entry);
}

async function ask(message, fallback) {
  try {
    const answer = await api.runtime.sendMessage(message);
    return answer ?? fallback;
  } catch {
    return fallback;
  }
}

// Privacy options apply to every site, so they work on any tab.
async function setupPrivacy() {
  const options = await api.storage.local.get(OPTION_DEFAULTS);
  for (const key of Object.keys(OPTION_DEFAULTS)) {
    const box = $(key);
    box.checked = options[key];
    box.addEventListener("change", async () => {
      await ask({ type: "setOption", key, value: box.checked }, false);
      $("privacyHint").textContent = "Saved. Reload a page to apply it there.";
    });
  }
}

async function setupSite() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const site = tab ? siteOf(tab.url) : "";

  if (!site) {
    $("site").textContent = "Not available on this page";
    $("enabled").disabled = true;
    $("hint").textContent = "";
    return;
  }

  $("site").textContent = site;

  const { disabledHosts } = await api.storage.local.get({ disabledHosts: [] });
  $("enabled").checked = !disabledHosts.some((d) => covers(d, site));

  $("blocked").textContent = await ask({ type: "getBlocked", tabId: tab.id }, 0);
  $("banners").textContent = await ask({ type: "getBanners", tabId: tab.id }, 0);

  try {
    const stats = await api.tabs.sendMessage(tab.id, { type: "getStats" });
    $("removed").textContent = stats ? stats.removed : 0;
  } catch {
    $("removed").textContent = "0";
  }

  $("enabled").addEventListener("change", async (e) => {
    // The background owns the list so the blocking rules are updated before
    // the page reloads.
    await api.runtime.sendMessage({ type: "setSite", site, enabled: e.target.checked });
    await api.tabs.reload(tab.id);
    window.close();
  });
}

setupPrivacy();
setupSite();
