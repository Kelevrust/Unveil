# End to end check of the built Chromium extension, loaded for real.
# Run after `node build.mjs`:  python3 tests/chromium_e2e.py
# Needs: pip install playwright && python3 -m playwright install chromium
import functools, http.server, pathlib, socketserver, sys, tempfile, threading
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
EXT = (HERE.parent / "dist" / "chromium").resolve()
if not (EXT / "manifest.json").exists():
    raise SystemExit("dist/chromium missing: run `node build.mjs` first")

# Remembers the Sec-GPC header each page request arrived with.
GPC_SEEN = {}
class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def do_GET(self):
        GPC_SEEN[self.path.split("?")[0]] = self.headers.get("Sec-GPC")
        super().do_GET()

handler = functools.partial(Handler, directory=str(HERE / "pages"))
server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
server.daemon_threads = True
PORT = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = f"http://localhost:{PORT}"

results = []
def check(name, cond):
    results.append((name, bool(cond)))

def shown(page, sel):
    return page.evaluate(f"(() => {{ const e = document.querySelector('{sel}'); return !!e && getComputedStyle(e).display !== 'none'; }})()")

def vendor_failures(ctx):
    """Load vendor.html and return {url: failure text} for vendor requests."""
    page = ctx.new_page()
    failures = {}
    page.on("requestfailed", lambda r: failures.__setitem__(r.url, r.failure))
    page.goto(f"{BASE}/vendor.html")
    page.wait_for_timeout(1500)
    return page, failures

with sync_playwright() as p, tempfile.TemporaryDirectory() as profile:
    ctx = p.chromium.launch_persistent_context(
        profile, channel="chromium", headless=True,
        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
        viewport={"width": 1280, "height": 800},
    )
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
    ext_id = sw.url.split("/")[2]
    check("service worker started", ext_id)
    ctx.pages[0].wait_for_timeout(1000)  # let onInstalled register the GPC script

    def choice_on(page_name, wait=4000):
        page = ctx.new_page()
        page.goto(f"{BASE}/{page_name}")
        page.wait_for_timeout(wait)
        return page, page.evaluate("document.body.dataset.choice || ''")

    loads = iter(range(1, 1000))
    def gpc_state():
        """Fresh, uncached load of gpc.html: (Sec-GPC header, what the page saw)."""
        page = ctx.new_page()
        GPC_SEEN.pop("/gpc.html", None)
        page.goto(f"{BASE}/gpc.html?load={next(loads)}")
        page.wait_for_timeout(500)
        state = (GPC_SEEN.get("/gpc.html", "never requested"), page.evaluate("document.body.dataset.gpc"))
        page.close()
        return state

    # Cookie banners: the reject / necessary only path is taken.
    cy, choice = choice_on("consent-cookieyes.html")
    check(f"CookieYes banner: reject clicked ({choice!r})", choice == "reject")
    osano, choice = choice_on("consent-osano.html")
    check(f"Osano banner, needs an in-page check: deny clicked ({choice!r})", choice == "deny")

    # Global Privacy Control: header on the request and the page sees it.
    header, nav = gpc_state()
    check(f"GPC header sent ({header!r})", header == "1")
    check(f"GPC visible to page scripts ({nav!r})", nav == "true")

    # Content script runs on a real page.
    a = ctx.new_page()
    a.goto(f"{BASE}/a.html")
    a.wait_for_timeout(1500)
    check("content script hides Piano modal", not shown(a, "#tpm"))
    check("content script keeps sticky header", shown(a, "#hdr"))

    # Static rule blocks vendor script and iframe.
    v, fails = vendor_failures(ctx)
    tp = [u for u in fails if "tinypass.com" in u]
    pi = [u for u in fails if "piano.io" in u]
    check("tinypass script blocked by extension", tp and fails[tp[0]] == "net::ERR_BLOCKED_BY_CLIENT")
    check("piano iframe blocked by extension", pi and fails[pi[0]] == "net::ERR_BLOCKED_BY_CLIENT")

    # Popup side messaging, from an extension page.
    ui = ctx.new_page()
    ui.goto(f"chrome-extension://{ext_id}/popup/popup.html")
    ui.wait_for_timeout(500)
    check("popup renders on a non web tab", "Not available" in ui.inner_text("#site"))
    tab_id = lambda name: ui.evaluate(f"api.tabs.query({{}}).then(ts => ts.find(t => t.url.includes('{name}')).id)")
    blocked = ui.evaluate("id => api.runtime.sendMessage({type: 'getBlocked', tabId: id})", tab_id("vendor.html"))
    check(f"popup blocked count for vendor page ({blocked})", blocked >= 2)
    stats = ui.evaluate("id => api.tabs.sendMessage(id, {type: 'getStats'})", tab_id("a.html"))
    check(f"popup overlay count for page A ({stats['removed']})", stats["removed"] >= 2)
    banners = ui.evaluate("id => api.runtime.sendMessage({type: 'getBanners', tabId: id})", tab_id("consent-cookieyes.html"))
    check(f"popup cookie banner count ({banners})", banners == 1)

    # Switch the site off: vendor requests flow and the content script stays out.
    ui.evaluate("api.runtime.sendMessage({type: 'setSite', site: 'localhost', enabled: false})")
    v.close()
    v, fails = vendor_failures(ctx)
    tp = [u for u in fails if "tinypass.com" in u]
    check("site off: tinypass not blocked by extension", not tp or fails[tp[0]] != "net::ERR_BLOCKED_BY_CLIENT")
    a.reload()
    a.wait_for_timeout(1500)
    check("site off: Piano modal left alone", shown(a, "#tpm"))
    header, _ = gpc_state()
    check(f"site off: GPC header still sent ({header!r})", header == "1")

    # And back on.
    ui.evaluate("api.runtime.sendMessage({type: 'setSite', site: 'localhost', enabled: true})")
    v.close()
    v, fails = vendor_failures(ctx)
    tp = [u for u in fails if "tinypass.com" in u]
    check("site back on: tinypass blocked again", tp and fails[tp[0]] == "net::ERR_BLOCKED_BY_CLIENT")

    # Privacy switches in the popup.
    ui.evaluate("api.runtime.sendMessage({type: 'setOption', key: 'consentEnabled', value: false})")
    _, choice = choice_on("consent-cookieyes.html")
    check(f"banners off: CookieYes left alone ({choice!r})", choice == "")
    ui.evaluate("api.runtime.sendMessage({type: 'setOption', key: 'consentEnabled', value: true})")

    ui.evaluate("api.runtime.sendMessage({type: 'setOption', key: 'gpcEnabled', value: false})")
    header, nav = gpc_state()
    check(f"GPC off: no header, nothing for page scripts ({header!r}, {nav!r})", header is None and nav == "undefined")
    ui.evaluate("api.runtime.sendMessage({type: 'setOption', key: 'gpcEnabled', value: true})")
    header, nav = gpc_state()
    check(f"GPC back on ({header!r}, {nav!r})", header == "1" and nav == "true")

    ctx.close()

server.shutdown()
for name, ok in results:
    print(("PASS " if ok else "FAIL ") + name)
print(f"{sum(ok for _, ok in results)}/{len(results)} passed")
sys.exit(0 if all(ok for _, ok in results) else 1)
