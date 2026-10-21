# SPDX-License-Identifier: AGPL-3.0-only
"""Playwright end-to-end check of the public web page: landing, loading, viewing, error states, share link round trip.

Run against a PRODUCTION build served on your own port (the CSP meta tag only exists in the build):
  npm run build:e2e && npx vite preview --outDir dist-e2e --port 5290 --strictPort &
  LD_LIBRARY_PATH=.venv/syslibs/usr/lib/x86_64-linux-gnu .venv/bin/python tests/e2e/web_check.py http://localhost:5290/ screenshots/web

Software GL is slow (a frame takes 0.2-0.5 s), so waits poll window.__phloem instead of sleeping. api.github.com is mocked with
Playwright routing (no quota used). Scenarios: see the section comments.
"""
import json
import re
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

args = [a for a in sys.argv[1:] if not a.startswith("--")]
BASE = args[0] if len(args) > 0 else "http://localhost:5290/"
OUT = args[1] if len(args) > 1 else "screenshots/web"
ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
Path(OUT).mkdir(parents=True, exist_ok=True)
fails = []

CSP_HOOK = """
window.__csp = [];
document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
"""


def check(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        fails.append(msg)


class Page:
    """A page with console/CSP capture."""

    def __init__(self, browser, size=(1280, 800), query="", mock=None, touch=False, **ctx_opts):
        self.ctx = browser.new_context(viewport={"width": size[0], "height": size[1]}, has_touch=touch, device_scale_factor=1, **ctx_opts)
        self.ctx.add_init_script(CSP_HOOK)
        if mock:
            self.ctx.route("https://api.github.com/**", mock.handler)
        self.page = self.ctx.new_page()
        self.logs = []
        self.page.on("console", lambda m: self.logs.append((m.type, m.text)) if m.type in ("error", "warning") else None)
        self.page.on("pageerror", lambda e: self.logs.append(("pageerror", str(e))))
        self.page.goto(BASE + query, wait_until="networkidle")

    def js(self, expr):
        return self.page.evaluate(expr)

    def wait(self, expr, timeout=90):
        self.page.wait_for_function(expr, timeout=timeout * 1000)

    def engine(self, timeout=90):
        self.wait("() => !!window.__phloem", timeout)

    def shot(self, name):
        self.page.screenshot(path=f"{OUT}/{name}.png")

    def csp(self):
        return self.js("() => window.__csp")

    def errors(self):
        return [l for l in self.logs if l[0] in ("error", "pageerror") and "403" not in l[1] and "404" not in l[1] and "Failed to load resource" not in l[1]]

    def snap_camera(self):
        self.js("() => window.__phloem.camera.snap()")

    def close(self):
        self.ctx.close()


class GithubMock:
    """Fake api.github.com. `limit_after`: requests after which every call is a 403 rate limit."""

    def __init__(self, commits=60, limit_after=10_000):
        self.count = 0
        self.limit_after = limit_after
        self.commits = commits
        self.calls = []
        self.reset = int(time.time()) + 1800

    def hdrs(self, remaining):
        return {
            "access-control-allow-origin": "*",
            "access-control-expose-headers": "link, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, x-ratelimit-resource, retry-after",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": str(remaining),
            "x-ratelimit-reset": str(self.reset),
            "x-ratelimit-resource": "core",
            "content-type": "application/json",
        }

    def handler(self, route):
        url = route.request.url
        path = url.split("api.github.com", 1)[1]
        self.calls.append((path, route.request.headers.get("authorization")))
        if route.request.method == "OPTIONS":
            return route.fulfill(status=204, headers={**self.hdrs(5000), "access-control-allow-headers": "authorization, accept"})
        if path.startswith("/rate_limit"):
            return route.fulfill(status=200, headers=self.hdrs(5000 - self.count), body=json.dumps({"resources": {"core": {"limit": 5000, "remaining": 5000 - self.count, "reset": self.reset}}}))
        if "/missing" in path:
            return route.fulfill(status=404, headers=self.hdrs(59), body=json.dumps({"message": "Not Found"}))
        self.count += 1
        if self.count > self.limit_after:
            return route.fulfill(status=403, headers=self.hdrs(0), body=json.dumps({"message": "API rate limit exceeded"}))
        rem = 5000 - self.count
        if re.fullmatch(r"/repos/[^/]+/[^/]+", path.split("?")[0]):
            return route.fulfill(status=200, headers=self.hdrs(rem), body=json.dumps({"default_branch": "main", "private": False}))
        if "/commits?" in path:
            items = []
            for i in range(self.commits, 0, -1):
                items.append({"sha": f"{i:040x}", "parents": [{"sha": f"{i-1:040x}"}] if i > 1 else [], "commit": {"message": f"commit number {i}\n\nbody", "tree": {"sha": f"t{i}"}, "author": {"name": f"Dev {i % 4}", "email": "d@x", "date": f"2024-{(i // 28) % 12 + 1:02d}-{(i % 28) + 1:02d}T10:00:00Z"}}})
            return route.fulfill(status=200, headers=self.hdrs(rem), body=json.dumps(items[:100]))
        if "/commits/" in path:
            i = int(path.split("/commits/")[1].split("?")[0], 16)
            files = [{"filename": f"src/mod{i % 7}/file{i}.ts", "status": "added", "additions": 20, "deletions": 0}]
            if i > 3:
                files.append({"filename": f"src/mod{(i - 3) % 7}/file{i - 3}.ts", "status": "modified", "additions": 3, "deletions": 1})
            return route.fulfill(status=200, headers=self.hdrs(rem), body=json.dumps({"sha": f"{i:040x}", "files": files}))
        return route.fulfill(status=404, headers=self.hdrs(rem), body=json.dumps({"message": "Not Found"}))


def no_overflow(p):
    return p.js("() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1")


def main():
    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=True, args=ARGS)

        # ------------------------------------------------------------ 1. landing, desktop
        p = Page(b)
        pg = p.page
        check("Phloem" in pg.title(), f"title: {pg.title()!r}")
        check(pg.locator("h1").inner_text().startswith("Watch a repository"), "h1 present")
        check(pg.get_by_label("GitHub repository").count() == 1, "repository input has a visible label")
        check(pg.locator("meta[http-equiv='Content-Security-Policy']").count() == 1, "CSP meta tag present in the build")
        for sel in ("meta[property='og:title']", "meta[name='description']", "meta[name='twitter:card']", "link[rel='manifest']", "link[rel='icon']"):
            check(pg.locator(sel).count() >= 1, f"head has {sel}")
        check(no_overflow(p), "no horizontal overflow at 1280")
        timing = p.js("""() => ({fcp: (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime,
                                 dcl: performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart})""")
        print("landing timing (software GL box):", timing)
        # engine behind the card
        p.engine()
        check(p.js("() => document.querySelector('.gm-chrome').classList.contains('is-backdrop')"), "viewer chrome hidden behind the landing card")
        p.wait("() => window.__phloem.header[1] > 5", 90)
        p.snap_camera()
        pg.wait_for_timeout(2500)
        p.shot("w01-landing-desktop")
        check(p.js("() => window.__phloem.director.enabled"), "backdrop is filmed by the auto-director")
        check(pg.locator(".gm-director").count() == 0, "there is no Director switch anywhere")
        # empty and invalid input
        pg.click("button.gm-go")
        check("owner/name" in pg.locator("#gm-err").inner_text(), "empty submit explains the format")
        pg.fill("#gm-repo", "not a repo")
        pg.click("button.gm-go")
        check(pg.locator("#gm-err").is_visible() and "github.com" in pg.locator("#gm-err").inner_text(), "invalid input gets an error")
        check(pg.get_attribute("#gm-repo", "aria-invalid") == "true", "aria-invalid set")
        pg.fill("#gm-repo", "")
        # estimate honesty
        est = pg.locator(".gm-estimate").inner_text()
        check("All available within your quota" in est and "60 requests" in est and "snapshots" in est, f"estimate (no token, default window): {est}")
        check(pg.input_value("#gm-max") == "all", "the default window is All available (never a silent 200)")
        check(pg.locator(".gm-demo").count() == 0 and pg.locator(".gm-chip").count() == 0, "no demo button and no express/flask/got/Hello-World chips on the card")
        check(pg.locator(".gm-feat").count() == 3 and "netbattle" in pg.locator(".gm-featured").inner_text(), "the three featured repositories are the only examples")
        pg.select_option("#gm-max", "3000")
        check("Capped at 1,000" in pg.locator(".gm-estimate").inner_text(), "anonymous window is capped and says so")
        pg.click(".gm-token-box summary")
        pg.fill(".gm-token-box .gm-tp-input", "ghp_FAKE")
        est2 = pg.locator(".gm-estimate").inner_text()
        check("Every commit" in est2 or "snapshots" in est2, f"estimate with token: {est2}")
        check(pg.get_attribute(".gm-token-box .gm-tp-input", "type") == "password", "token field is a password input")
        check("5,000 with one" in pg.locator(".gm-token-box").inner_text(), "token explanation mentions 60 vs 5,000 requests")
        pg.select_option("#gm-max", "200")
        pg.fill(".gm-token-box .gm-tp-input", "")
        pg.click(".gm-log-box summary")
        check("git log --first-parent" in pg.locator(".gm-cmd-text").inner_text(), "exact git log command shown")
        pg.click(".gm-log-box summary")
        # keyboard: form submit by Enter with an invalid value keeps focus on the input
        pg.fill("#gm-repo", "x")
        pg.press("#gm-repo", "Enter")
        check(pg.evaluate("() => document.activeElement.id") == "gm-repo", "Enter submits the form; focus returns to the input on error")
        pg.fill("#gm-repo", "")
        check(not p.csp(), f"no CSP violations on the landing ({p.csp()})")
        check(not p.errors(), f"no console errors on the landing {p.errors()[:3]}")
        p.close()

        # ------------------------------------------------------------ 2. landing, phone
        p = Page(b, size=(400, 800), touch=True)
        check(no_overflow(p), "no horizontal overflow at 400px")
        box = p.page.locator("button.gm-go").bounding_box()
        check(box["height"] >= 40 and box["width"] > 200, f"Visualize is a full-width touch target ({box['width']:.0f}x{box['height']:.0f})")
        p.engine()
        p.wait("() => window.__phloem.header[1] > 5", 90)
        p.snap_camera()
        p.page.wait_for_timeout(2500)
        p.shot("w02-landing-mobile")
        check(not p.csp(), "no CSP violations (phone)")
        p.close()

        # ------------------------------------------------------------ 3. mocked GitHub: loading, viewing, rate limit mid-way, resume
        mock = GithubMock(commits=60, limit_after=22)
        p = Page(b, mock=mock)
        pg = p.page
        pg.fill("#gm-repo", "https://github.com/acme/mold")
        pg.select_option("#gm-max", "100")
        pg.click(".gm-token-box summary")
        pg.fill(".gm-token-box .gm-tp-input", "ghp_FAKE_TOKEN_FOR_TEST")
        pg.click("button.gm-go")
        pg.wait_for_selector(".gm-status.is-center, .gm-chrome:not(.is-backdrop)", timeout=60000)
        p.wait("() => window.__phloem.commits.length >= 4", 60)
        pg.wait_for_timeout(500)
        check("repo=acme/mold" in pg.url and "max=100" in pg.url, f"URL after starting: {pg.url}")
        check(not pg.locator(".gm-landing").is_visible(), "landing card closed after Visualize")
        check("acme/mold" in pg.locator(".gm-repo").inner_text(), "viewer title shows the repository")
        # rate limit hit mid-way: partial results stay, the pill explains and offers Resume
        pg.wait_for_selector(".gm-status[data-tone='warn']", timeout=90000)
        n = p.js("() => window.__phloem.commits.length")
        check(4 <= n < 60, f"partial results are on screen ({n} commits)")
        txt = pg.locator(".gm-status").inner_text()
        check("rate limit" in txt.lower() and ("resets at" in txt or "reset" in txt.lower()), "rate-limit pill names the reset time")
        check(pg.locator(".gm-status button >> text=Resume").count() == 1, "Resume offered")
        p.js("() => window.__phloem.camera.snap()")
        pg.wait_for_timeout(1500)
        p.shot("w03-rate-limited-partial")
        mock.limit_after = 10_000
        pg.click(".gm-status button >> text=Resume")
        p.wait("() => window.__phloem.commits.length === 60", 90)
        check(True, "resume completes the history (60 commits)")
        check(all(a is None or a.startswith("Bearer ") for _, a in mock.calls), "token only sent as an Authorization header")
        check(all("ghp_FAKE" not in path for path, _ in mock.calls), "token never appears in a request URL")
        check("ghp_FAKE" not in pg.url, "token never appears in the page URL")
        check(p.js("() => localStorage.getItem('phloem.ghtoken.saved')") is None, "typed token is NOT persisted until Save is pressed")
        # --- saved histories: reopen is instant and free
        p.wait("() => indexedDB.databases().then((d) => d.some((x) => x.name === 'phloem-histories'))", 30)
        pg.wait_for_timeout(800)
        calls_before = len(mock.calls)
        pg.goto(BASE + "?repo=acme/mold&max=100", wait_until="networkidle")
        pg.wait_for_selector(".gm-status[data-tone='ok']", timeout=90000)
        check("saved history" in pg.locator(".gm-status").inner_text().lower(), "reopening a repo shows the saved history")
        check(len(mock.calls) == calls_before, f"saved history spent no API requests ({len(mock.calls) - calls_before})")
        p.wait("() => window.__phloem.commits.length === 60", 60)
        check(pg.locator(".gm-refresh").is_visible(), "Refresh history is offered for a repository")
        pg.mouse.move(500, 300)
        pg.click(".gm-refresh")
        pg.wait_for_selector(".gm-status[data-tone='ok']:has-text('Loaded')", timeout=90000)
        check(len(mock.calls) > calls_before, "Refresh history fetches from GitHub again")
        pg.click(".gm-clear")
        pg.wait_for_selector(".gm-pop button:has-text('Remove them')")
        check("saved" in pg.locator(".gm-pop").inner_text().lower() and "window.confirm" not in pg.content(), "clearing asks for confirmation in the page")
        p.shot("w13-clear-confirm")
        pg.click(".gm-pop button:has-text('Remove them')")
        pg.wait_for_selector(".gm-toast.is-on")
        check("removed" in pg.locator(".gm-toast").inner_text().lower(), "saved histories removed (toast)")
        check(p.js("() => indexedDB.databases().then(async (ds) => { if (!ds.some((x) => x.name === 'phloem-histories')) return 0; return await new Promise((r) => { const q = indexedDB.open('phloem-histories'); q.onsuccess = () => { const t = q.result.transaction('meta'); const c = t.objectStore('meta').count(); c.onsuccess = () => r(c.result); }; }); })") == 0, "history store is empty after clearing")
        pg.goto(BASE + "?repo=acme/mold&max=100", wait_until="networkidle")
        pg.wait_for_selector(".gm-chrome:not(.is-backdrop)", timeout=60000)
        check(pg.locator(".gm-status:has-text('saved history')").count() == 0, "after clearing, the next open is a real fetch")
        p.wait("() => window.__phloem.commits.length === 60", 90)
        pg.wait_for_timeout(1000)
        # re-seek the position the share test below expects
        p.js("() => window.__phloem.seek(5)")
        check(all(path.startswith("/") for path, _ in mock.calls), "only api.github.com was contacted")
        # viewing state
        pg.mouse.move(400, 400)
        pg.wait_for_timeout(1200)
        p.snap_camera()
        p.shot("w04-viewing-desktop")
        check("acme/mold" in pg.title(), f"document title follows the repo: {pg.title()!r}")
        # --- link round trip (the address bar is kept in sync; there is no Share button)
        p.js("() => window.__phloem.seek(30)")
        p.wait("() => window.__phloem.header[1] >= 29", 60)
        pg.select_option(".gm-speed", "2")
        pg.keyboard.press("l")  # all -> active
        pg.wait_for_timeout(1500)  # URL sync is throttled
        url_now = pg.url
        print("   url while watching:", url_now)
        check("labels=active" in url_now and "speed=2" in url_now, "labels and speed are written to the URL")
        m = None
        import re
        m = re.search(r"[?&]t=(\d+)", url_now)
        check(m is not None and 25 <= int(m.group(1)) <= 60, f"position t= is written to the URL ({m.group(1) if m else None})")
        copied = p.js("() => window.__phloem.web.syncUrl()")
        check(copied == pg.url and "repo=acme/mold" in copied, f"the address bar holds the current view: {copied}")
        p.close()
        # open the copied link in a brand new browser context
        mock2 = GithubMock(commits=60)
        p2 = Page(b, mock=mock2, query=copied[copied.index("?"):])
        p2.engine()
        p2.wait("() => window.__phloem.commits.length === 60", 90)
        p2.wait("() => window.__phloem.header[1] >= 20", 90)
        check(p2.js("() => document.querySelector('.gm-speed').value") == "2", "round trip: speed restored")
        check(p2.js("() => window.__phloem.labels.mode") == "active", "round trip: labels restored")
        check(p2.js("() => window.__phloem.header[1]") >= int(m.group(1)) - 3, "round trip: starts at the shared position")
        check("acme/mold" in p2.page.locator(".gm-repo").inner_text(), "round trip: repo title")
        check(not p2.page.locator(".gm-landing").is_visible(), "round trip: no landing card for a deep link")
        p2.close()

        # ------------------------------------------------------------ 4. errors: 404, nothing-loaded rate limit, bad ?repo=
        mock = GithubMock()
        p = Page(b, mock=mock)
        pg = p.page
        pg.fill("#gm-repo", "acme/missing")
        pg.click("button.gm-go")
        pg.wait_for_selector(".gm-banner[data-tone='error']", timeout=60000)
        msg = pg.locator(".gm-banner").inner_text().lower()
        check("not found" in msg and "private" in msg, f"404 explains and hints at private repos")
        check(pg.locator(".gm-landing").is_visible(), "the card stays up for the next attempt")
        check(pg.locator(".gm-banner button >> text=Add a token").count() == 1, "token action offered for a private-looking 404")
        p.shot("w05-error-404")
        p.close()
        mock = GithubMock(limit_after=0)
        p = Page(b, mock=mock)
        pg = p.page
        pg.fill("#gm-repo", "acme/mold")
        pg.click("button.gm-go")
        pg.wait_for_selector(".gm-banner[data-tone='warn'], .gm-banner[data-tone='error']", timeout=60000)
        txt = pg.locator(".gm-banner").inner_text().lower()
        check("rate limit" in txt, "rate limit with nothing loaded is shown on the card")
        pg.click(".gm-banner button >> text=Add a token")
        check(pg.evaluate("() => document.activeElement.classList.contains('gm-tp-input')"), "'Add a token' focuses the token field")
        p.shot("w06-error-rate-limit")
        p.close()
        p = Page(b, query="?repo=%20not%20a%20repo%20")
        check(p.page.locator(".gm-landing").is_visible() and "does not look like" in p.page.locator("#gm-err").inner_text(), "unparseable ?repo= lands on the card with an explanation")
        p.close()

        # ------------------------------------------------------------ 5. dev `?demo` history, chrome behaviour (desktop)
        p = Page(b)
        pg = p.page
        p.engine()
        pg.goto(BASE + "?demo", wait_until="networkidle")  # dev-only parameter: the landing has no demo button any more
        p.engine()
        p.wait("() => window.__phloem.commits.length === 336 && !document.querySelector('.gm-chrome').classList.contains('is-backdrop')", 90)
        check("demo" in pg.url, f"demo URL: {pg.url}")
        p.js("() => { window.__phloem.seek(200); }")
        p.wait("() => window.__phloem.header[1] >= 199", 60)
        p.snap_camera()
        pg.mouse.move(600, 400)
        pg.wait_for_timeout(1500)
        pg.click(".gm-legend-btn")
        check(pg.locator(".gm-legend li").count() == 4, f"legend lists the 4 authors ({pg.locator('.gm-legend li').count()})")
        check(pg.get_attribute(".gm-legend-btn", "aria-expanded") == "true", "legend toggle exposes aria-expanded")
        p.shot("w07-demo-legend")
        tl = pg.locator(".gm-tcard").inner_text()
        check(re.search(r"\d{1,2} [A-Z][a-z]{2} 202\d", tl) is not None and re.search(r"commit \d+ / 336", tl) is not None, f"Timeline card shows date, weekday and commit position: {tl!r}")
        check(pg.get_attribute(".gm-tc-live", "aria-live") == "polite", "timeline readout has an aria-live=polite region")
        # token popover from the top bar
        pg.click(".gm-tok-btn")
        pop = pg.locator(".gm-pop").inner_text()
        check("60 requests an hour without a token and 5,000 with one" in pop, "token popover explains the limits")
        check("Public repositories" in pop and "api.github.com" in pop and "no other server" in pop.lower(), "token popover states the privacy facts")
        link = pg.locator(".gm-pop a.gm-tp-link")
        check(link.get_attribute("href") == "https://github.com/settings/personal-access-tokens/new" and "noopener" in link.get_attribute("rel") and "noreferrer" in link.get_attribute("rel"), "create-token link is external with rel=noopener noreferrer")
        pg.fill(".gm-pop .gm-tp-input", "github_pat_TESTVALUE")
        check(p.js("() => localStorage.getItem('phloem.ghtoken.saved')") is None, "token stays in memory until Save")
        pg.click(".gm-pop .gm-tp-save")
        check(p.js("() => localStorage.getItem('phloem.ghtoken.saved')") == "github_pat_TESTVALUE", "Save on this device writes localStorage")
        p.shot("w14-token-popover")
        pg.click(".gm-pop .gm-tp-remove")
        check(p.js("() => localStorage.getItem('phloem.ghtoken.saved')") is None, "Remove saved token erases it")
        pg.keyboard.press("Escape")
        check(pg.locator(".gm-pop").is_hidden(), "Escape closes the popover")
        pg.click(".gm-ex-btn")
        check(pg.locator(".gm-ex-item").count() == 3 and "netbattle" in pg.locator(".gm-pop").inner_text() and "200" not in pg.locator(".gm-pop").inner_text(), "the Featured menu lists the three featured repositories by display name")
        p.shot("w15-examples-menu")
        pg.keyboard.press("Escape")
        pg.keyboard.press("Escape")
        check(pg.locator(".gm-legend").is_hidden(), "Escape closes the legend")
        pg.evaluate("() => document.activeElement.blur()")
        # idle fade (the chrome stays while paused, fades while playing)
        pg.keyboard.press("Space")
        pg.wait_for_timeout(200)
        playing = p.js("() => document.querySelector('.gm-play').getAttribute('aria-label')")
        if playing == "Play":
            pg.keyboard.press("Space")  # make sure it plays
        pg.mouse.move(300, 300)
        pg.wait_for_timeout(5200)
        check(p.js("() => document.querySelector('.gm-chrome').classList.contains('is-idle')"), "chrome fades out after a few idle seconds of playback")
        check(p.js("() => parseFloat(getComputedStyle(document.querySelector('.gm-top')).opacity)") < 0.5, "top bar is transparent when idle")
        p.snap_camera()
        pg.wait_for_timeout(800)
        p.shot("w08-demo-idle-cinematic")
        pg.mouse.move(420, 330)
        pg.wait_for_timeout(900)
        check(not p.js("() => document.querySelector('.gm-chrome').classList.contains('is-idle')"), "any pointer movement brings the chrome back")
        # keyboard control
        pg.keyboard.press("h")
        pg.wait_for_timeout(900)
        check(p.js("() => document.querySelector('.gm-chrome').classList.contains('is-hidden')"), "H hides the chrome")
        pg.keyboard.press("h")
        pg.keyboard.press("l")
        pg.wait_for_timeout(1500)
        check("labels=" in pg.url, f"L cycles labels and updates the URL: {pg.url}")
        # open the landing again from the viewer (overlay)
        pg.mouse.move(100, 100)
        pg.click(".gm-new")
        check(pg.locator(".gm-landing.is-overlay").is_visible(), "the brand button opens the landing card over the viewer")
        check(pg.evaluate("() => document.activeElement.id") == "gm-repo", "focus moves into the card")
        pg.keyboard.press("Escape")
        check(not pg.locator(".gm-landing").is_visible(), "Escape closes the overlay")
        check(not p.csp(), f"no CSP violations in the viewer ({p.csp()})")
        check(not p.errors(), f"no console errors in the viewer {p.errors()[:3]}")
        p.close()

        # ------------------------------------------------------------ 5b. featured card: prebuilt, no GitHub request
        mock = GithubMock()
        p = Page(b, mock=mock)
        pg = p.page
        p.engine()
        pg.click(".gm-feat[data-repo='thcp/netbattle']")
        p.wait("() => window.__phloem.commits.length >= 2 && !document.querySelector('.gm-chrome').classList.contains('is-backdrop')", 90)
        pg.wait_for_selector(".gm-status[data-tone='ok']", timeout=60000)
        check("netbattle" in pg.locator(".gm-repo").inner_text() and "thcp" not in pg.locator(".gm-repo").inner_text(), "viewer title shows the display name 'netbattle'")
        check("prebuilt" in pg.locator(".gm-status").inner_text().lower() and "netbattle" in pg.locator(".gm-status").inner_text(), "status pill names the featured repository by its display name")
        check(len(mock.calls) == 0, f"a featured repository uses no GitHub request ({len(mock.calls)})")
        check("max=" not in pg.url, f"the shared URL has no max parameter by default: {pg.url}")
        p.close()

        # ------------------------------------------------------------ 6. phone viewer + deep link params
        p = Page(b, size=(400, 800), touch=True, query="?demo&t=150&speed=2&labels=off")
        pg = p.page
        p.engine()
        p.wait("() => window.__phloem.commits.length === 336 && window.__phloem.header[1] >= 140", 90)
        check(p.js("() => document.querySelector('.gm-speed').value") == "2", "deep link: speed=2")
        check(p.js("() => window.__phloem.labels.mode") == "off", "deep link: labels=off")
        check(p.js("() => document.querySelector('.gm-names').getAttribute('aria-pressed')") == "false", "names toggle reflects labels=off")
        p.snap_camera()
        pg.wait_for_timeout(1500)
        p.shot("w09-viewer-mobile")
        check(no_overflow(p), "viewer: no horizontal overflow at 400px")
        for sel in (".gm-play", ".gm-legend-btn"):
            bb = pg.locator(sel).bounding_box()
            check(bb is not None and bb["width"] >= 40 and bb["height"] >= 40, f"touch target {sel}: {bb['width']:.0f}x{bb['height']:.0f}")
        pg.tap(".gm-legend-btn")
        pg.wait_for_timeout(400)
        p.shot("w10-viewer-mobile-legend")
        check(pg.locator(".gm-legend").is_visible(), "legend opens on phone")
        check(not p.errors(), f"no console errors (phone viewer) {p.errors()[:3]}")
        p.close()

        # ------------------------------------------------------------ 7. file upload (local), share is not offered
        p = Page(b)
        pg = p.page
        p.engine()
        pg.click(".gm-log-box summary")
        pg.set_input_files(".gm-file input[type=file]", "fixtures/stemdeck-first10.json")
        p.wait("() => window.__phloem.commits.length === 10 && !document.querySelector('.gm-chrome').classList.contains('is-backdrop')", 90)
        check("stemdeck-first10.json" in pg.locator(".gm-repo").inner_text(), "file name is the title")
        p.close()

        # ------------------------------------------------------------ 8. reduced motion and no WebGL
        p = Page(b, reduced_motion="reduce")
        p.engine()
        p.wait("() => window.__phloem.header[1] > 100", 120)
        check(p.js("() => window.__phloem.director.enabled && window.__phloem.director.reduced"), "reduced motion: the director still runs, scaled down")
        check(not p.js("() => document.querySelector('.gm-card').getAnimations().length") , "reduced motion: card entrance animation off")
        p.snap_camera()
        p.page.wait_for_timeout(1500)
        p.shot("w11-landing-reduced-motion")
        p.close()

        ctx = b.new_context(viewport={"width": 1000, "height": 700})
        ctx.add_init_script("const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...a) { return t === 'webgl2' ? null : g.call(this, t, ...a); };")
        page = ctx.new_page()
        page.goto(BASE + "?demo", wait_until="networkidle")
        page.wait_for_selector(".gm-fatal", timeout=30000)
        check("WebGL" in page.locator(".gm-fatal").inner_text(), "no WebGL 2: a readable full-page message")
        page.screenshot(path=f"{OUT}/w12-no-webgl.png")
        ctx.close()

        b.close()
    print()
    if fails:
        print(f"{len(fails)} FAILED:")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print("all web checks passed")


main()
