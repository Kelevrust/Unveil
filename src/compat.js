// One namespace for both engines. Firefox exposes the promise based `browser`;
// Chromium exposes `chrome`, which is promise based in MV3 for every call
// Unveil makes. Loaded first in the content script list and the popup.
globalThis.api = globalThis.browser ?? globalThis.chrome;
