#!/usr/bin/env python3
"""Integration smoke test for the sanitized WebClass DOM snapshot.

Requires:
    pip install playwright
and a Chromium executable available to Playwright or /usr/bin/chromium.
"""
from __future__ import annotations

import shutil
import os
import re
from pathlib import Path

from playwright.sync_api import Browser, Page, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PREVIEW = ROOT / "demo" / "preview-live-dom-standalone.html"


def launch_browser(playwright) -> Browser:
    executable = shutil.which("chromium") or shutil.which("google-chrome")
    if not executable and os.name == "nt":
        candidates = [
            Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
            Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google" / "Chrome" / "Application" / "chrome.exe",
        ]
        executable = next((str(path) for path in candidates if path.is_file()), None)
    kwargs = {"headless": True}
    if executable:
        kwargs["executable_path"] = executable
        if os.name != "nt":
            kwargs["args"] = ["--no-sandbox"]
    return playwright.chromium.launch(**kwargs)


def load_snapshot(page: Page, html: str) -> None:
    page.set_content(html, wait_until="load", timeout=120_000)
    page.wait_for_function(
        "document.documentElement.dataset.wcvReady === 'true'",
        timeout=120_000,
    )
    page.wait_for_timeout(350)


def set_sidebar_setting(page: Page, key: str, value: bool) -> None:
    page.locator(f"#wcv-sidebar-tools input[data-setting='{key}']").evaluate(
        "(input, value) => { input.checked = value; input.dispatchEvent(new Event('change', {bubbles: true})); }",
        value,
    )
    page.wait_for_timeout(450)


def assert_initial_layout(page: Page) -> None:
    assert page.locator("#schedule-table").count() == 1
    assert page.locator("#schedule-table .wcv-native-course-card").count() == 12
    assert page.locator("#wcv-sidebar-tools").count() == 1
    assert page.locator("#wcv-enhanced-timetable").count() == 0

    welcome = page.locator("#wcv-welcome-banner")
    assert welcome.count() == 1
    welcome_layout = welcome.evaluate("""element => {
      const banner = element.getBoundingClientRect();
      const table = document.querySelector('#schedule-table').getBoundingClientRect();
      return {
        position: getComputedStyle(element).position,
        parent: element.parentElement.classList.contains('wcv-native-content'),
        endsBeforeTable: banner.bottom <= table.top
      };
    }""")
    assert welcome_layout == {"position": "relative", "parent": True, "endsBeforeTable": True}, welcome_layout

    checks = {
        "smaa030081": ["パワーエレクトロニクス特論", "1号館2階・12K", "鈴木 憲吏", "新着 2"],
        "smab030101": ["電力システム工学特論", "1号館2階・12J", "中島 達人"],
        "smaz090041": ["情報理論特論", "1号館2階・12A", "新家 稔央"],
    }
    for code, expected_values in checks.items():
        text = page.locator(f"#schedule-table a[href*='{code}']").first.inner_text()
        for expected in expected_values:
            assert expected in text, (code, expected, text)

    # Unrelated mutations must not duplicate cards.
    page.evaluate("document.body.appendChild(document.createElement('span'))")
    page.wait_for_timeout(400)
    assert page.locator("#schedule-table .wcv-native-course-card").count() == 12


def main() -> None:
    html = PREVIEW.read_text(encoding="utf-8")
    assert not re.search(r"[?&](?:token|sid|session(?:_id)?)=", html, re.IGNORECASE)
    assert not re.search(r"\b[a-f0-9]{40}\b", html, re.IGNORECASE)
    assert not re.search(r"\b(?:student|user)[_-]?(?:id|number)\b|session-id", html, re.IGNORECASE)

    with sync_playwright() as playwright:
        browser = launch_browser(playwright)
        page = browser.new_page(viewport={"width": 1440, "height": 1800})
        load_snapshot(page, html)
        assert_initial_layout(page)

        page.locator(".wcv-welcome-ok").click()
        page.wait_for_timeout(250)
        assert page.locator("#wcv-welcome-banner").count() == 0
        assert page.evaluate("chrome.storage.local._values.onboardingSeen") is True

        # Native HTML must be restorable and re-applicable.
        set_sidebar_setting(page, "modernizeNativeLayout", False)
        assert page.locator("#schedule-table .wcv-native-course-card").count() == 0
        assert "_smaa030081" in page.locator("#schedule-table a[href*='smaa030081']").first.inner_text()

        # Re-enable via storage to avoid the sidebar being absent while disabled.
        page.evaluate("chrome.storage.local.set({modernizeNativeLayout: true})")
        page.wait_for_timeout(500)
        assert page.locator("#schedule-table .wcv-native-course-card").count() == 12

        # Inline metadata can be removed independently.
        assert page.locator(".wcv-inline-meta").count() > 0
        set_sidebar_setting(page, "showInlineMetadata", False)
        assert page.locator(".wcv-inline-meta").count() == 0
        page.evaluate("chrome.storage.local.set({showInlineMetadata: true})")
        page.wait_for_timeout(500)
        assert page.locator(".wcv-inline-meta").count() > 0

        # The header color should become the extension accent color.
        theme = page.evaluate(
            "getComputedStyle(document.documentElement).getPropertyValue('--wcv-theme').trim()"
        )
        assert theme in {"rgb(114, 0, 113)", "rgb(112, 0, 112)", "#720071", "#700070"}

        # Repeat with alternate native WebClass themes.
        for replacement, expected in [("#005aa0", "rgb(0, 90, 160)"), ("#227a50", "rgb(34, 122, 80)")]:
            themed = html.replace("background:#720071", f"background:{replacement}", 1)
            themed_page = browser.new_page(viewport={"width": 1280, "height": 900})
            load_snapshot(themed_page, themed)
            actual = themed_page.evaluate(
                "getComputedStyle(document.documentElement).getPropertyValue('--wcv-theme').trim()"
            )
            assert actual == expected, (replacement, expected, actual)
            themed_page.close()

        # Same printed title remains separate by course code and teacher in the database-linked history.
        page.evaluate("""() => {
          chrome.storage.local.set({userCourses:[{
            courseName:'マーケティングリサーチ演習(2)',
            courseCode:'sba514202',
            instructors:['テスト担当']
          }]});
          const marker=document.createElement('div');
          marker.id='history-evidence-test-course';
          marker.dataset.courseName='マーケティングリサーチ演習(2)';
          marker.dataset.courseCode='sba514202';
          marker.textContent='マーケティングリサーチ演習(2)';
          document.body.prepend(marker);
        }""")
        page.wait_for_selector("#wcv-course-info-card", state="attached", timeout=10_000)
        page.locator(".wcv-course-card-toggle").click()
        evidence = page.locator("#wcv-course-info-card .wcv-history-evidence")
        assert evidence.count() == 1
        entries = evidence.locator(".wcv-history-record")
        assert entries.count() == 2
        entry_texts = [entries.nth(index).inner_text() for index in range(entries.count())]
        assert any("sba514202" in text and "同じ講義コード" in text and "鹿野 由利子" in text for text in entry_texts)
        assert any("sbz514204" in text and "同名・別コード（同一科目か未判定）" in text and "岡澤 由季" in text for text in entry_texts)
        assert page.locator(".wcv-history-source[href*='page=43']").count() == 2

        browser.close()

    print("OK: live DOM / restore / metadata toggle / theme adaptation / source-backed historical title disambiguation")


if __name__ == "__main__":
    main()
