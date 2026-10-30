import pathlib, sys
from playwright.sync_api import sync_playwright

# Content script behavior against fake paywall pages, with a stubbed
# extension API. Run from anywhere: python3 tests/run_tests.py
# Needs: pip install playwright && python3 -m playwright install chromium
HERE = pathlib.Path(__file__).resolve().parent
PAGES = HERE / "pages"
SRC = HERE.parent / "src"
CONTENT = (SRC / "compat.js").read_text() + "\n" + (SRC / "content.js").read_text()

STUB = """
window.browser = {
  storage: { local: { get: (d) => Promise.resolve(d) } },
  runtime: { onMessage: { addListener: () => {} } }
};
"""

results = []
def check(name, cond):
    results.append((name, bool(cond)))

def shown(page, sel):
    return page.evaluate(f"(() => {{ const e = document.querySelector('{sel}'); return !!e && getComputedStyle(e).display !== 'none'; }})()")

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1280, "height": 800})

    # Page A: Piano style modal, clipped and blurred article, sticky header.
    pg = ctx.new_page()
    pg.add_init_script(STUB)
    pg.goto((PAGES / "a.html").as_uri())
    pg.add_script_tag(content=CONTENT)
    pg.wait_for_timeout(1200)
    check("A: Piano modal hidden", not shown(pg, "#tpm"))
    check("A: Piano backdrop hidden", not shown(pg, "#tpb"))
    check("A: sticky header kept", shown(pg, "#hdr"))
    check("A: scroll unlocked", pg.evaluate("getComputedStyle(document.body).overflowY") != "hidden")
    check("A: lock class removed", not pg.evaluate("document.body.classList.contains('tp-modal-open')"))
    check("A: blur removed", pg.evaluate("getComputedStyle(document.getElementById('blur')).filter") == "none")
    check("A: article unclipped", pg.evaluate("(() => { const e = document.getElementById('body'); return e.scrollHeight <= e.clientHeight + 5; })()"))
    check("A: fade layer hidden", not shown(pg, "#fade"))

    # Page B: custom overlay, backdrop, bottom bar, decorative fixed background.
    pg = ctx.new_page()
    pg.add_init_script(STUB)
    pg.goto((PAGES / "b.html").as_uri())
    pg.add_script_tag(content=CONTENT)
    pg.wait_for_timeout(1200)
    check("B: custom wall hidden", not shown(pg, "#wall"))
    check("B: backdrop hidden", not shown(pg, "#shade"))
    check("B: bottom member bar hidden", not shown(pg, "#bar"))
    check("B: decorative background kept", shown(pg, "#bg"))
    check("B: main content kept", shown(pg, "main"))
    check("B: scroll unlocked", pg.evaluate("getComputedStyle(document.body).overflowY") != "hidden")
    pg.mouse.wheel(0, 600)
    pg.wait_for_timeout(300)
    check("B: page actually scrolls", pg.evaluate("window.scrollY") > 100)

    # Page C: inline prompt, article wrapper named paywall, user opened login, late paywall.
    pg = ctx.new_page()
    pg.add_init_script(STUB)
    pg.goto((PAGES / "c.html").as_uri())
    pg.add_script_tag(content=CONTENT)
    pg.wait_for_timeout(800)
    check("C: inline subscribe prompt hidden", not shown(pg, "#pwprompt"))
    check("C: article wrapper named paywall kept", shown(pg, "#pwcontent"))
    pg.click("#login")
    pg.wait_for_timeout(1500)
    check("C: user opened login modal kept", shown(pg, "#loginmodal"))
    pg.evaluate("document.getElementById('loginmodal').remove()")
    pg.wait_for_timeout(2500)
    pg.evaluate("addLatePaywall()")
    pg.wait_for_timeout(1000)
    check("C: late paywall hidden", not shown(pg, "#latewall"))
    pg.click("h1")
    pg.evaluate("addLatePaywall(); document.querySelectorAll('#latewall')[1].id = 'clicked'")
    pg.wait_for_timeout(1000)
    check("C: layer opened right after a click is spared", shown(pg, "#clicked"))

    b.close()

for name, ok in results:
    print(("PASS " if ok else "FAIL ") + name)
print(f"{sum(ok for _, ok in results)}/{len(results)} passed")
sys.exit(0 if all(ok for _, ok in results) else 1)
