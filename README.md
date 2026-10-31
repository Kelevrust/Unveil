# Unveil

A browser extension for Firefox and Chromium browsers (Chrome, Edge, Brave, Opera) that clears paywall popups on soft paywalled sites, answers cookie banners with "necessary only", and sends Global Privacy Control.

## What it does

1. **Hides paywall overlays.** Known vendor modals (Piano, Poool) are hidden on sight. Anything else that is fixed to the screen, covers a real share of it, and reads like a subscription prompt is hidden too, along with the dimmed backdrop behind it.
2. **Restores the page.** Unlocks scrolling, removes blur and fade masks from article text, and expands article containers that were clamped to a short height.
3. **Blocks paywall vendor scripts.** Requests to Piano, Poool, Pelcro, Zephr and LaterPay are cancelled, so their meters and modals never load.
4. **Per site off switch.** Click the toolbar icon to turn paywall cleanup off for a site. Use this on sites you pay for, since blocking the vendor scripts also blocks their login. Cookie banners and GPC keep working there.
5. **Declines cookie banners.** Recognises the consent platform on the page (OneTrust, Cookiebot, Didomi, Quantcast, Usercentrics, TrustArc, Sourcepoint, Osano, Termly, CookieYes and about 1,300 more rules) and takes the reject or necessary only path, including the extra clicks some banners need. Where a platform offers no reject button, the rule set may hide the banner instead, which leaves consent unanswered. The rules come from DuckDuckGo's [autoconsent](https://github.com/duckduckgo/autoconsent), the same set their browsers use.
6. **Sends Global Privacy Control.** Every request carries `Sec-GPC: 1` and page scripts see `navigator.globalPrivacyControl` as `true`. California treats this as an opt-out of the sale or sharing of personal data under the CCPA, including on sites that never show a banner.

Both privacy features are on by default and have their own switches in the popup.

Things the paywall cleanup deliberately leaves alone: site headers at the top of the screen, anything with a password field, and any popup that appears within 2 seconds of you clicking or typing (that is usually a login box or menu you opened).

## Layout

```
src/              shared by both browsers
  compat.js       one `api` global over browser/chrome, loads first
  content.js      overlay hiding, scroll unlock, unclipping
  gpc-main.js     navigator.globalPrivacyControl, runs in the page's own world
  consent/        cookie banner glue, bundled with autoconsent at build time
  popup/          toolbar popup
firefox/          MV2 manifest + background (webRequest blocking and GPC header)
chromium/         MV3 manifest + background (declarativeNetRequest) + rules.json + gpc-rules.json
icons/            SVG source plus the PNG sizes Chrome needs
tests/            fake paywall and consent pages, three test suites
build.mjs         builds dist/ for both browsers
```

The two backgrounds differ because the engines do: Firefox still supports blocking `webRequest`, Chromium only allows declarative rules. The per site switch is an `allowAllRequests` rule on Chromium and a top level page check on Firefox. Both cover requests made from inside a vendor iframe, so a subscriber login works on a site you switched off.

Cookie banners: `consent-content.js` runs in every frame from the start of page load. Its first message asks the background for rules, and the background answers with only the rules that apply to that frame's URL, out of `compact-rules.json`. A few platforms can only be read through the page's own variables; for those the background runs one of autoconsent's named snippets in the page's world. Free text code from a page is never run.

## Build

```
npm ci
node build.mjs
```

Node 22 or newer. `npm ci` installs the two pinned build dependencies: DuckDuckGo's autoconsent rules and esbuild, which bundles them. Writes:

| Output | Use |
| --- | --- |
| `dist/chromium/` | Load unpacked in Chrome, Edge, Brave, Opera |
| `dist/firefox/` | Load temporary in Firefox |
| `dist/unveil-chromium-<version>.zip` | Chrome Web Store upload |
| `dist/unveil-firefox-<version>.xpi` | Firefox install or AMO signing |

The build stops if `firefox/manifest.json` and `chromium/manifest.json` have different versions, or if the vendor host lists in `firefox/background.js`, `chromium/rules.json` and `src/content.js` drift apart. Bump and edit them together.

## Install

