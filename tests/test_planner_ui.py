"""Check planner search, separate offerings, quarter conflicts and local storage."""
import os
import re
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]

with TemporaryDirectory() as profile, sync_playwright() as playwright:
    context = playwright.chromium.launch_persistent_context(
        profile,
        executable_path=os.environ.get("WCV_CHROME_FOR_TESTING"),
        args=[f"--disable-extensions-except={ROOT}", f"--load-extension={ROOT}"],
    )
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
        extension = worker.url.rsplit("/src/", 1)[0]
        popup = context.new_page()
        popup.goto(f"{extension}/src/popup.html")
        expect(popup.locator("#statusCard")).to_have_attribute("data-kind", "idle")
        with context.expect_page(predicate=lambda opened: not opened.url.endswith("/src/welcome.html")) as opening:
            popup.get_by_role("button", name="時間割プランナーを開く").click()
        page = opening.value
        page.wait_for_url("**/src/planner.html")
        for destination, target in [
            ("credits", "credits-title"),
            ("requirements", "requirements-title"),
            ("graduate", "graduate-title"),
            ("programs", "programs-title"),
            ("tasks", "planner-tasks-title"),
        ]:
            menu = context.new_page()
            menu.goto(f"{extension}/src/popup.html")
            menu.set_viewport_size({"width": 320, "height": 650})
            shortcut = menu.locator(f'[data-planner-section="{destination}"]')
            shortcut.focus()
            with context.expect_page() as direct:
                shortcut.press("Enter")
            direct.value.wait_for_url(f"**/src/planner.html#{target}")
            expect(direct.value.locator(f"#{target}")).to_be_focused()
            expect(direct.value.locator(f'.planner-nav [href="#{target}"]')).to_have_attribute("aria-current", "location")
            expect(direct.value.locator(f"#{target}")).to_be_in_viewport()
            if destination == "programs":
                programs = direct.value
                programs.set_viewport_size({"width": 360, "height": 800})
                form = programs.locator("#program-profile-form")
                form.locator("[name=cohort]").select_option("2026:情報科学科")
                for flag in ("hirameki", "teaching", "tap"):
                    form.locator(f"[name={flag}]").select_option("yes")
                expect(programs.locator("#program-resources li")).to_have_count(3)
                programs.get_by_text("読み替え対象の国内科目を見る").click()
                expect(programs.locator("#program-resources details p")).to_contain_text("Communication Skills(1)")
                form.get_by_role("button", name="参加状況を保存").click()
                expect(programs.locator("#program-profile-status")).to_contain_text("保存しました")
                programs.reload()
                expect(form.locator("[name=tap]")).to_have_value("yes")
                assert programs.evaluate("document.documentElement.scrollWidth === innerWidth")
            if destination == "graduate":
                graduate = direct.value
                graduate.set_viewport_size({"width": 360, "height": 800})
                graduate.locator("#graduate-year").select_option("2026")
                graduate.locator("#graduate-school").select_option("情報データ科学研究科")
                graduate.locator("#graduate-major").select_option("情報データ科学専攻")
                graduate.locator("#graduate-program").select_option("博士前期課程")
                expect(graduate.locator("#graduate-result")).to_contain_text("30単位")
                graduate.locator("#graduate-earned").fill("22")
                graduate.locator("#graduate-planned").fill("2.5")
                expect(graduate.locator("#graduate-result")).to_contain_text("見込みを含めて残り 5.5単位")
                graduate.locator("#graduate-program").select_option("博士後期課程")
                expect(graduate.locator("#graduate-result")).to_contain_text("24単位")
                expect(graduate.locator("#graduate-earned")).to_have_value("")
                graduate.locator("#graduate-year").select_option("2024")
                expect(graduate.locator("#graduate-school option")).to_have_count(3)
                graduate.locator("#graduate-school").select_option("環境情報学研究科")
                graduate.locator("#graduate-major").select_option(label="東京都市大学・エディスコーワン大学 国際連携環境融合科学専攻")
                expect(graduate.locator("#graduate-program option")).to_have_count(2)
                expect(graduate.locator("#graduate-result")).to_contain_text("東京都市大学を主大学とする場合")
                evidence = graduate.get_by_role("link", name="博士前期課程の総単位の根拠")
                expect(evidence).to_have_attribute("href", re.compile(r"^https://www.asc.tcu.ac.jp/.*#page=63$"))
                assert graduate.evaluate("document.documentElement.scrollWidth === innerWidth")
            direct.value.close()
        page.locator("#course-level").select_option("大学院")
        page.locator("#query").fill("smaa000031")
        expect(page.locator("#results")).to_contain_text("解析幾何学特論")
        page.locator("#course-level").select_option("学部")
        expect(page.locator("#search-status")).to_contain_text("該当する授業がありません")
        page.locator("#course-level").select_option("")
        page.locator("#query").fill("")
        existing = context.new_page()
        schedule = """<!doctype html><meta charset="utf-8"><title>WebClass</title>
        <main id="js-main"><div class="container"><div class="row"><aside class="col-sm-3"></aside>
        <div class="col-sm-9"><h3 class="page-header">参加しているコース</h3><form name="condition">
        <select name="year"><option value="2026">2026</option></select>
        <select name="semester"><option value="all">All</option></select>
        <table id="schedule-table"><tr><td>1限</td><td><a href="/webclass/course.php/26saa001102/login?acs_=DEMO">ドイツ語</a></td>
        <td><a href="/webclass/course.php/26saa001202/login">ドイツ語</a></td></tr></table>
        <div class="schedule-list"><a href="/webclass/course.php/26saa001102/login">ドイツ語</a>
        <a href="/webclass/course.php/g123456/login">コード未登録のコース</a>
        <a href="/webclass/course.php/g111111/login">情報リテラシー演習（ｂ）（火3、須藤 康裕、2026年度前期後半）</a>
        <a href="/webclass/course.php/26saz115101/login">Communication Skills(1)</a>
        <a href="/webclass/course.php/g222222/login">情報リテラシー演習(b)</a></div>
        </form></div></div></div></main>"""
        existing.route("https://webclass.tcu.ac.jp/**", lambda route: route.fulfill(
            status=200, content_type="text/html", body=schedule
        ))
        existing.goto("https://webclass.tcu.ac.jp/webclass/")
        menu = context.new_page()
        menu.goto(f"{extension}/src/popup.html")
        with menu.expect_event("close"):
            menu.get_by_role("button", name="WebClassを開く").click()
        assert worker.evaluate("""async () => {
            const tabs = await chrome.tabs.query({url:'https://webclass.tcu.ac.jp/*'});
            return tabs.length === 1 && tabs[0].active;
        }""")
        expect(existing.locator(".wcv-enrollment-summary")).to_contain_text("授業データと一致 4件")
        expect(existing.locator(".wcv-enrollment-summary")).to_contain_text("要確認 2件")
        direct = context.new_page()
        direct.goto(f"{extension}/src/planner.html?enrollment=invalid#enrollment-title")
        expect(direct.locator("#enrollment-status")).to_contain_text("読み込み先が無効")
        direct.goto(f"{extension}/src/planner.html#enrollment-title")
        expect(direct.locator("#enrollment-courses li")).to_have_count(6)
        direct.close()
        worker.evaluate("""chrome.storage.local.set({
            'planner-credit:course:planner:2026:saa001102': {status:'planned',units:275}
        })""")
        with context.expect_page() as enrollment_opening:
            existing.get_by_role("button", name="履修・進級チェック").click()
        enrollment = enrollment_opening.value
        enrollment.wait_for_url(re.compile(r"/src/planner\.html\?enrollment=[a-f0-9-]+#enrollment-title$"))
        expect(enrollment.locator("#enrollment-status")).to_contain_text("参加コース 6件 ／ 科目の照合 4件（うち手動選択 0件） ／ 科目の要確認 2件")
        expect(enrollment.locator("#enrollment-courses li")).to_have_count(6)
        tap_link = enrollment.get_by_role("link", name="TAPの単位読み替え候補")
        expect(tap_link).to_have_count(1)
        worker.evaluate("""async () => {
            const {undergraduatePrograms} = await chrome.storage.local.get('undergraduatePrograms');
            await chrome.storage.local.set({undergraduatePrograms:{...undergraduatePrograms,tap:'no'}});
        }""")
        expect(tap_link).to_have_count(0)
        expect(enrollment.locator("#enrollment-courses")).to_contain_text("講義コードを照合できません")
        enrollment.get_by_role("button", name="最初の要確認科目へ").click()
        expect(enrollment.locator('[data-needs-review="true"]').first).to_be_focused()
        chosen = enrollment.locator("#enrollment-courses li").last
        expect(chosen).to_contain_text("授業名が一致する候補")
        expect(chosen.locator("select")).to_have_value("")
        chosen.locator("select").select_option("sab132309")
        expect(chosen.locator("select")).to_have_value("")
        chosen.locator("select").select_option("sab175303")
        expect(chosen).to_contain_text("候補を選択済み")
        expect(enrollment.locator("#enrollment-status")).to_contain_text("手動選択 1件")
        expect(enrollment.locator("#enrollment-status")).to_contain_text("要確認 1件")
        chosen.locator("input").fill("3")
        expect(enrollment.locator("#enrollment-result")).to_contain_text("入力済みの見込み 3単位")
        chosen.locator("select").select_option("")
        expect(enrollment.locator("#enrollment-status")).to_contain_text("要確認 2件")
        expect(enrollment.locator("#enrollment-result")).to_contain_text("入力済みの見込み 0単位")
        expect(chosen.locator("input")).to_have_value("")
        chosen.locator("select").select_option("sab175303")
        first_row = enrollment.locator("#enrollment-courses li").first
        expect(first_row.get_by_role("link", name="公式シラバス 1単位")).to_be_visible()
        expect(first_row.locator("input")).to_have_value("")
        first_row.get_by_role("button", name="見込み単位に入れる").click()
        expect(first_row.locator("input")).to_have_value("1")
        assert "DEMO" not in enrollment.url
        first_row.get_by_role("button", name="保存した予定 2.75単位を見込みに入れる").click()
        expect(enrollment.locator("#enrollment-result")).to_contain_text("入力済みの見込み 2.75単位")
        enrollment.locator("#enrollment-profile").select_option("2026:情報科学科")
        enrollment.locator("#enrollment-earned").fill("57")
        enrollment.locator("#enrollment-courses input").first.fill("2")
        expect(enrollment.locator("#enrollment-result")).to_contain_text("59単位（総単位まで残り 1単位）")
        expect(enrollment.locator("#enrollment-result")).to_contain_text("未入力 5件")
        enrollment.locator("#enrollment-stage").select_option("4")
        expect(enrollment.locator("#enrollment-result")).to_contain_text("進級条件の総単位 100単位")
        enrollment.evaluate("chrome.permissions.request = async () => false")
        enrollment.get_by_role("button", name="公式シラバスで単位を照合").click()
        expect(enrollment.locator("#enrollment-lookup-status")).to_contain_text("許可がありません")

        def public_syllabus(route):
            assert route.request.method == "GET"
            assert not route.request.header_value("cookie")
            params = parse_qs(urlsplit(route.request.url).query)
            code = params["value(kougicd)"][0]
            semester = params["value(semekikn)"][0]
            assert set(params) == {"value(kougicd)", "value(semekikn)", "value(risyunen)"}
            assert code in {"sab132309", "sab175303", "saz115101"}
            body_year = "2026" if code == "sab175303" else "2025"
            cells = "".join(f'<tr><td class="label_kougi">{label}</td><td class="kougi">{value}</td></tr>'
                            for label, value in {
                                "授業科目名": "情報リテラシー演習(b)", "開講年度": body_year,
                                "学期": "前期後半", "単位数": "1.5",
                            }.items())
            route.fulfill(status=200, headers={"access-control-allow-origin": "*"}, content_type="text/html",
                          body=f'<meta charset="utf-8"><input id="kougicd" value="{code}">'
                               f'<input id="semekikn" value="{semester}"><input id="risyunen" value="2026">'
                               f'<table class="syllabus_detail">{cells}</table>')

        enrollment.route("https://websrv.tcu.ac.jp/tcu_web_v3/slbssbdr.do**", public_syllabus)
        enrollment.evaluate("chrome.permissions.request = async () => true")
        enrollment.get_by_role("button", name="公式シラバスで単位を照合").click()
        expect(enrollment.locator("#enrollment-lookup-status")).to_contain_text("単位数を確認 1件")
        expect(enrollment.get_by_role("link", name="公式シラバス 1.5単位")).to_have_count(1)
        chosen.get_by_role("button", name="見込み単位に入れる").click()
        expect(enrollment.locator("#enrollment-result")).to_contain_text("入力済みの見込み 3.5単位")
        enrollment.set_viewport_size({"width": 360, "height": 800})
        assert enrollment.evaluate("document.documentElement.scrollWidth === document.documentElement.clientWidth")
        enrollment.close()
        linked = context.new_page()
        linked.goto(f"{extension}/src/planner.html#plan-title")
        expect(linked.locator("#webclass-source-status")).to_contain_text("参加コース 6件")
        expect(linked.locator("#selected")).to_contain_text("saa001102")
        expect(linked.locator("#webclass-unplaced-list")).to_contain_text("コード未登録のコース")
        linked.locator('#selected [data-course-code="saa001102"]').click()
        expect(linked.locator("#selected")).not_to_contain_text("saa001102")
        linked.reload()
        expect(linked.locator("#selected")).not_to_contain_text("saa001102")
        linked.locator("#webclass-excluded summary").click()
        removed = linked.locator("#webclass-excluded-list li").filter(has_text="saa001102")
        removed.get_by_role("button", name="復元").click()
        expect(linked.locator("#selected")).to_contain_text("saa001102")

        existing.unroute("https://webclass.tcu.ac.jp/**")
        previous_schedule = schedule.replace('value="2026">2026', 'value="2025">2025').replace('/26sa', '/25sa')
        existing.route("https://webclass.tcu.ac.jp/**", lambda route: route.fulfill(
            status=200, content_type="text/html", body=previous_schedule
        ))
        existing.reload()
        expect(existing.locator(".wcv-enrollment-summary")).to_contain_text("2025年度")
        linked.get_by_role("button", name="WebClassから再読込").click()
        expect(linked.locator("#webclass-source-status")).to_contain_text("2025年度")
        linked.get_by_role("button", name="参加コースを履修台帳に保存").click()
        expect(linked.locator("#webclass-source-status")).to_contain_text("6件追加")
        expected_ledger = linked.locator("#academic-records")
        expect(expected_ledger.locator("li")).to_have_count(6)
        expect(expected_ledger).to_contain_text("成績未確認")
        linked.locator("#academic-ledger [name=cohort]").select_option("2026:情報科学科")
        linked.get_by_text("成績表の内容をまとめて読み込む").click()
        linked.get_by_label("成績表のタブ区切りデータ").fill(
            "年度\t講義コード\t授業名\t評価\t単位\n2025\tsaa001102\tドイツ語\t優\t2\n2025\tsaa001202\tドイツ語\t不可\t2"
        )
        linked.get_by_role("button", name="読み込む内容を確認").click()
        linked.get_by_role("button", name="確認して履修台帳に保存").click()
        passed = expected_ledger.locator("li").filter(has_text="saa001102")
        expect(passed).to_contain_text("合格・優")
        expect(expected_ledger.locator("li")).to_have_count(6)
        expect(linked.locator(".academic-summary")).to_contain_text("算入を確認済み 0単位")
        passed.get_by_text("成績・単位・算入を編集").click()
        for allowance in ("graduation", "progression"):
            passed.locator(f"[name={allowance}]").select_option("yes")
        passed.get_by_role("button", name="成績と算入を保存").click()
        expect(linked.locator(".academic-summary")).to_contain_text("算入を確認済み 2単位")
        expect(linked.locator(".academic-summary")).to_contain_text("58単位不足")
        linked.locator("#academic-ledger [name=through]").fill("2024")
        linked.locator("#academic-ledger [name=through]").press("Tab")
        expect(linked.locator(".academic-summary > section").first).to_contain_text("算入を確認済み 0単位")
        linked.set_viewport_size({"width": 360, "height": 800})
        assert linked.evaluate("document.documentElement.scrollWidth === innerWidth")
        linked.close()
        existing.close()
        second = context.new_page()
        second.goto(page.url)
        for tab in (page, second):
            expect(tab.locator("#workspace")).to_be_visible()
        page.set_viewport_size({"width": 360, "height": 800})
        assert page.evaluate("document.documentElement.scrollWidth === document.documentElement.clientWidth")
        page.get_by_role("link", name="授業を探す").click()
        expect(page.locator("#query")).to_be_focused()
        expect(page.get_by_role("link", name="授業を探す")).to_have_attribute("aria-current", "location")

        page.get_by_role("button", name="月曜1限の授業を探す").click()
        query = page.locator("#query")
        expect(query).to_be_focused()
        page.locator("#back-to-timetable").click()
        expect(page.get_by_role("button", name="月曜1限の授業を探す")).to_be_focused()
        query.fill("ドイツ語")
        expect(page.locator("#results")).to_contain_text("saa001102")
        expect(page.locator("#results")).not_to_contain_text("saa001202")
        page.locator("#campus").select_option("横浜キャンパス")
        expect(page.locator("#results")).not_to_contain_text("saa001102")
        page.locator("#campus").select_option("世田谷キャンパス")
        expect(page.locator("#results")).to_contain_text("教室 12E")
        page.locator("#campus").select_option("")
        page.locator('#results [data-course-code="saa001102"]').click()
        expect(second.locator("#selected")).to_contain_text("saa001102")

        page.locator("#clear-slot").click()
        query.fill("ＳＡＡ００１２０２")
        page.locator('#results [data-course-code="saa001202"]').click()
        expect(page.locator("#selected")).to_contain_text("saa001202")
        expect(page.locator("#plan-status")).to_have_text("")
        query.fill("徳田太郎")
        page.locator('#results [data-course-code="saa001117"]').click()
        expect(page.locator("#plan-status")).to_contain_text("月曜1限")
        page.locator("#quarter").select_option("1")
        expect(page.locator("#plan-status")).to_have_text("")

        page.reload()
        page.locator("#quarter").select_option("0")
        expect(page.locator("#selected")).to_contain_text("saa001117")
        expect(page.locator("#plan-status")).to_contain_text("月曜1限")
        second.locator('#selected [data-course-code="saa001117"]').click()
        expect(page.locator("#plan-status")).to_have_text("")

        query.fill("saa005508")
        page.locator('#results [data-course-code="saa005508"]').click()
        expect(page.locator("#plan-count")).to_contain_text("コマを特定できない候補 1件")
        expect(page.locator("#timetable")).not_to_contain_text("saa005508")
        expect(page.locator("#selected")).to_contain_text("saa005508")

        page.locator("#credit-profile").select_option("it-general")
        expect(page.locator("#credit-progress")).to_be_visible()
        page.locator('#prior-credit-inputs [name="liberal"]').fill("12")
        page.locator('#prior-credit-inputs [name="language"]').fill("6")
        page.locator('#prior-credit-inputs [name="recognized"]').fill("1.5")
        page.get_by_role("button", name="取得済み単位を保存").click()
        expect(second.locator("#credit-summary")).to_contain_text("19.5単位")
        credit_row = page.locator("#credit-courses form").filter(has_text="saa001102")
        credit_row.get_by_label("単位数").fill("3")
        credit_row.get_by_label("科目区分").select_option("language")
        credit_row.get_by_role("button").click()
        expect(page.locator("#credit-summary")).to_contain_text("見込みを含む 22.5単位")
        free = page.locator("#credit-progress-rows tr").last
        expect(free.locator("td")).to_have_text(["12", "3.5", "4.5", "7.5"])
        credit_row.get_by_label("取得状況").select_option("excluded")
        credit_row.get_by_role("button").click()
        expect(page.locator("#credit-summary")).to_contain_text("見込みを含む 19.5単位")
        page.locator("#credit-profile").select_option("it-international")
        expect(free.locator("td")).to_have_text(["8", "3.5", "3.5", "4.5"])
        page.reload()
        expect(page.locator("#credit-profile")).to_have_value("it-international")
        expect(credit_row.get_by_label("取得状況")).to_have_value("excluded")
        guide_year = page.locator("#guide-year")
        guide_faculty = page.locator("#guide-faculty")
        guide_department = page.locator("#guide-department")
        guide_year.select_option("2022")
        expect(guide_faculty.locator("option")).to_have_count(8)
        guide_faculty.select_option("人間科学部")
        guide_department.select_option("児童学科")
        expect(page.locator("#guide-sources")).to_contain_text("学部の学修要覧")
        expect(page.locator("#guide-template")).to_be_visible()
        page.locator("#guide-rule-add summary").click()
        add_rule = page.locator("#guide-rule-form")
        add_rule.get_by_label("条件名").fill("認定科目")
        add_rule.get_by_label("条件の種類").select_option("maximum")
        add_rule.get_by_label("基準の単位数").fill("2")
        add_rule.get_by_role("button").click()
        rule = page.get_by_role("form", name="認定科目")
        rule.get_by_label("取得済み").fill("1.5")
        rule.get_by_label("見込み").fill("1")
        rule.get_by_role("button", name="記録を保存").click()
        expect(page.locator("#guide-rules")).to_contain_text("取得済み 上限内 ／ 見込み込み 0.5単位超過")
        expect(second.locator("#guide-rules")).to_contain_text("0.5単位超過")
        rule.locator("summary").click()
        rule.get_by_role("checkbox", name=re.compile(r"saa001102")).check()
        rule.get_by_role("button", name="記録を保存").click()
        expect(rule.locator("summary")).to_contain_text("選択 1件")
        credit_row.get_by_label("取得状況").select_option("planned")
        credit_row.get_by_role("button").click()
        expect(second.locator("#guide-rules")).to_contain_text("3.5単位超過")
        credit_row.get_by_label("取得状況").select_option("excluded")
        credit_row.get_by_role("button").click()
        expect(second.locator("#guide-rules")).to_contain_text("0.5単位超過")
        guide_faculty.select_option("情報工学部")
        guide_department.select_option("情報科学科")
        expect(page.locator("#guide-rules")).not_to_contain_text("認定科目")
        expect(page.get_by_role("link", name="要覧の卒業要件の表")).to_have_attribute("href", re.compile(r"#page=7$"))
        page.locator("#guide-course").select_option("international")
        page.locator("#guide-template-add").click()
        expect(page.locator("#guide-rules")).to_contain_text("国際コース｜PBL科目の必修 · 必要 3単位")
        page.locator("#guide-template-add").click()
        expect(page.get_by_role("form", name="国際コース｜PBL科目の必修")).to_have_count(1)
        guide_year.select_option("2026")
        expect(guide_faculty.locator("option")).to_have_count(9)
        guide_faculty.select_option("デザイン・データ科学部")
        guide_department.select_option("デザイン・データ科学科")
        page.locator("#guide-template-add").click()
        expect(page.locator("#guide-rules")).to_contain_text("学科共通｜教養特別講義 · 上限 2単位")
        assert page.evaluate("document.documentElement.scrollWidth === document.documentElement.clientWidth")
        page.locator('#planner-task-form [name="title"]').fill("第1回レポート")
        page.locator('#planner-task-form [name="date"]').fill("2026-12-01")
        page.locator('#planner-task-form [name="course"]').select_option("saa001102")
        page.get_by_role("button", name="課題を追加").click()
        expect(second.locator("#planner-task-list")).to_contain_text("2026-12-01")
        page.get_by_role("checkbox", name="第1回レポート").check()
        expect(second.get_by_role("checkbox", name="第1回レポート")).to_be_checked()
        page.get_by_text("別のブラウザーに引き継ぐ", exact=True).click()
        with page.expect_download() as exporting:
            page.locator("#backup-download").click()
        backup = exporting.value.path()
        guide_year.select_option("2022")
        guide_faculty.select_option("人間科学部")
        guide_department.select_option("児童学科")
        page.once("dialog", lambda dialog: dialog.accept())
        rule.get_by_role("button", name="条件を削除").click()
        page.locator('#selected [data-course-code="saa001102"]').click()
        page.get_by_role("button", name="第1回レポートを削除").click()
        expect(page.locator("#selected")).not_to_contain_text("saa001102")
        page.locator("#backup-file").set_input_files(backup)
        page.locator("#backup-restore button").click()
        expect(page.locator("#backup-status")).to_contain_text("読み込みました")
        expect(guide_department).to_have_value("デザイン・データ科学科")
        guide_year.select_option("2022")
        guide_faculty.select_option("人間科学部")
        guide_department.select_option("児童学科")
        expect(page.locator("#guide-rules")).to_contain_text("0.5単位超過")
        expect(rule.locator("summary")).to_contain_text("選択 1件")
        expect(second.locator("#selected")).to_contain_text("saa001102")
        expect(second.get_by_role("checkbox", name="第1回レポート")).to_be_checked()
        page.locator("#backup-file").set_input_files({
            "name": "invalid.json", "mimeType": "application/json", "buffer": b'{"version":1}'
        })
        page.locator("#backup-restore button").click()
        expect(page.locator("#backup-status")).to_contain_text("読み込めませんでした")
        expect(second.locator("#selected")).to_contain_text("saa001102")
    finally:
        context.close()

print("PASS: planner popup entry, real catalog, slot and instructor search, conflicts and cross-tab persistence")
