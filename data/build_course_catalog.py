#!/usr/bin/env python3
"""Build the local 2026 course catalogue and its SQLite lookup database.

The offering key is (academic_year, course_code). Course names are search
attributes only; identical names always point to separate offering records.
No WebClass account, enrollment, assignment, grade, or session data is read.
"""
from __future__ import annotations

import json
import argparse
import re
import sqlite3
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"


def name_key(value: str) -> str:
    """Normalize typography/spacing while preserving meaningful name tokens."""
    value = unicodedata.normalize("NFKC", value or "")
    value = re.sub(r"[\u200b-\u200d\ufeff]", "", value)
    return re.sub(r"\s+", "", value).casefold()


def compact_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def get_source_catalog(dataset: dict, official: dict) -> list[dict]:
    sources = []
    for source in (dataset.get("scope") or {}).get("sourceDocuments", []):
        sources.append({
            "id": source.get("id", ""),
            "kind": "uploaded-timetable-snapshot",
            "title": source.get("document", ""),
            "scope": source.get("scope", ""),
            "url": "",
            "sha256": source.get("sha256", ""),
            "publicationDate": "",
            "metadata": source,
        })
    for source in official.get("sources", []):
        sources.append({
            "id": source["id"],
            "kind": source.get("kind", "official-document"),
            "title": source.get("title", ""),
            "scope": source.get("scope", ""),
            "url": source.get("fileUrl", ""),
            "pageUrl": source.get("pageUrl", ""),
            "sha256": source.get("sha256", ""),
            "publicationDate": source.get("published", source.get("updated", "")),
            "metadata": source,
        })
    return sources