Download the files from [Releases](https://github.com/Kelevrust/Unveil/releases).

**Chrome, Edge, Brave**
1. Unzip `unveil-chromium-<version>.zip`
2. Open `chrome://extensions` (Edge: `edge://extensions`) and turn on **Developer mode**
3. Click **Load unpacked** and pick the unzipped folder

Chromium browsers only install packaged extensions from their stores, so outside a store this is the way in. It survives restarts.

**Firefox**
- Signed release: open `unveil-firefox-<version>.xpi` in Firefox and accept the prompt. It updates itself from then on.
- Unsigned build: `about:debugging#/runtime/this-firefox`, **Load Temporary Add-on**, pick the `.xpi`. Lasts until Firefox restarts. To keep an unsigned build installed, use Firefox Developer Edition or Nightly with `xpinstall.signatures.required` set to `false` in `about:config`, then install it from `about:addons`.

Requires Firefox 142+ or Chrome 111+.

## Limits

- **Hard paywalls do not budge.** If the site's server never sends the full article to non subscribers, there is nothing in the page to reveal.
- **Heuristics miss things.** If a site gets past it, inspect the overlay and add its selector to `VENDOR_SELECTORS` in `src/content.js`.
- **Metered counters:** a private window starts with a clean count on most metered sites.
- **Unknown cookie banners.** A banner from a platform the rule set doesn't know is left alone unless its buttons clearly read as reject.

## Customizing

| What | Where |
| --- | --- |
| Vendor hosts to block | `BLOCKED_HOSTS` in `firefox/background.js`, `chromium/rules.json`, `VENDOR_FRAME` in `src/content.js` |
| Vendor overlay selectors (hidden on sight) | `VENDOR_SELECTORS` in `src/content.js` |
| Site class/id patterns (hidden only if they read like a prompt) | `GENERIC_SELECTORS` in `src/content.js` |
| Prompt wording | `PROMPT_TEXT` in `src/content.js` |
| Click grace period | `USER_GRACE_MS` in `src/content.js` |
| Cookie banner behavior | `CONSENT_CONFIG` in `src/consent/background.mjs` |
| Cookie banner rules | the pinned `@duckduckgo/autoconsent` version in `package.json` |

After editing, rebuild and reload the extension.

## Tests

```
pip install playwright
python3 -m playwright install chromium
npm ci
node build.mjs
python3 tests/run_tests.py          # paywall content script on fake paywall pages
python3 tests/chromium_e2e.py       # built Chrome extension, loaded for real
node tests/firefox_background.mjs   # built Firefox background: blocking, per site, banners, GPC
```

`tests/pages` holds the fake pages: a vendor modal with a clipped article, a custom overlay with backdrop and bottom bar, an inline prompt with a user opened login box, a page that loads vendor code, CookieYes and Osano style consent banners (Osano's needs the in-page snippet path), and a page that reports the GPC signal it received.

CI runs all of these plus the Mozilla linter on every push and pull request.

## Releasing

1. Bump `version` in both `firefox/manifest.json` and `chromium/manifest.json`
2. `node build.mjs` (this also regenerates `updates.json`, which Firefox polls for updates)
3. Commit and push to `main`
4. Either push a tag (`git tag v0.3.0`, `git push origin v0.3.0`), or on GitHub open **Releases**, **Draft a new release**, type `v0.3.0` as a new tag on `main`, and publish

Either way the workflow runs the tests, signs the Firefox build if AMO keys are set, and attaches both files to the release a few minutes later. The tag has to match the manifest version or the release stops.

**Cookie banner rules** update through Dependabot: a weekly pull request bumps the pinned autoconsent version, and CI tests it before you merge.

**Firefox signing, once:** generate a JWT issuer and secret at [AMO Developer Hub, Manage API Keys](https://addons.mozilla.org/developers/addon/api/key/) and add them as repository secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`. Signing is unlisted, so there is no public AMO page. Without the secrets, or if Mozilla refuses to sign (it has removed paywall bypass add-ons before), the release still goes out with the Firefox file named `unveil-firefox-<version>-unsigned.xpi` and a warning on the run; the Developer Edition route above installs it.

## Third party code

Cookie banner handling bundles [@duckduckgo/autoconsent](https://github.com/duckduckgo/autoconsent), licensed under the [Mozilla Public License 2.0](https://www.mozilla.org/MPL/2.0/). Its files stay under that license; the built packages carry the license text in `licenses/` and a notice at the top of each bundled file. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
