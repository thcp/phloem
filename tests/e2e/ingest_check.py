# SPDX-License-Identifier: AGPL-3.0-only
"""Playwright end-to-end check of real ingestion (file upload, GitHub URL, UI states).

Usage (dev server, or `vite preview` of the e2e build (`npm run build:e2e`, which keeps the window.__phloem test hook) on BASE, own port):
  .venv/bin/python tests/e2e/ingest_check.py [base_url] [out_dir] [stemdeck.log] [synth.log] [--no-network]
Generate the logs first (see docs/INGESTION.md):
  git -C <clone> log --first-parent --reverse -M --raw --numstat --format='@@%H%x09%aI%x09%an%x09%ae%x09%s' > stemdeck.log
  npm run synth-log -- synth.log 1500 300 3
Scenarios: landing card (desktop + phone), upload of a real git log (compared with the bundled fixture), backward seek,
synthetic upload, mocked GitHub (rate limit + resume, 404, cancel), and (unless --no-network) one tiny real repo.
"""
import json
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

args = [a for a in sys.argv[1:] if not a.startswith("--")]
NET = "--no-network" not in sys.argv
ONLY_GH = "--only-github" in sys.argv
ONLY_REAL = "--only-real" in sys.argv
BASE = args[0] if len(args) > 0 else "http://localhost:5199/"
OUT = args[1] if len(args) > 1 else "screenshots/ingest"
STEM = args[2] if len(args) > 2 else None
SYNTH = args[3] if len(args) > 3 else None
ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
Path(OUT).mkdir(parents=True, exist_ok=True)
fails = []


