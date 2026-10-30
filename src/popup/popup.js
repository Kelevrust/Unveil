"use strict";

const $ = (id) => document.getElementById(id);

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

(async () => {
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

  try {
    $("blocked").textContent = await api.runtime.sendMessage({ type: "getBlocked", tabId: tab.id }) ?? 0;
  } catch {
    $("blocked").textContent = "0";
  }

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
})();
