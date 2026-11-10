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
    assert page.locator("#wcv-course-info-card").count() == 0
    assert page.locator(".wcv-native-inline-legend .wcv-native-legend-pill").count() == 4

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

    # A combined room string and its component list must not appear twice.
    lab = page.locator("#schedule-table .wcv-native-course-card").filter(has_text="電気電子通信基礎実験").first
    room = lab.locator(".wcv-native-card-room").inner_text()
    assert room.count("PBL教室") == 1, room

    # Unrelated mutations must not duplicate cards.
    page.evaluate("document.body.appendChild(document.createElement('span'))")
    page.wait_for_timeout(400)
    assert page.locator("#schedule-table .wcv-native-course-card").count() == 12


def main() -> None:
    html = PREVIEW.read_text(encoding="utf-8")
    # A native WebClass child may carry a directly registered handler.
    # Verify restoration preserves the original object and that handler.
    probe = """<script>document.addEventListener('DOMContentLoaded', () => {
      const anchor = document.querySelector('#schedule-table a[href*=smaa030081]');
      window.__nativeProbe = document.createElement('span');
      window.__nativeProbe.id = 'native-listener-probe';
      window.__nativeProbe.addEventListener('wcv-test-event', () => window.__nativeProbeCalls++);
      window.__nativeProbeCalls = 0;
      anchor.appendChild(window.__nativeProbe);
    }, {once:true});</script>"""
    assert "<script>\nwindow.__WCV_DATASET__" in html
    html = html.replace("<script>\nwindow.__WCV_DATASET__", probe + "<script>\nwindow.__WCV_DATASET__", 1)
    assert not re.search(r"[?&](?:token|sid|session(?:_id)?)=", html, re.IGNORECASE)
    assert not re.search(r"\b[a-f0-9]{40}\b", html, re.IGNORECASE)
    assert not re.search(r"\b(?:student|user)[_-]?(?:id|number)\b|session-id", html, re.IGNORECASE)

    with sync_playwright() as playwright:
        browser = launch_browser(playwright)
        page = browser.new_page(viewport={"width": 1440, "height": 1800})
        load_snapshot(page, html)
        assert_initial_layout(page)

        # Switch the appearance without replacing the currently focused course link.
        timetable_link = page.locator("#schedule-table .wcv-native-course-card").first
        timetable_link.evaluate("el => { window.__focusedCourseLink = el; el.focus(); }")
        page.evaluate("chrome.storage.local.set({appearance:'modern'})")
        assert page.locator("html.wcv-look-modern").count() == 1
        assert timetable_link.evaluate("el => el === window.__focusedCourseLink && el === document.activeElement")
        assert timetable_link.evaluate("el => getComputedStyle(el).borderRadius") == "11px"
        sidebar_appearance = page.locator("#wcv-sidebar-appearance")
        assert sidebar_appearance.input_value() == "modern"
        sidebar_appearance.select_option("standard")
        assert page.locator("html.wcv-look-modern").count() == 0

        page.locator(".wcv-welcome-ok").click()
        page.wait_for_timeout(250)
        assert page.locator("#wcv-welcome-banner").count() == 0
        assert page.evaluate("chrome.storage.local._values.onboardingSeen") is True

        # Native HTML must be restorable and re-applicable.
        set_sidebar_setting(page, "modernizeNativeLayout", False)
        assert page.locator("#schedule-table .wcv-native-course-card").count() == 0
        assert "_smaa030081" in page.locator("#schedule-table a[href*='smaa030081']").first.inner_text()
        assert page.evaluate("document.getElementById('native-listener-probe') === window.__nativeProbe")
        page.evaluate("window.__nativeProbe.dispatchEvent(new Event('wcv-test-event'))")
        assert page.evaluate("window.__nativeProbeCalls") == 1

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
        assert 1 <= entries.count() <= 8
        entry_texts = [entries.nth(index).inner_text() for index in range(entries.count())]
        assert any("sba514202" in text and "同一講義コード" in text and "PDF目視確認済み・参考" in text and "鹿野 由利子" in text for text in entry_texts)
        assert any("sbz514204" in text and "同名・別コード（科目同一性は未判定）" in text and "岡澤 由季" in text for text in entry_texts)
        assert page.locator(".wcv-history-source[href*='page=43']").count() >= 2

        # Unreviewed historical rows are explicitly marked and remain source-linked.
        assert evidence.locator(".wcv-history-status").count() == entries.count()
        page.evaluate("""() => {
          const records = window.__WCV_HISTORY__.records;
          const source = records.find(row => row.courseCode === 'sba514202' && row.academicYear === 2024);
          for (let index = 0; index < 50; index += 1) {
            const duplicate = JSON.parse(JSON.stringify(source));
            duplicate.source = {...duplicate.source, id:`synthetic-${index}`};
            records.push(duplicate);
          }
          document.querySelector('#wcv-course-info-card').remove();
          document.body.appendChild(document.createElement('span'));
        }""")
        page.wait_for_selector("#wcv-course-info-card .wcv-history-expand", state="attached", timeout=10_000)
        page.locator("#wcv-course-info-card .wcv-course-card-toggle").click()
        page.wait_for_selector(".wcv-history-expand", state="visible", timeout=10_000)
        evidence = page.locator("#wcv-course-info-card .wcv-history-evidence")
        entries = evidence.locator(".wcv-history-record")
        assert evidence.locator(".wcv-history-expand").count() == 1
        before_expand = entries.count()
        evidence.locator(".wcv-history-expand").click()
        assert before_expand < entries.count() <= before_expand + 40
        if evidence.locator(".wcv-history-expand").count():
            assert "残り" in evidence.locator(".wcv-history-expand").inner_text()

        # Study guide navigation and historical filter buttons are rendered and interactive.
        guide_sec = page.locator("#wcv-course-info-card .wcv-study-guide-evidence")
        assert guide_sec.count() == 1
        assert guide_sec.locator(".wcv-guide-source[href*='#page=']").count() >= 2
        filter_btns = evidence.locator(".wcv-history-filter-btn")
        assert filter_btns.count() >= 3
        same_title_btn = evidence.locator(".wcv-history-filter-btn[data-filter='same-title']")
        if same_title_btn.count():
            same_title_btn.click()
            assert evidence.locator(".wcv-history-record").count() >= 1

        # 2026 correction events and 2026 fall PDF candidates are displayed with official PDF links.
        page.evaluate("""() => {
          const marker = document.getElementById('history-evidence-test-course');
          marker.dataset.courseName = '';
          marker.dataset.courseCode = 'sba155101';
          marker.textContent = 'sba155101';
          document.querySelector('#wcv-course-info-card')?.remove();
          document.body.appendChild(document.createElement('span'));
        }""")
        page.wait_for_selector("#wcv-course-info-card .wcv-course-correction-badge", state="attached", timeout=10_000)
        page.locator("#wcv-course-info-card .wcv-course-card-toggle").click()
        corr_sec = page.locator("#wcv-course-info-card .wcv-correction-evidence")
        assert corr_sec.count() == 1
        assert "未適用" in corr_sec.inner_text()
        assert corr_sec.locator(".wcv-correction-source[href*='https://www.asc.tcu.ac.jp/']").count() >= 1

        # Visually reviewed 2026 fall PDF evidence on sbz317604 (now in 3,736-course base snapshot) + provisional fallback on sba005101.
        page.evaluate("""() => {
          const marker = document.getElementById('history-evidence-test-course');
          marker.dataset.courseName = '';
          marker.dataset.courseCode = 'sbz317604';
          marker.textContent = 'sbz317604';
          document.querySelector('#wcv-course-info-card')?.remove();
          document.body.appendChild(document.createElement('span'));
        }""")
        page.wait_for_selector("#wcv-course-info-card .wcv-fall-evidence", state="attached", timeout=10_000)
        page.locator("#wcv-course-info-card .wcv-course-card-toggle").click()
        fall_sec = page.locator("#wcv-course-info-card .wcv-fall-evidence")
        assert fall_sec.count() == 1
        assert "PDF目視確認済み・参考" in fall_sec.inner_text()
        assert fall_sec.locator(".wcv-fall-source[href*='#page=']").count() >= 1

        page.evaluate("""() => {
          const marker = document.getElementById('history-evidence-test-course');
          marker.dataset.courseName = '';
          marker.dataset.courseCode = 'sba005101';
          marker.textContent = 'sba005101';
          document.querySelector('#wcv-course-info-card')?.remove();
          document.body.appendChild(document.createElement('span'));
        }""")
        page.wait_for_selector("#wcv-course-info-card .wcv-course-provisional-badge", state="attached", timeout=10_000)

        # Multi-offering courses pick up classrooms (教場) and teachers (担当先生) accurately from the database.
        page.evaluate("""() => {
          const marker = document.getElementById('history-evidence-test-course');
          marker.dataset.courseCode = '';
          marker.dataset.courseName = '░ 情報リテラシー演習(b)(火3、須藤、2026年度前期後半)';
          marker.textContent = '░ 情報リテラシー演習(b)(火3、須藤、2026年度前期後半)';
          document.querySelector('#wcv-course-info-card')?.remove();
          document.body.appendChild(document.createElement('span'));
        }""")
        page.wait_for_selector("#wcv-course-info-card", state="attached", timeout=10_000)
        card_text = page.locator("#wcv-course-info-card").inner_text()
        assert "須藤 康裕" in card_text, card_text
        assert "1号館2階・12L" in card_text, card_text
        assert "sab132309" in card_text, card_text
        page.locator("#wcv-course-info-card .wcv-course-card-toggle").click()
        multi_sec = page.locator("#wcv-course-info-card .wcv-multi-offering-evidence")
        assert multi_sec.count() == 1
        assert multi_sec.locator(".wcv-offering-row").count() >= 7
        assert "現在のクラス" in multi_sec.inner_text()

        # Title-only multi-offering lookup pairs each offering's classroom (教場) and teacher (担当先生).
        page.evaluate("""() => {
          const marker = document.getElementById('history-evidence-test-course');
          marker.dataset.courseCode = '';
          marker.dataset.courseName = '情報リテラシー演習(b)';
          marker.textContent = '情報リテラシー演習(b)';
          document.querySelector('#wcv-course-info-card')?.remove();
          document.body.appendChild(document.createElement('span'));
        }""")
        page.wait_for_selector("#wcv-course-info-card", state="attached", timeout=10_000)
        agg_text = page.locator("#wcv-course-info-card").inner_text()
        assert "複数開講" in agg_text, agg_text
        assert "1号館2階・12L（須藤 康裕）" in agg_text, agg_text

        # Floating panel cross-database search across snapshot, correction events, fall candidates, and historical rows.
        assert page.locator("#wcv-native-open-search").count() == 1
        assert page.locator("#wcv-course-info-card .wcv-more-tab-btn").count() >= 2
        page.locator("#wcv-launcher").click()
        page.wait_for_selector("#wcv-panel .wcv-panel-search-input", state="visible", timeout=10_000)
        page.locator("#wcv-panel .wcv-panel-quick-btn[data-mode='corrections']").click()
        assert page.locator("#wcv-panel .wcv-panel-layer-tag.is-correction").count() >= 5
        search_input = page.locator("#wcv-panel .wcv-panel-search-input")
        search_input.fill("sba155101")
        assert page.locator("#wcv-panel .wcv-panel-layer-tag.is-correction").count() >= 1
        search_input.fill("sbz317604")
        assert page.locator("#wcv-panel .wcv-panel-layer-tag.is-reviewed").count() >= 1

        browser.close()

    print("OK: live DOM / restore / metadata toggle / theme adaptation / source-backed historical title disambiguation / 2026 fall & correction & study-guide DB integration")


if __name__ == "__main__":
    main()
