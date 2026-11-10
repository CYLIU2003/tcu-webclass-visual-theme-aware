#!/usr/bin/env python3
"""Exercise real PDF-export fields through the extension's rendered course card."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
dataset = json.loads((ROOT / "data/timetable-2026.json").read_text(encoding="utf-8"))
payload = json.loads((ROOT / "data/historical-course-row-evidence.json").read_text(encoding="utf-8"))
payload["records"] = []
payload["currentFallCandidates"]["records"] = [r for r in payload["currentFallCandidates"]["records"] if r["courseCode"] in {"saa151309", "smbb000011"}]
payload["correctionEvents"]["records"] = [r for r in payload["correctionEvents"]["records"] if r["courseCode"] in {"smbb000011", "sba155304", "ymbb110022"}]
content = (ROOT / "src/content.js").read_text(encoding="utf-8")
mock = """window.chrome={storage:{local:{get(d,cb){cb({...d,onboardingSeen:true,showSidebarTools:false,showFloatingPanel:false})},set(v,cb){if(cb)cb()}},onChanged:{addListener(){}}},runtime:{getURL(p){return p},onMessage:{addListener(){}},lastError:null}};
window.fetch=async u=>({ok:true,status:200,json:async()=>String(u).includes('historical-course-row-evidence')?window.testPayload:window.testDataset});"""

with sync_playwright() as playwright:
    chrome = Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google/Chrome/Application/chrome.exe"
    browser = playwright.chromium.launch(headless=True, **({"executable_path": str(chrome)} if chrome.exists() else {}))

    def show(name, code, *, open_details=True):
        page = browser.new_page()
        page.set_content(f'<html><head><title>Course</title></head><body><main><h1 data-course-name="{name}" data-course-code="{code}">{name}</h1></main></body></html>')
        page.evaluate("([d,p])=>{window.testDataset=d;window.testPayload=p}", [dataset, payload])
        page.add_script_tag(content=mock)
        page.add_script_tag(content=content)
        page.wait_for_function("document.documentElement.dataset.wcvReady === 'true'", timeout=30000)
        if open_details:
            page.locator("#wcv-course-info-card .wcv-course-card-toggle").click()
        return page

    fall = show("物理化学(3)", "saa151309")
    assert "saa151309" in fall.locator("#wcv-course-info-card").text_content()
    assert fall.locator("#wcv-course-info-card a[href*='page=15']").count() > 0
    evidence = fall.locator("#wcv-course-info-card .wcv-fall-evidence").text_content()
    assert "未確認" in evidence and "現在の時間割データに収録" in evidence
    assert "世田谷キャンパス・学部" in evidence
    assert "11B" in fall.locator("#wcv-course-info-card .wcv-room-row").text_content()
    assert "所属から2026年度の資料を選ぶ" in fall.locator("#wcv-course-info-card .wcv-study-guide-evidence").text_content()
    fall.close()

    correction = show("偏微分方程式特論", "smbb000011")
    assert "未適用" in correction.locator("#wcv-course-info-card").text_content()
    assert correction.locator("#wcv-course-info-card a[href*='7d1654a86fec3147e07d63b0039f7c3e-1.pdf'][href*='page=1']").count() > 0
    correction.close()
    instructor = show("応用化学実験基礎(2a)", "sba155304")
    assert instructor.locator(".wcv-correction-chip").all_text_contents() == ["担当教員変更候補"]
    assert "講師を削除" in instructor.locator(".wcv-correction-excerpt").text_content()
    instructor.close()
    language = show("環境リスク社会論(英語)", "ymbb110022")
    assert language.locator(".wcv-correction-chip").all_text_contents() == ["開講言語変更候補"]
    assert "2026-09-17" in language.locator(".wcv-correction-date").text_content()
    language.close()
    unknown = show("惑星科学特論", "szz999999", open_details=False)
    assert unknown.locator("#wcv-course-info-card").count() == 0, "an explicit unknown code must not match a different course by title"
    unknown.close()
    browser.close()

print("PASS: current PDF candidate and correction page links use real exported records")
