"""Exercise curriculum candidates in the sanitized, offline WebClass preview."""
from pathlib import Path
import os
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
html = (root / "demo/preview-live-dom-standalone.html").read_text(encoding="utf-8")
with sync_playwright() as p:
    chrome = Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google/Chrome/Application/chrome.exe"
    browser = p.chromium.launch(headless=True, **({"executable_path": str(chrome)} if chrome.exists() else {}))
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.set_content(html, wait_until="load", timeout=120_000)
    page.wait_for_function("document.documentElement.dataset.wcvReady === 'true'", timeout=120_000)
    assert page.locator(".wcv-curriculum-candidate").count() == 0
    page.evaluate("""() => chrome.storage.local.set({
      curriculumPlan:'2026-information-science',
      userCourses:[{courseName:'プログラミング(1)', courseCode:'smaa030081'}]
    })""")
    candidate = page.locator("#schedule-table a[href*='smaa030081'] .wcv-curriculum-candidate").first
    candidate.wait_for(timeout=15_000)
    assert "学科の同名資料・要確認" in candidate.inner_text()
    page.evaluate("""() => {
      const marker = document.createElement('div');
      marker.id = 'curriculum-test-marker';
      marker.dataset.courseName = 'プログラミング(1)';
      marker.dataset.courseCode = 'smaa030081';
      marker.textContent = 'プログラミング(1)';
      document.body.prepend(marker);
    }""")
    page.locator("#wcv-course-info-card").wait_for(state="attached", timeout=15_000)
    page.locator(".wcv-course-card-toggle").click()
    source = page.locator(".wcv-curriculum-detail a")
    assert "資料上は必修" in page.locator(".wcv-curriculum-detail").inner_text()
    assert "この開講科目との対応は未確認" in page.locator(".wcv-curriculum-detail").inner_text()
    assert source.count() == 1
    assert source.get_attribute("href").endswith("#page=5")
    assert "noopener" in source.get_attribute("rel")
    page.evaluate("""() => {
      const marker = document.querySelector('#curriculum-test-marker');
      marker.dataset.courseName = '数学演習(1a)';
      marker.textContent = '数学演習(1a)';
      chrome.storage.local.set({userCourses:[{courseName:'数学演習(1a)', courseCode:'smaa030081'}]});
    }""")
    page.wait_for_function("document.querySelector('#wcv-course-info-card .wcv-course-card-title')?.textContent === '数学演習(1a)'", timeout=15_000)
    page.locator(".wcv-course-card-toggle").click()
    choice_links = page.locator(".wcv-curriculum-detail a")
    assert choice_links.count() == 2
    assert choice_links.nth(0).get_attribute("href").endswith("#page=4")
    assert choice_links.nth(1).get_attribute("href").endswith("#page=7")
    page.evaluate("() => chrome.storage.local.set({curriculumPlan:''})")
    candidate.wait_for(state="detached", timeout=15_000)
    browser.close()
print("PASS: profile changes update candidate badges and leave the default unclassified")
