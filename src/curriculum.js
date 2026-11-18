/* Source-backed candidates; title matching never certifies an offering. */
(() => {
  "use strict";
  function normalize(value) {
    return String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  }
  function match(data, profile, courseName) {
    if (!data || !profile || !courseName) return [];
    const allowed = new Set();
    if (profile.plan === "2026-information-science") allowed.add("information-science");
    if (profile.plan === "2025-hirameki-engineering") allowed.add("hirameki-engineering-2025");
    if (profile.plan === "2025-hirameki-other") allowed.add("hirameki-other-2025");
    if (profile.plan === "2024-hirameki-engineering") allowed.add("hirameki-engineering");
    if (profile.plan === "2023-hirameki-engineering") allowed.add("hirameki-engineering-2023");
    if (profile.plan === "2022-hirameki-engineering") allowed.add("hirameki-engineering-2022");
    if (profile.hirameki && ["2026-information-science", "2026-hirameki-eligible"].includes(profile.plan)) allowed.add("hirameki-2026");
    if (profile.teaching && profile.plan === "2026-information-science") allowed.add("teaching-engineering-information");
    return (data.records || []).filter(row => allowed.has(row.scope) && normalize(row.title) === normalize(courseName));
  }
  const programNames = Object.freeze({ hirameki: "ひらめき", teaching: "教職課程", tap: "TAP" });
  const settingsKey = "undergraduatePrograms";

  function programMatches(index, candidates, settings, courseName) {
    const cohort = index?.profiles?.[settings?.cohort];
    const title = normalize(courseName);
    if (!cohort || !title) return [];
    const results = [];
    for (const key of ["department", "hirameki", "teaching"]) {
      const scope = key === "department" && cohort.year === 2026 && cohort.department === "情報科学科"
        ? "information-science" : cohort.scopes[key];
      if (!scope || (key !== "department" && settings[key] !== "yes")) continue;
      for (const row of candidates?.records || []) {
        if (row.scope !== scope || normalize(row.title) !== title) continue;
        const source = candidates.sources.find((entry) => entry.id === row.sourceId);
        if (!source) continue;
        results.push({ ...row, url: source.url + (row.sourcePage ? "#page=" + row.sourcePage : "") });
      }
    }
    if (settings.tap === "yes" && cohort.tap?.titles.some((value) => normalize(value) === title)) {
      results.push({ scope: "tap", kind: "recognition", url: cohort.tap.url, sourcePage: cohort.tap.page,
        note: "入学年度の単位認定表に同名科目があります。原表ではTAP参加者はこの国内科目を履修せず、留学先科目を読み替えて認定します。自分の適用条件と認定状況は要覧・ポータルで確認してください。" });
    }
    return results;
  }

  function programLabel(row) {
    if (row.scope === "tap") return "TAPの単位読み替え候補";
    const program = row.scope.startsWith("hirameki") ? "ひらめき" : row.scope.startsWith("teaching") ? "教職課程" : "学科";
    const category = { required: "必修", choice: "選択必修" }[row.kind];
    return category ? `${program}の同名候補（資料上は${category}）` : `${program}の同名資料`;
  }

  globalThis.WCV_CURRICULUM = Object.freeze({ match, normalize, programMatches, programLabel, programNames, settingsKey });
})();
