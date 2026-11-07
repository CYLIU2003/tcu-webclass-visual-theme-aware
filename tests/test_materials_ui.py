#!/usr/bin/env python3
"""Check material links and wrapping at narrow and desktop widths."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import os

ROOT = Path(__file__).resolve().parents[1]
html = (ROOT / "tests/fixtures/materials-ui.html").read_text(encoding="utf-8")
real_html = (ROOT / "tests/fixtures/materials-real-structure.html").read_text(encoding="utf-8")
css = (ROOT / "src/content.css").read_text(encoding="utf-8")
html = html.replace("</head>", f"<style>{css}</style></head>")
real_html = real_html.replace("</head>", f"<style>{css}</style></head>")

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
        # Real WebClass uses cm- prefixes and native table cells for controls.
        page = browser.new_page(viewport={"width": width, "height": 900})
        page.set_content(real_html)
        assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth"), width
        assert page.locator(".cm-contentsList_content").evaluate("e => getComputedStyle(e).display") == "table"
        assert page.locator(".cm-contentsList_contentBodyContainer").evaluate("e => getComputedStyle(e).flexWrap") == "wrap"
        assert page.locator(".cm-contentsList_contentName a").is_visible()
        assert page.locator(".cm-contentsList_contentKind > span").evaluate("e => getComputedStyle(e).display") == "inline-block"
        page.keyboard.press("Tab")
        assert page.locator(":focus-visible").count() == 1
        assert page.locator(":focus-visible").evaluate("e => getComputedStyle(e).outlineStyle") != "none"
        page.get_by_label("教材を選択").check()
        assert page.get_by_label("教材を選択").is_checked()
        assert page.get_by_label("教材を選択").evaluate("e => e.getBoundingClientRect().width") >= 18
        assert page.get_by_role("button", name="教材の操作").is_visible()
        assert page.get_by_role("button", name="教材の操作").evaluate("e => e.getBoundingClientRect().height") >= 36
        page.get_by_text("詳細を確認").click()
        assert page.evaluate("location.hash") == "#detail"
        page.close()
    browser.close()

print("PASS: materials layout, link affordance, focus and narrow widths")