def check(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        fails.append(msg)


def new_page(browser, query="", size=(1280, 820), logs=None):
    ctx = browser.new_context(viewport={"width": size[0], "height": size[1]})
    page = ctx.new_page()
    logs = logs if logs is not None else []
    page.on("console", lambda m: logs.append((m.type, m.text)) if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    page.goto(BASE + query, wait_until="networkidle")
    return ctx, page, logs


DONE = "() => window.__phloem && window.__phloem.web.status && window.__phloem.web.status.state === 'done'"


def wait_for(page, js, timeout=120):
    page.wait_for_function(js, timeout=timeout * 1000)


def hdr(page):
    return page.evaluate("() => Array.from(window.__phloem.header)")


def wait_commit(page, idx, timeout=180):
    """Wait until the sim has applied commit `idx` and finished any seek."""
    wait_for(page, f"() => {{ const h = window.__phloem.header; return h[1] >= {idx} && h[14] === 0; }}", timeout)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=ARGS)

        if ONLY_REAL:
            real_github(browser)
            browser.close()
            print("\nFAILED: %d" % len(fails) if fails else "\nall checks passed")
            sys.exit(1 if fails else 0)
        if ONLY_GH:
            gh_mock(browser)
            if NET:
                real_github(browser)
            browser.close()
            print("\nFAILED: %d" % len(fails) if fails else "\nall checks passed")
            sys.exit(1 if fails else 0)

        # ---- landing card, desktop and phone
        ctx, page, logs = new_page(browser, "")
        page.wait_for_selector(".gm-landing:not([hidden])")
        check(page.locator("#gm-repo").evaluate("e => e === document.activeElement"), "repo field focused when the landing card opens")
        page.screenshot(path=f"{OUT}/01-landing-card.png")
        page.fill("#gm-repo", "not a repo")
        page.click(".gm-go")
        check(page.locator("#gm-err").is_visible(), "invalid repo shows an inline error")
        ctx.close()
        ctx, page, logs2 = new_page(browser, "", size=(400, 800))
        page.wait_for_selector(".gm-landing:not([hidden])")
        page.screenshot(path=f"{OUT}/02-landing-card-phone.png")
        ow = page.evaluate("() => document.documentElement.scrollWidth <= innerWidth + 1")
        check(ow, "phone width: no horizontal page overflow")
        ctx.close()

        # ---- real git log upload (stemdeck clone)
        if STEM:
            ctx, page, logs = new_page(browser, "?tpc=20")
            page.wait_for_selector(".gm-landing:not([hidden])")
            t0 = time.time()
            page.set_input_files(".gm-landing input[type=file]", STEM)
            wait_for(page, DONE)
            print(f"stemdeck log parsed in {time.time() - t0:.1f}s (incl. page work)")
            commits = page.evaluate("() => window.__phloem.commits")
            fixture = json.load(open("fixtures/stemdeck-full.json"))
            n = min(len(fixture), len(commits))
            same = 0
            for a, b in zip(fixture[:n], commits[:n]):
                fa = [(f["path"], f["status"], f["added"], f["removed"], f.get("old_path")) for f in a["files"]]
                fb = [(f["path"], f["status"], f["added"], f["removed"], f.get("old_path")) for f in b["files"]]
                if a["hash"] == b["hash"] and a["author"] == b["author"] and a["message"] == b["message"] and fa == fb:
                    same += 1
            print(f"log commits {len(commits)}, fixture commits {len(fixture)}, identical in first {n}: {same}")
            check(len(commits) > 100 and same >= n - 2 and same > 0, "git log upload reproduces the bundled fixture's commits (paths, statuses, counts)")
            check(page.evaluate("() => window.__phloem.source") == "stemdeck.log", "source label is the file name")
            page.evaluate("() => window.__phloem.play(true)")
            wait_commit(page, 8)
            page.wait_for_timeout(2500)
            page.screenshot(path=f"{OUT}/03-upload-stemdeck-playing.png")
            page.evaluate("() => window.__phloem.play(false)")
            # backward seek on a longer history, repeatedly, via the scrubber API
            for target in (60, 20, 100, 5):
                page.evaluate(f"() => window.__phloem.seek({target})")
                wait_for(page, f"() => {{ const h = window.__phloem.header; return h[1] === {target} && h[14] === 0; }}", 180)
            check(True, "scrub back and forth (60, 20, 100, 5) settles on the requested commit")
            cp = page.evaluate("() => window.__phloem.client.checkpoints")
            print("checkpoints:", cp)
            check(cp is not None and cp["count"] > 0, "worker reports checkpoints")
            page.evaluate("() => window.__phloem.seek(120)")
            wait_for(page, "() => { const h = window.__phloem.header; return h[1] === 120 && h[14] === 0; }", 180)
            page.wait_for_timeout(3000)
            page.screenshot(path=f"{OUT}/04-upload-stemdeck-commit120.png")
            check(not [l for l in logs if l[0] in ("error", "pageerror")], "no console errors during the upload run")
            if logs:
                print("console:", logs[:5])
            ctx.close()

        # ---- synthetic upload while streaming: playback starts before parsing ends
        if SYNTH:
            ctx, page, logs = new_page(browser, "?tpc=8")
            page.set_input_files(".gm-landing input[type=file]", SYNTH)
            wait_for(page, "() => window.__phloem.header[1] >= 3")
            wait_for(page, DONE)
            n = page.evaluate("() => window.__phloem.commits.length")
            check(n == 120, f"synthetic log: all 120 commits loaded ({n})")
            page.evaluate("() => window.__phloem.seek(40)")  # not real-time playback: software GL frames are too slow to rely on it
            wait_commit(page, 40)
            page.screenshot(path=f"{OUT}/06-synthetic-upload.png", timeout=180000)
            check(not [l for l in logs if l[0] in ("error", "pageerror")], "no console errors (synthetic)")
            ctx.close()

        # ---- bad file
        ctx, page, logs = new_page(browser, "")
        Path(OUT, "_garbage.txt").write_text("hello\nthis is not a git log\n")
        page.set_input_files(".gm-landing input[type=file]", str(Path(OUT, "_garbage.txt")))
        page.wait_for_function("() => window.__phloem && window.__phloem.web.status && window.__phloem.web.status.state === 'error'")
        page.wait_for_selector(".gm-landing:not([hidden]) .gm-banner:not([hidden])")
        check("No commits found" in page.locator(".gm-banner").inner_text(), "garbage file gives a helpful error on the landing card")
        page.screenshot(path=f"{OUT}/07-bad-file-error.png")
        Path(OUT, "_garbage.txt").unlink()
        ctx.close()

        # ---- GitHub with a mocked api.github.com: progress, rate limit mid-way, resume, 404, cancel
        gh_mock(browser)

        if NET:
            real_github(browser)
        browser.close()
    print("\nFAILED: %d" % len(fails) if fails else "\nall checks passed")
    sys.exit(1 if fails else 0)


def real_github(browser):
    """One tiny real public repo through the URL path (a handful of unauthenticated requests: repo, list, one per commit)."""
    ctx, page, logs = new_page(browser, "?repo=octocat/Hello-World")
    # the commits array is the common truth
    wait_for(page, "() => window.__phloem && window.__phloem.commits && window.__phloem.commits.length >= 2", 90)
    n = page.evaluate("() => window.__phloem.commits.length")
    check(n >= 2, f"real GitHub repo (octocat/Hello-World) loaded via the URL path ({n} commits)")
    check(page.evaluate("() => window.__phloem.commits[0].files.length") >= 1, "commit file lists were fetched")
    page.wait_for_timeout(4000)
    page.screenshot(path=f"{OUT}/10-real-github-hello-world.png")
    check(not [l for l in logs if l[0] in ("error", "pageerror")], "no console errors (real GitHub)")
    if logs:
        print("console:", logs[:5])
    ctx.close()


def gh_mock(browser):
    """Fake api.github.com with Playwright routing (no quota used)."""
    state = {"count": 0, "limit_after": 14, "calls": [], "delay": 0.0}
    reset = int(time.time()) + 1800

    def hdrs(remaining):
        return {
            "access-control-allow-origin": "*",
            "access-control-expose-headers": "link, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, x-ratelimit-resource, retry-after",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": str(remaining),
            "x-ratelimit-reset": str(reset),
            "x-ratelimit-resource": "core",
            "content-type": "application/json",
        }

    def handler(route):
        url = route.request.url
        path = url.split("api.github.com", 1)[1]
        state["calls"].append(path)
        if path.startswith("/rate_limit"):
            return route.fulfill(status=200, headers=hdrs(5000 - state["count"]), body=json.dumps({"resources": {"core": {"limit": 5000, "remaining": 5000 - state["count"], "reset": reset}}}))
        if "/missing" in path:
            return route.fulfill(status=404, headers=hdrs(59), body=json.dumps({"message": "Not Found"}))
        if state["delay"] and "/commits/" in path:
            time.sleep(state["delay"])
        state["count"] += 1
        if state["count"] > state["limit_after"]:
            return route.fulfill(status=403, headers={**hdrs(0)}, body=json.dumps({"message": "API rate limit exceeded"}))
        rem = 5000 - state["count"]
        if path.endswith("/repos/acme/mold"):
            return route.fulfill(status=200, headers=hdrs(rem), body=json.dumps({"default_branch": "main", "private": False}))
        if "/commits?" in path:
            items = []
            for i in range(60, 0, -1):
                items.append({"sha": f"{i:040x}", "parents": [{"sha": f"{i-1:040x}"}] if i > 1 else [], "commit": {"message": f"commit number {i}\n\nbody", "tree": {"sha": f"t{i}"}, "author": {"name": f"Dev {i % 4}", "email": "d@x", "date": f"2024-01-{(i % 28) + 1:02d}T10:00:00Z"}}})
            return route.fulfill(status=200, headers=hdrs(rem), body=json.dumps(items[:100]))
        if "/commits/" in path:
            i = int(path.split("/commits/")[1].split("?")[0], 16)
            files = [{"filename": f"src/mod{i % 7}/file{i}.ts", "status": "added", "additions": 20, "deletions": 0}]
            if i > 3:
                files.append({"filename": f"src/mod{(i - 3) % 7}/file{i - 3}.ts", "status": "modified", "additions": 3, "deletions": 1})
            return route.fulfill(status=200, headers=hdrs(rem), body=json.dumps({"sha": f"{i:040x}", "files": files}))
        return route.fulfill(status=404, headers=hdrs(rem), body=json.dumps({"message": "Not Found"}))

    ctx = browser.new_context(viewport={"width": 1280, "height": 820})
    ctx.route("https://api.github.com/**", handler)
    page = ctx.new_page()
    logs = []
    page.on("console", lambda m: logs.append((m.type, m.text)) if m.type in ("error",) else None)
    page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    page.goto(BASE, wait_until="networkidle")
    page.wait_for_selector(".gm-landing:not([hidden])")
    page.click(".gm-token-box summary")
    page.fill(".gm-landing .gm-tp-input", "ghp_FAKE_TOKEN_FOR_TEST")
    page.fill("#gm-repo", "https://github.com/acme/mold")
    page.click(".gm-go")
    wait_for(page, "() => window.__phloem.web.status && window.__phloem.web.status.state === 'rate-limited'", 60)
    st = page.evaluate("() => window.__phloem.web.status")
    check(st["state"] == "rate-limited" and 5 < st["delivered"] < 60, f"mock GitHub: rate limit hit mid-way with partial results ({st['delivered']} commits)")
    check(page.evaluate("() => window.__phloem.commits.length") == st["delivered"], "partial commits are in the visualization")
    check("resets at" in st["message"], "reset time is shown")
    page.evaluate("() => window.__phloem.play(true)")
    page.wait_for_timeout(2500)
    page.screenshot(path=f"{OUT}/08-github-rate-limited-partial.png")
    check(page.locator(".gm-status .gm-btn.is-primary").count() == 1, "resume button offered")
    # quota 'returns': resume
    state["limit_after"] = 10_000
    page.click(".gm-status .gm-btn.is-primary")
    wait_for(page, "() => window.__phloem.web.status && window.__phloem.web.status.state === 'done'", 60)
    n = page.evaluate("() => window.__phloem.commits.length")
    check(n == 60, f"resume completes the history ({n} of 60)")
    check("ghp_FAKE" not in " ".join(state["calls"]), "token never appears in a URL")
    page.wait_for_timeout(2000)
    page.screenshot(path=f"{OUT}/09-github-resumed-complete.png")
    check(not [l for l in logs if l[0] in ("error", "pageerror") and "403" not in l[1]], "no console errors (mock GitHub)")
    if logs:
        print("console (mock):", logs[:4])
    # 404
    page.click(".gm-new")
    page.wait_for_selector(".gm-landing:not([hidden])")
    page.fill("#gm-repo", "acme/missing")
    page.click(".gm-go")
    wait_for(page, "() => window.__phloem.web.status && window.__phloem.web.status.state === 'error'", 30)
    page.wait_for_selector(".gm-banner:not([hidden])")
    msg = page.locator(".gm-banner").inner_text()
    check("not found" in msg.lower() and "private" in msg.lower(), "404 gives a private-repo hint")
    page.screenshot(path=f"{OUT}/09b-github-404.png")
    # cancel (fresh context: no cached details from the run above; slowed-down API so there is something to cancel)
    page.context.close()
    ctx2 = browser.new_context(viewport={"width": 1280, "height": 820})
    ctx2.route("https://api.github.com/**", handler)
    page = ctx2.new_page()
    page.goto(BASE, wait_until="networkidle")
    state["limit_after"] = 10_000
    state["count"] = 0  # fresh quota
    state["delay"] = 0.25
    page.fill("#gm-repo", "acme/mold")
    page.click(".gm-go")
    page.wait_for_selector(".gm-status button:has-text('Cancel')")
    page.wait_for_function("() => window.__phloem.commits.length >= 3")
    page.screenshot(path=f"{OUT}/09c-github-progress.png")
    page.click(".gm-status button:has-text('Cancel')")
    wait_for(page, "() => window.__phloem.web.status && window.__phloem.web.status.state === 'cancelled'", 30)
    n = page.evaluate("() => window.__phloem.commits.length")
    check(3 <= n < 60, f"cancel keeps the commits fetched so far ({n}) and stops")
    calls = len(state["calls"])
    page.wait_for_timeout(1500)
    check(len(state["calls"]) <= calls + 1, "no further API requests after cancel")
    check(page.locator(".gm-status .gm-btn.is-primary").count() == 1, "resume offered after cancel")
    page.screenshot(path=f"{OUT}/09d-github-cancelled.png")
    ctx2.close()


main()