def build(output_root: Path = ROOT) -> dict:
    output_root = output_root.resolve()
    output_data = output_root / "data"
    output_docs = output_root / "docs"
    output_data.mkdir(parents=True, exist_ok=True)
    output_docs.mkdir(parents=True, exist_ok=True)
    output_files = [output_data / "course-catalog-2026.json", output_data / "course-catalog-2026.sqlite", output_docs / "COURSE_IDENTITY_ANALYSIS_2026.md"]
    existing = [str(path) for path in output_files if path.exists()]
    if existing:
        raise FileExistsError(f"既存ファイルは上書きしません。新規の --output-root を指定してください: {existing}")
    base = json.loads((DATA / "timetable-2026.json").read_text(encoding="utf-8"))
    official = json.loads((DATA / "official-sources-2026.json").read_text(encoding="utf-8"))
    corrections = json.loads((DATA / "timetable-corrections-2026.json").read_text(encoding="utf-8"))
    official_code_index = json.loads((DATA / "official-timetable-code-index-2026.json").read_text(encoding="utf-8"))
    study_guide_profile = json.loads((DATA / "study-guide-profile-2026.json").read_text(encoding="utf-8"))
    courses = base.get("courses", [])
    sources = get_source_catalog(base.get("dataset", {}), official)
    source_by_id = {source["id"]: source for source in sources}
    offerings: list[dict] = []
    by_code: set[str] = set()
    names: dict[str, list[str]] = defaultdict(list)
    aliases_index: dict[str, list[str]] = defaultdict(list)
    instructors: dict[str, list[str]] = defaultdict(list)

    for raw in courses:
        code = str(raw.get("courseCode", "")).strip().lower()
        year = int(raw.get("academicYear") or base["dataset"].get("academicYear") or 2026)
        if not code:
            continue
        offer_id = f"{year}:{code}"
        if offer_id in by_code:
            raise ValueError(f"duplicate offering key {offer_id}")
        by_code.add(offer_id)
        exact_key = name_key(raw.get("courseName", ""))
        aliases = list(dict.fromkeys(a.strip() for a in raw.get("aliases", []) if isinstance(a, str) and a.strip()))
        item = {
            "offeringId": offer_id,
            "academicYear": year,
            "courseCode": code,
            "courseName": raw.get("courseName", ""),
            "nameKey": exact_key,
            "aliases": aliases,
            "semester": raw.get("semester", ""),
            "semesters": raw.get("semesters", []),
            "termBlock": raw.get("termBlock", ""),
            "termBlocks": raw.get("termBlocks", []),
            "instructors": list(dict.fromkeys(raw.get("instructors", []))),
            "meetings": raw.get("meetings", []),
            "level": raw.get("level", ""),
            "departments": raw.get("departments", []),
            "grades": raw.get("grades", []),
            "classes": raw.get("classes", []),
            "campuses": raw.get("campuses", []),
            "category": raw.get("category", ""),
            "scheduleTypes": raw.get("scheduleTypes", []),
            "notes": raw.get("notes", []),
            "sourceEvidence": raw.get("sources", []),
            "sourceKind": "2026-timetable-snapshot",
        }
        offerings.append(item)
        key = name_key(item["courseName"])
        if key and offer_id not in names[key]:
            names[key].append(offer_id)
        for alias in aliases:
            key = name_key(alias)
            if key and offer_id not in aliases_index[key]:
                aliases_index[key].append(offer_id)
        for teacher in item["instructors"]:
            key = name_key(teacher)
            if key and offer_id not in instructors[key]:
                instructors[key].append(offer_id)

    offerings.sort(key=lambda item: (item["academicYear"], item["courseCode"]))
    by_id = {item["offeringId"]: item for item in offerings}
    same_title = {}
    for key, ids in names.items():
        # A course title is a candidate lookup, never an entity identifier.
        if len(ids) > 1:
            same_title[key] = ids

    teacher_distinct = []
    for key, ids in same_title.items():
        teacher_signatures = {tuple(by_id[offer_id]["instructors"]) for offer_id in ids}
        if len(teacher_signatures) > 1:
            teacher_distinct.append(key)

    snapshot = {
        "schemaVersion": 1,
        "catalogId": "tcu-course-catalog-2026",
        "dataQualityStatus": "research-foundation-not-certified",
        "authoritativeForCurrentFallTimetable": False,
        "qualityNotice": "既存スナップショットの科目提供と公式資料のコード索引・訂正候補・要覧ページ索引を併載。最新後期PDFの行単位照合と履修要件の意味抽出が未完了のため、確定版として配布不可。",
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "primaryKey": ["academicYear", "courseCode"],
        "nameMatching": "Exact normalized title indexes map to arrays of offering IDs. Parenthesized section/year tokens are preserved. Never merge candidate instructors or meetings.",
        "baseDataset": {
            "id": base["dataset"]["id"],
            "title": base["dataset"]["title"],
            "generatedAt": base["dataset"].get("generatedAt", ""),
            "scope": base["dataset"].get("scope", {}),
        },
        "sources": sources,
        "correctionEvents": corrections.get("events", []),
        "officialTimetableCodeEvidence": official_code_index.get("records", []),
        "studyGuideProfiles": study_guide_profile.get("guides", []),
        "offerings": offerings,
        "nameIndex": dict(sorted(names.items())),
        "aliasIndex": dict(sorted(aliases_index.items())),
        "instructorNameIndex": dict(sorted(instructors.items())),
        "sameTitleGroups": same_title,
        "summary": {
            "offeringCount": len(offerings),
            "uniqueTitleCount": len(names),
            "sameTitleGroups": len(same_title),
            "sameTitleGroupsWithDifferentInstructorLists": len(teacher_distinct),
            "unmatchedInstructorCount": sum(not item["instructors"] for item in offerings),
            "meetingCount": sum(len(item["meetings"]) for item in offerings),
            "sourceCount": len(sources),
            "officialSources": len(official.get("sources", [])),
            "correctionEvents": len(corrections.get("events", [])),
            "correctionCodesMissingFromBaseSnapshot": sum(not e.get("courseNameFromBaseSnapshot") for e in corrections.get("events", [])),
            "officialCodeSourcePairs": official_code_index.get("summary", {}).get("codeSourcePairs", 0),
            "officialUniqueCourseCodes": official_code_index.get("summary", {}).get("uniqueCourseCodes", 0),
            "officialCodePairsMissingFromBaseSnapshot": official_code_index.get("summary", {}).get("codePairsNotMatchingBaseSnapshot", 0),
            "studyGuideCount": study_guide_profile.get("guideCount", 0),
            "studyGuidePages": study_guide_profile.get("totalPageCount", 0),
            "studyGuideRelevantPages": len({(g["sourceId"], page) for g in study_guide_profile.get("guides", []) for pages in g.get("termPages", {}).values() for page in pages}),
        },
    }

    with (output_data / "course-catalog-2026.json").open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n")
    db_path = output_data / "course-catalog-2026.sqlite"
    # Exclusive creation prevents a race from replacing an existing database.
    with db_path.open("xb"):
        pass
    with sqlite3.connect(db_path) as db:
        db.executescript("""
          PRAGMA foreign_keys = ON;
          CREATE TABLE source_document (
            source_id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
            scope TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
            page_url TEXT NOT NULL DEFAULT '', sha256 TEXT NOT NULL DEFAULT '',
            publication_date TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL
          );
          CREATE TABLE course_offering (
            offering_id TEXT PRIMARY KEY, academic_year INTEGER NOT NULL,
            course_code TEXT NOT NULL, course_name TEXT NOT NULL, name_key TEXT NOT NULL,
            semester TEXT NOT NULL DEFAULT '', term_block TEXT NOT NULL DEFAULT '',
            level TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
            UNIQUE(academic_year, course_code)
          );
          CREATE INDEX ix_offering_name_key ON course_offering(name_key);
          CREATE TABLE course_alias (
            offering_id TEXT NOT NULL REFERENCES course_offering(offering_id),
            alias TEXT NOT NULL, alias_key TEXT NOT NULL,
            PRIMARY KEY(offering_id, alias_key)
          );
          CREATE INDEX ix_alias_key ON course_alias(alias_key);
          CREATE TABLE instructor_assertion (
            offering_id TEXT NOT NULL REFERENCES course_offering(offering_id),
            position INTEGER NOT NULL, display_name TEXT NOT NULL, name_key TEXT NOT NULL,
            PRIMARY KEY(offering_id, position)
          );
          CREATE INDEX ix_teacher_name_key ON instructor_assertion(name_key);
          CREATE TABLE meeting (
            meeting_id INTEGER PRIMARY KEY, offering_id TEXT NOT NULL REFERENCES course_offering(offering_id),
            ordinal INTEGER NOT NULL, day TEXT NOT NULL DEFAULT '', period INTEGER,
            term_block TEXT NOT NULL DEFAULT '', room TEXT NOT NULL DEFAULT '', rooms_json TEXT NOT NULL,
            campus TEXT NOT NULL DEFAULT '', time_profile TEXT NOT NULL DEFAULT '',
            starts_at_nine INTEGER NOT NULL DEFAULT 0, source_refs_json TEXT NOT NULL,
            UNIQUE(offering_id, ordinal)
          );
          CREATE INDEX ix_meeting_day_period ON meeting(day, period);
          CREATE TABLE department (
            department_key TEXT PRIMARY KEY, code TEXT NOT NULL DEFAULT '',
            label TEXT NOT NULL, source_group TEXT NOT NULL DEFAULT ''
          );
          CREATE TABLE offering_department (
            offering_id TEXT NOT NULL REFERENCES course_offering(offering_id),
            department_key TEXT NOT NULL REFERENCES department(department_key),
            PRIMARY KEY(offering_id, department_key)
          );
          CREATE TABLE offering_source_evidence (
            evidence_id INTEGER PRIMARY KEY, offering_id TEXT NOT NULL REFERENCES course_offering(offering_id),
            source_ref TEXT NOT NULL, document TEXT NOT NULL DEFAULT '', page INTEGER,
            source_kind TEXT NOT NULL
          );
          CREATE TABLE offering_attribute (
            offering_id TEXT NOT NULL REFERENCES course_offering(offering_id),
            attribute TEXT NOT NULL, value_json TEXT NOT NULL,
            PRIMARY KEY(offering_id, attribute)
          );
          CREATE TABLE correction_event (
            event_id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES source_document(source_id),
            course_code TEXT NOT NULL, base_offering_id TEXT REFERENCES course_offering(offering_id),
            change_date TEXT NOT NULL DEFAULT '', source_page INTEGER NOT NULL,
            categories_json TEXT NOT NULL, before_after_json TEXT NOT NULL,
            source_excerpt TEXT NOT NULL, review_status TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0
          );
          CREATE INDEX ix_correction_course_code ON correction_event(course_code);
          CREATE TABLE official_timetable_code_evidence (
            source_id TEXT NOT NULL REFERENCES source_document(source_id),
            course_code TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '', term TEXT NOT NULL DEFAULT '',
            occurrence_count INTEGER NOT NULL, source_pages_json TEXT NOT NULL,
            source_evidence_json TEXT NOT NULL, base_snapshot_match INTEGER NOT NULL DEFAULT 0,
            review_status TEXT NOT NULL,
            PRIMARY KEY(source_id, course_code)
          );
          CREATE INDEX ix_official_code_evidence_code ON official_timetable_code_evidence(course_code);
          CREATE TABLE study_guide_term_page (
            source_id TEXT NOT NULL REFERENCES source_document(source_id), page_no INTEGER NOT NULL,
            term TEXT NOT NULL, PRIMARY KEY(source_id,page_no,term)
          );
          CREATE INDEX ix_study_guide_term ON study_guide_term_page(term);
        """)
        for source in sources:
            db.execute("INSERT OR REPLACE INTO source_document VALUES (?,?,?,?,?,?,?,?,?)", (
                source["id"], source["kind"], source["title"], source.get("scope", ""),
                source.get("url", ""), source.get("pageUrl", ""), source.get("sha256", ""),
                source.get("publicationDate", ""), compact_json(source.get("metadata", {})),
            ))
        for item in offerings:
            db.execute("INSERT INTO course_offering VALUES (?,?,?,?,?,?,?,?,?)", (
                item["offeringId"], item["academicYear"], item["courseCode"], item["courseName"],
                item["nameKey"], item["semester"], item["termBlock"], item["level"], item["category"],
            ))
            for alias in item["aliases"]:
                db.execute("INSERT OR IGNORE INTO course_alias VALUES (?,?,?)", (item["offeringId"], alias, name_key(alias)))
            for pos, teacher in enumerate(item["instructors"]):
                db.execute("INSERT INTO instructor_assertion VALUES (?,?,?,?)", (item["offeringId"], pos, teacher, name_key(teacher)))
            for pos, mtg in enumerate(item["meetings"]):
                refs = mtg.get("sources", [])
                db.execute("""INSERT INTO meeting (offering_id,ordinal,day,period,term_block,room,rooms_json,campus,time_profile,starts_at_nine,source_refs_json)
                              VALUES (?,?,?,?,?,?,?,?,?,?,?)""", (
                    item["offeringId"], pos, mtg.get("day", ""), mtg.get("period"), mtg.get("termBlock", ""),
                    mtg.get("room", ""), compact_json(mtg.get("rooms", [])), mtg.get("campus", ""),
                    mtg.get("timeProfile", ""), int(bool(mtg.get("startsAtNine"))), compact_json(refs),
                ))
            for dept in item["departments"]:
                dcode, label, group = dept.get("code", ""), dept.get("label", ""), dept.get("sourceGroup", "")
                dkey = f"{dcode}|{label}|{group}"
                db.execute("INSERT OR IGNORE INTO department VALUES (?,?,?,?)", (dkey, dcode, label, group))
                db.execute("INSERT OR IGNORE INTO offering_department VALUES (?,?)", (item["offeringId"], dkey))
            refs = item["sourceEvidence"]
            for ref in refs:
                db.execute("INSERT INTO offering_source_evidence (offering_id,source_ref,document,page,source_kind) VALUES (?,?,?,?,?)", (
                    item["offeringId"], ref.get("id", ""), ref.get("document", ""), ref.get("page"), item["sourceKind"],
                ))
            for attr in ("grades", "classes", "campuses", "scheduleTypes", "notes", "sourceEvidence"):
                db.execute("INSERT INTO offering_attribute VALUES (?,?,?)", (item["offeringId"], attr, compact_json(item.get(attr, []))))
        for event in corrections.get("events", []):
            code = event.get("courseCode", "")
            year = int(base["dataset"].get("academicYear") or 2026)
            base_id = f"{year}:{code}" if f"{year}:{code}" in by_id else None
            db.execute("INSERT INTO correction_event VALUES (?,?,?,?,?,?,?,?,?,?,?)", (
                event["eventId"], event["sourceId"], code, base_id, event.get("changeDate", ""),
                event.get("sourcePage", 0), compact_json(event.get("changeCategoriesCandidate", [])),
                compact_json(event.get("beforeAfterTextCandidate", [])), event.get("sourceExcerpt", ""),
                event.get("reviewStatus", "unreviewed"), int(bool(event.get("applied"))),
            ))
        for record in official_code_index.get("records", []):
            db.execute("INSERT INTO official_timetable_code_evidence VALUES (?,?,?,?,?,?,?,?,?)", (
                record["sourceId"], record["courseCode"], record.get("scope", ""), record.get("term", ""),
                record.get("occurrenceCount", 0), compact_json(record.get("sourcePages", [])),
                compact_json(record.get("sourceEvidence", [])), int(bool(record.get("baseSnapshotMatch"))),
                record.get("reviewStatus", "needs-review"),
            ))
        for guide in study_guide_profile.get("guides", []):
            for term, pages in guide.get("termPages", {}).items():
                for page_no in pages:
                    db.execute("INSERT OR IGNORE INTO study_guide_term_page VALUES (?,?,?)", (guide["sourceId"], page_no, term))
        db.execute("PRAGMA user_version = 1")

    write_analysis(snapshot, output_docs)
    print(json.dumps(snapshot["summary"], ensure_ascii=False))


