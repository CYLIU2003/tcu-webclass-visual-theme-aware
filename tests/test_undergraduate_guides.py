"""Verify the official guide index, including reproducibility from its snapshots."""

import hashlib
import json
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "data"))
from build_undergraduate_guides import build, cache_path

DATA = ROOT / "data"
index = json.loads((DATA / "undergraduate-guides.json").read_text(encoding="utf-8"))
profiles = {(p["year"], p["department"]): p for p in index["profiles"]}
assert len(profiles) == len(index["profiles"])
assert Counter(year for year, _ in profiles) == {2022: 17, 2023: 18, 2024: 18, 2025: 18, 2026: 18}
assert (2022, "児童学科") in profiles and (2023, "人間科学科") in profiles
assert (2022, "デザイン・データ科学科") not in profiles
assert (2023, "デザイン・データ科学科") in profiles

progression = json.loads((DATA / "progression-rules.json").read_text(encoding="utf-8"))
assert progression["schemaVersion"] == 1
assert set(progression["profiles"]) <= {f"{year}:{department}" for year, department in profiles}
for key, rules in progression["profiles"].items():
    year, department = key.split(":", 1)
    url = profiles[int(year), department]["sources"][0]["url"]
    assert len({rule["stage"] for rule in rules}) == len(rules)
    for rule in rules:
        assert rule["stage"] in {3, 4} and 30 <= rule["minimum"] <= 124
        assert 1 <= rule["page"] <= index["documents"][url]["pages"]
assert progression["profiles"]["2026:情報科学科"] == [
    {"stage": 3, "minimum": 60, "page": 8}, {"stage": 4, "minimum": 100, "page": 8}
]
assert progression["profiles"]["2026:社会メディア学科"][0]["minimum"] == 66
assert progression["profiles"]["2024:デザイン・データ科学科"][0]["minimum"] == 50

documents = index["documents"]
assert set(documents) == {source["url"] for row in profiles.values() for source in row["sources"]}
for url, document in documents.items():
    parsed = urlsplit(url)
    assert (parsed.scheme, parsed.netloc) == ("https", "www.asc.tcu.ac.jp"), url
    assert parsed.path.endswith(".pdf"), url
    assert len(document["sha256"]) == 64, url
    pages = document["graduationPages"]
    assert pages == sorted(set(pages)), url
    assert all(1 <= page <= document["pages"] for page in pages), url

templates = [row for row in profiles.values() if row.get("graduationTemplates")]
assert len(templates) == len(profiles)
for profile in templates:
    for template in profile["graduationTemplates"]:
        assert template["sourcePage"] in documents[profile["sources"][0]["url"]]["graduationPages"]
        assert len({row["id"] for row in template["rules"]}) == len(template["rules"])


def units_for(year, department, course, rule):
    template = next(item for item in profiles[year, department]["graduationTemplates"] if item["id"] == course)
    return {item["id"]: item["units"] for item in template["rules"]}.get(rule)


assert units_for(2022, "情報科学科", "general", "pbl") == 3
assert units_for(2023, "情報科学科", "general", "pbl") is None
assert units_for(2024, "情報科学科", "international", "major-required") == 38
assert units_for(2025, "情報科学科", "international", "major-required") == 44
assert units_for(2026, "知能情報工学科", "general", "major-required") == 23
assert units_for(2026, "機械システム工学科", "standard", "major-required") == 34.5
assert units_for(2026, "自然科学科", "mathematics", "major-required") == 34
assert units_for(2026, "建築学科", "standard", "major-electives-combined") == 35
assert units_for(2022, "建築学科", "standard", "major-electives-combined") == 31
assert units_for(2023, "自然科学科", "mathematics", "foundation-required") == 20
assert units_for(2022, "環境創生学科", "standard", "pbl") == 4
assert units_for(2023, "情報システム学科", "standard", "foundation") == 33
assert units_for(2024, "都市生活学科", "urban-international", "foundation-practice") == 4
assert units_for(2025, "都市生活学科", "standard", "foundation-practice") == 8
assert units_for(2026, "人間科学科", "humanities", "major-required") == 18
assert units_for(2026, "人間科学科", "childhood", "major-required") == 20

if all(cache_path(url).exists() for url in documents):
    paths = [DATA / "source-checks" / "objects" / (item["sha256"] + ".html") for item in index["indexes"]]
    for path in paths:
        assert hashlib.sha256(path.read_bytes()).hexdigest() == path.stem
    assert build(*paths) == index
    print(f"PASS: replayed {len(documents)} official PDF snapshots")

print(f"PASS: {len(profiles)} cohort profiles have official sources")
