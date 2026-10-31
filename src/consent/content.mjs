// Cookie banner handling, in every frame from document_start.
//
// DuckDuckGo's autoconsent (MPL-2.0) recognises the consent platform on the
// page and takes the reject / necessary only path. The background answers its
// first message with only the rules that apply to this frame's URL, and runs
// the few checks that have to look at the page's own variables.

import AutoConsent from "@duckduckgo/autoconsent";

const api = globalThis.browser ?? globalThis.chrome;

const consent = new AutoConsent((message) => {
  // Fire and forget: replies arrive through onMessage below.
  Promise.resolve(api.runtime.sendMessage({ unveilConsent: message })).catch(() => {});
});

api.runtime.onMessage.addListener((msg) => {
  if (msg && msg.unveilConsent) {
    consent.receiveMessageCallback(msg.unveilConsent);
  }
  return false;
});
