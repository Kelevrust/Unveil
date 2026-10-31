# Unveil

A browser extension for Firefox and Chromium browsers (Chrome, Edge, Brave, Opera) that clears paywall popups on soft paywalled sites.

## What it does

1. **Hides paywall overlays.** Known vendor modals (Piano, Poool) are hidden on sight. Anything else that is fixed to the screen, covers a real share of it, and reads like a subscription prompt is hidden too, along with the dimmed backdrop behind it.
2. **Restores the page.** Unlocks scrolling, removes blur and fade masks from article text, and expands article containers that were clamped to a short height.
3. **Blocks paywall vendor scripts.** Requests to Piano, Poool, Pelcro, Zephr and LaterPay are cancelled, so their meters and modals never load.
4. **Per site off switch.** Click the toolbar icon to turn it off for a site. Use this on sites you pay for, since blocking the vendor scripts also blocks their login.

Things it deliberately leaves alone: site headers at the top of the screen, anything with a password field, and any popup that appears within 2 seconds of you clicking or typing (that is usually a login box or menu you opened).

## Layout

```
src/            shared by both browsers
  compat.js     one `api` global over browser/chrome, loads first
  content.js    overlay hiding, scroll unlock, unclipping
  popup/        toolbar popup
firefox/        MV2 manifest + background (webRequest blocking)
chromium/       MV3 manifest + background (declarativeNetRequest) + rules.json
icons/          SVG source plus the PNG sizes Chrome needs
tests/          fake paywall pages and three test suites
build.mjs       builds dist/ for both browsers
```

The two backgrounds differ because the engines do: Firefox still supports blocking `webRequest`, Chromium only allows declarative rules. The per site switch is an `allowAllRequests` rule on Chromium and a top level page check on Firefox. Both cover requests made from inside a vendor iframe, so a subscriber login works on a site you switched off.

## Build

```
node build.mjs
```

Node 22 or newer, no dependencies. Writes:

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

## Customizing

| What | Where |
| --- | --- |
| Vendor hosts to block | `BLOCKED_HOSTS` in `firefox/background.js`, `chromium/rules.json`, `VENDOR_FRAME` in `src/content.js` |
| Vendor overlay selectors (hidden on sight) | `VENDOR_SELECTORS` in `src/content.js` |
| Site class/id patterns (hidden only if they read like a prompt) | `GENERIC_SELECTORS` in `src/content.js` |
| Prompt wording | `PROMPT_TEXT` in `src/content.js` |
| Click grace period | `USER_GRACE_MS` in `src/content.js` |

After editing, rebuild and reload the extension.

## Tests

```
pip install playwright
python3 -m playwright install chromium
node build.mjs
python3 tests/run_tests.py          # content script on fake paywall pages
python3 tests/chromium_e2e.py       # built Chrome extension, loaded for real
node tests/firefox_background.mjs   # Firefox blocking and per site logic
```

`tests/pages` holds the fake pages: a vendor modal with a clipped article, a custom overlay with backdrop and bottom bar, an inline prompt with a user opened login box, and a page that loads vendor code.

CI runs all of these plus the Mozilla linter on every push and pull request.

## Releasing

1. Bump `version` in both `firefox/manifest.json` and `chromium/manifest.json`
2. `node build.mjs` (this also regenerates `updates.json`, which Firefox polls for updates)
3. Commit and push to `main`
4. Either push a tag (`git tag v0.3.0`, `git push origin v0.3.0`), or on GitHub open **Releases**, **Draft a new release**, type `v0.3.0` as a new tag on `main`, and publish

Either way the workflow runs the tests, signs the Firefox build if AMO keys are set, and attaches both files to the release a few minutes later. The tag has to match the manifest version or the release stops.

**Firefox signing, once:** generate a JWT issuer and secret at [AMO Developer Hub, Manage API Keys](https://addons.mozilla.org/developers/addon/api/key/) and add them as repository secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`. Signing is unlisted, so there is no public AMO page. Without the secrets, or if Mozilla refuses to sign (it has removed paywall bypass add-ons before), the release still goes out with the Firefox file named `unveil-firefox-<version>-unsigned.xpi` and a warning on the run; the Developer Edition route above installs it.
