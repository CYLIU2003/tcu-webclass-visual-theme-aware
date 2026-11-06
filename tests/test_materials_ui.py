#!/usr/bin/env python3
"""Check material links and wrapping at narrow and desktop widths."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import os

ROOT = Path(__file__).resolve().parents[1]
html = (ROOT / "tests/fixtures/materials-ui.html").read_text(encoding="utf-8")
css = (ROOT / "src/content.css").read_text(encoding="utf-8")
html = html.replace("</head>", f"<style>{css}</style></head>")

with sync_playwright() as playwright:
    chrome = Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google/Chrome/Application/chrome.exe"
    browser = playwright.chromium.launch(headless=True, **({"executable_path": str(chrome)} if chrome.exists() else {}))
    for width in (320, 375, 768, 1440):
        page = browser.new_page(viewport={"width": width, "height": 900})
        page.set_content(html)
        assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth"), width
        assert page.locator(".cm-contentsList_contentName a").count() == 3
        assert page.locator(".cl-contentsList_contentDetailListItem a").count() == 4
        assert "underline" in page.locator(".cm-contentsList_contentName a").first.evaluate("e => getComputedStyle(e).textDecorationLine")
        assert page.locator(".cl-contentsList_contentDetailListItem a").first.bounding_box()["height"] >= 40
        page.keyboard.press("Tab")
        assert page.locator(":focus-visible").count() == 1
        assert page.locator(":focus-visible").evaluate("e => getComputedStyle(e).outlineStyle") != "none"
        page.close()
    browser.close()

print("PASS: materials layout, link affordance, focus and narrow widths")
