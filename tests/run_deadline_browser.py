"""Run a deadline test page in Chromium and write its completed DOM to stdout."""

import sys

from playwright.sync_api import TimeoutError, sync_playwright


def main() -> None:
    executable, viewport, url = sys.argv[1:]
    width, height = map(int, viewport.split(","))
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=executable, headless=True)
        try:
            page = browser.new_page(viewport={"width": width, "height": height})
            page.on("pageerror", lambda error: print(error, file=sys.stderr))
            page.goto(url, wait_until="commit", timeout=15000)
            session = page.context.new_cdp_session(page)
            session.send("Emulation.setVirtualTimePolicy", {
                "policy": "pauseIfNetworkFetchesPending",
                "budget": 900000,
                "maxVirtualTimeTaskStarvationCount": 10000,
            })
            try:
                page.wait_for_selector("body:is([data-test-status=passed], [data-test-status=failed])",
                                       state="attached", timeout=120000)
            except TimeoutError:
                print("Test page did not set a terminal test status.", file=sys.stderr)
                raise
            finally:
                print(page.content())
        finally:
            browser.close()


if __name__ == "__main__":
    main()
