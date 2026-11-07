"""The bundled guide must show its real screenshots even when opened from disk."""
from pathlib import Path
import os
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
chrome = Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google/Chrome/Application/chrome.exe"
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, **({"executable_path": str(chrome)} if chrome.exists() else {}))
    for guide in ("はじめにお読みください.html", "src/welcome.html"):
        for width in (375, 1440):
            page = browser.new_page(viewport={"width": width, "height": 900})
            page.goto((root / guide).as_uri(), wait_until="load")
            assert page.locator(".capture img").count() == 2
            assert page.locator(".capture img").evaluate_all("imgs => imgs.every(i => i.complete && i.naturalWidth > 0)")
            assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth"), (guide, width)
            assert page.get_by_text("Windows：Ctrl + R または F5").count() >= 1
            page.close()
    browser.close()
print("PASS: guide screenshots load from disk and fit narrow and desktop widths")
