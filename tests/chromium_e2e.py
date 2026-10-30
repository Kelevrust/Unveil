# End to end check of the built Chromium extension, loaded for real.
# Run after `node build.mjs`:  python3 tests/chromium_e2e.py
# Needs: pip install playwright && python3 -m playwright install chromium
import functools, http.server, pathlib, socketserver, sys, tempfile, threading
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
EXT = (HERE.parent / "dist" / "chromium").resolve()
if not (EXT / "manifest.json").exists():
    raise SystemExit("dist/chromium missing: run `node build.mjs` first")

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(HERE / "pages"))
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
server = socketserver.TCPServer(("127.0.0.1", 0), handler)
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

    # Switch the site off: vendor requests flow and the content script stays out.
    ui.evaluate("api.runtime.sendMessage({type: 'setSite', site: 'localhost', enabled: false})")
    v.close()
    v, fails = vendor_failures(ctx)
    tp = [u for u in fails if "tinypass.com" in u]
    check("site off: tinypass not blocked by extension", not tp or fails[tp[0]] != "net::ERR_BLOCKED_BY_CLIENT")
    a.reload()
    a.wait_for_timeout(1500)
    check("site off: Piano modal left alone", shown(a, "#tpm"))

    # And back on.
    ui.evaluate("api.runtime.sendMessage({type: 'setSite', site: 'localhost', enabled: true})")
    v.close()
    v, fails = vendor_failures(ctx)
    tp = [u for u in fails if "tinypass.com" in u]
    check("site back on: tinypass blocked again", tp and fails[tp[0]] == "net::ERR_BLOCKED_BY_CLIENT")

    ctx.close()

server.shutdown()
for name, ok in results:
    print(("PASS " if ok else "FAIL ") + name)
print(f"{sum(ok for _, ok in results)}/{len(results)} passed")
sys.exit(0 if all(ok for _, ok in results) else 1)
