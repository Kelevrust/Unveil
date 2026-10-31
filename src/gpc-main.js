// Global Privacy Control for page scripts: navigator.globalPrivacyControl is
// true, telling the site this visitor opts out of the sale or sharing of their
// data. Runs in the page's own world. The matching Sec-GPC request header is
// set by the extension's background.
(() => {
  try {
    if (navigator.globalPrivacyControl === true) return;
    Object.defineProperty(Navigator.prototype, "globalPrivacyControl", {
      get() { return true; },
      configurable: true,
      enumerable: true
    });
  } catch {
    // The page locked the property. The request header still goes out.
  }
})();
