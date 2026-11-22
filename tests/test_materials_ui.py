#!/usr/bin/env python3
"""Check material links and wrapping at narrow and desktop widths."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import os

ROOT = Path(__file__).resolve().parents[1]
html = (ROOT / "tests/fixtures/materials-ui.html").read_text(encoding="utf-8")
real_html = (ROOT / "tests/fixtures/materials-real-structure.html").read_text(encoding="utf-8")
real_html = real_html.replace(
    '<h4 class="cm-contentsList_contentName">',
    '<h4 class="cm-contentsList_contentName"><img width="10" height="10" alt="">',
)
# Course pages can retain Bootstrap's white navbar, including when native layout
# enhancements are disabled. Exercise that structure rather than a pre-styled bar.
real_html = real_html.replace('<body class="wcv-restyle">', '''<body class="wcv-restyle">
<header><nav class="navbar navbar-default" style="background-color:white;color:white">
  <div class="navbar-brand"><a class="course-webclass" href="#home">WebClass</a>
    <a class="course-name" href="#course">教科名</a></div>
  <p class="navbar-text">受講中</p>
  <button class="navbar-toggle"><span class="icon-bar"></span>メニュー</button>
  <ul class="navbar-nav"><li class="active"><a href="#materials">教材</a></li>
    <li class="open"><a href="#grades">成績</a>
      <ul class="dropdown-menu"><li><a href="#results">結果</a></li></ul></li></ul>
</nav></header>''')


def assert_navbar_contrast(page):
    """Check effective contrast, including translucent active/hover backgrounds."""
    ratios = page.locator('header .navbar a, header .navbar-text, header .navbar-toggle').evaluate_all("""nodes => {
      const rgb = value => value.match(/[\\d.]+/g).map(Number);
      const luminance = color => color.slice(0, 3).map(value => {
        value /= 255;
        return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
      }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
      return nodes.map(node => {
        const layers = [];
        for (let current = node; current; current = current.parentElement)
          layers.unshift(rgb(getComputedStyle(current).backgroundColor));
        let background = [255, 255, 255];
        for (const layer of layers) {
          const alpha = layer[3] ?? 1;
          background = background.map((value, i) => layer[i] * alpha + value * (1 - alpha));
        }
        const fg = luminance(rgb(getComputedStyle(node).color));
        const bg = luminance(background);
        return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
      });
    }""")
    assert ratios and min(ratios) >= 4.5, ratios


css = (ROOT / "src/content.css").read_text(encoding="utf-8")
content_script = (ROOT / "src/content.js").read_text(encoding="utf-8")
mock_storage = """() => {
    const listeners = [];
    const values = {};
    window.chrome = {
        runtime: {getURL: path => path, onMessage: {addListener() {}}},
        storage: {
            local: {
                get: (defaults, callback) => callback({...defaults, ...values}),
                set: (update) => {
                    Object.assign(values, update);
                    const changes = Object.fromEntries(Object.entries(update).map(([key, newValue]) => [key, {newValue}]));
                    listeners.forEach(listener => listener(changes, 'local'));
                }
            },
            onChanged: {addListener: listener => listeners.push(listener)}
        }
    };
    window.fetch = async () => ({ok: true, json: async () => ({courses: [], records: [], schemaVersion: 2})});
}"""
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
        participant_row = page.locator(".cl-contentsList_listGroupItem").first
        standard_participant_height = participant_row.bounding_box()["height"]
        page.evaluate("document.documentElement.classList.add('wcv-look-modern')")
        if width >= 768:
            assert participant_row.bounding_box()["height"] < standard_participant_height, width
        assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth"), width
        assert page.locator(".cl-contentsList_contentDetailListItem a").first.bounding_box()["height"] >= 40
        page.close()
        # Real WebClass uses cm- prefixes and native table cells for controls.
        page = browser.new_page(viewport={"width": width, "height": 900})
        page.set_content(real_html)
        assert_navbar_contrast(page)
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

        # Switching appearance must preserve the original WebClass controls and focus.
        page.evaluate(mock_storage)
        page.add_script_tag(content=content_script)
        page.wait_for_selector("html[data-wcv-ready=true]", state="attached")
        for layout in (False, True):
            page.evaluate("value => chrome.storage.local.set({modernizeNativeLayout:value})", layout)
            assert_navbar_contrast(page)
            # Other course tabs do not contain the materials list.
            page.locator('.cm-contentsList').evaluate("e => e.classList.replace('cm-contentsList', 'other-course-tab')")
            assert_navbar_contrast(page)
            page.locator('.other-course-tab').evaluate("e => e.classList.replace('other-course-tab', 'cm-contentsList')")
        nav_link = page.locator('header .navbar-nav > li > a').first
        nav_link.hover()
        assert_navbar_contrast(page)
        nav_link.focus()
        assert_navbar_contrast(page)
        assert page.locator("html.wcv-look-modern").count() == 0
        row = page.locator(".cm-contentsList_listGroupItem")
        standard_row_height = row.bounding_box()["height"]
        option = page.get_by_role("button", name="教材の操作")
        option.focus()
        page.evaluate("chrome.storage.local.set({appearance:'modern'})")
        assert page.locator("html.wcv-look-modern").count() == 1
        assert_navbar_contrast(page)
        assert option.evaluate("e => e === document.activeElement")
        assert page.get_by_label("教材を選択").is_checked()
        assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth"), width
        assert page.locator(".cm-contentsList_content").evaluate("e => getComputedStyle(e).display") == "table"
        assert row.evaluate("e => getComputedStyle(e).borderRadius") == "11px"
        assert page.locator(".cm-contentsList_contentName > img").evaluate("e => getComputedStyle(e).display") == "inline-block"
        if width >= 768:
            assert row.bounding_box()["height"] < standard_row_height
        page.get_by_text("詳細を確認").click()
        assert page.evaluate("location.hash") == "#detail"
        page.evaluate("chrome.storage.local.set({appearance:'standard'})")
        assert page.locator("html.wcv-look-modern").count() == 0
        assert page.get_by_label("教材を選択").is_checked()
        page.evaluate("chrome.storage.local.set({appearance:'modern', restyle:false})")
        assert page.locator("html.wcv-look-modern").count() == 0
        page.evaluate("chrome.storage.local.set({restyle:true})")
        page.wait_for_selector("html.wcv-look-modern", state="attached")
        page.evaluate("chrome.storage.local.set({enabled:false})")
        page.wait_for_selector("html.wcv-look-modern", state="detached")
        page.close()
    browser.close()

print("PASS: materials layout, link affordance, focus and narrow widths")