def write_analysis(snapshot: dict, output_docs: Path) -> None:
    offers = {item["offeringId"]: item for item in snapshot["offerings"]}
    groups = []
    for key, ids in snapshot["sameTitleGroups"].items():
        if len({tuple(offers[i]["instructors"]) for i in ids}) > 1:
            groups.append((key, ids))
    groups.sort(key=lambda entry: (len(entry[1]), entry[0]))
    lines = [
        "# 2026年度 公式資料に基づく科目データ初期分析",
        "",
        "この分析は、配布済みの2026年度時間割データを講義コード単位で再索引した初期版です。",
        "教学課の公開ページから時間割・訂正表・学修要覧を照合するための資料台帳も作成しています。",
        "公開PDFの訂正内容はまだ各レコードへ反映していません。訂正表は時間割本体と別の根拠として管理します。",
        "",
        "## データ件数",
        "",
        f"- 講義コード単位の授業提供: {snapshot['summary']['offeringCount']:,}件",
        f"- 正規化した完全一致の科目名: {snapshot['summary']['uniqueTitleCount']:,}種類",
        f"- 複数の講義コードを持つ同名グループ: {snapshot['summary']['sameTitleGroups']:,}組",
        f"- 同名グループ内で担当教員リストも異なる組: {snapshot['summary']['sameTitleGroupsWithDifferentInstructorLists']:,}組",
        f"- 固定時限の登録数: {snapshot['summary']['meetingCount']:,}件",
        f"- 公開訂正表から抽出した未適用イベント: {snapshot['summary']['correctionEvents']:,}件",
        f"- 既存スナップショットと講義コードで照合できない訂正イベント: {snapshot['summary']['correctionCodesMissingFromBaseSnapshot']:,}件",
        f"- 公式後期時間割6資料のコード×資料索引: {snapshot['summary']['officialCodeSourcePairs']:,}件（{snapshot['summary']['officialUniqueCourseCodes']:,}種類のコード）",
        f"- 既存スナップショットに見当たらない公式コード×資料: {snapshot['summary']['officialCodePairsMissingFromBaseSnapshot']:,}件",
        f"- 学修要覧の対象範囲: {snapshot['summary']['studyGuideCount']}冊・{snapshot['summary']['studyGuidePages']:,}ページ、履修関連語句が見つかったページ{snapshot['summary']['studyGuideRelevantPages']:,}ページ",
        "",
        "## 識別ルール",
        "",
        "1. 主キーは `年度 + 講義コード`。科目名だけを主キーにしない。",
        "2. 講義コードが取れない検索は完全一致名の候補配列を返す。候補の教員・教室・曜日時限は合算しない。",
        "3. `(1)`、`(2)`、`(a)`、`(b)` などの括弧内表記を検索キーで勝手に落とさない。正式名称の区別を保存する。",
        "4. 教員名は「人の同一性」ではなく、授業ごとの担当記載として保存する。同姓同名を同一人物と推測しない。",
        "5. 各時限・教室・担当者に資料名とページを付け、訂正表は変更履歴として別途積む。",
        "",
        "## 教員が異なる同名科目の例",
        "",
    ]
    for _, ids in groups[:12]:
        first = offers[ids[0]]
        name = first["courseName"]
        parts = []
        for offer_id in ids[:6]:
            item = offers[offer_id]
            teacher = "、".join(item["instructors"]) or "資料に担当者記載なし"
            depts = "、".join(dict.fromkeys(d.get("label", "") for d in item["departments"] if d.get("label")))
            term = item.get("termBlock") or item.get("semester") or ""
            parts.append(f"`{item['courseCode']}`（{teacher}、{term}、{depts}）")
        more = f" ほか{len(ids)-6}コード" if len(ids) > 6 else ""
        lines.append(f"- **{name}** — " + " / ".join(parts) + more)
    lines += [
        "",
        "## 根拠資料",
        "",
        "教学課が公開する最新の時間割と学修要覧の一覧は [`official-sources-2026.json`](../data/official-sources-2026.json) に記録しています。",
        "時間割PDFには講義コード・担当者・開講期・曜日時限・教室・受講対象が掲載されています。訂正表は日付、コード、科目名、担当、変更項目と変更内容を掲載しているため、更新差分の根拠に使えます。",
        "",
        "## 現時点での制約",
        "",
        f"- カタログの授業提供{snapshot['summary']['offeringCount']:,}件は既存の2026年度時間割スナップショット由来です。公式後期時間割のコード索引だけから科目名・担当者・教室・時限を確定していません。",
        "- 公式索引の未一致数は旧2,556科目スナップショットとの照合結果です。現行の3,736科目との未一致数ではありません。差分の確定には原表での照合が必要です。",
        "- 訂正イベント候補は別テーブルに保存し、既存授業へ自動適用していません。",
        "- 学修要覧PDFは資料源として登録しています。科目区分・単位・必修/選択・履修条件の全学部抽出は未着手です。",
        "- 最新情報の利用時は教学課が指定する各年度・入学年度の要覧と、訂正表・正誤表を確認してください。",
        "",
    ]
    with (output_docs / "COURSE_IDENTITY_ANALYSIS_2026.md").open("x", encoding="utf-8") as stream:
        stream.write("\n".join(lines))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root", type=Path, default=ROOT, help="新しい出力先のルート（既存ファイルは上書きしません）")
    build(parser.parse_args().output_root)
