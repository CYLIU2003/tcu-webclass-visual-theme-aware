(() => {
  "use strict";

  const { settingsKey, programNames } = WCV_CURRICULUM;
  const hiramekiSources = "https://hirameki.tcu.ac.jp/program/list/";

  async function read(path) {
    const response = await fetch(chrome.runtime.getURL(path));
    if (!response.ok) throw new Error("Program data unavailable");
    return response.json();
  }

  let loading;
  function load() {
    loading ??= Promise.all([read("data/undergraduate-programs.json"), read("data/curriculum-candidates.json")]);
    return loading;
  }

  function resource(label, url, note) {
    const row = document.createElement("li");
    const anchor = document.createElement("a");
    anchor.textContent = label;
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    row.append(anchor, document.createElement("br"), note);
    return row;
  }

  function cohortPicker(year, department, profiles) {
    const years = [...new Set(profiles.map((row) => row.year))].sort((a, b) => b - a);
    year.replaceChildren(new Option("入学年度を選択", ""),
      ...years.map((value) => new Option(`${value}年度`, String(value))));
    function showDepartments() {
      department.replaceChildren(new Option(year.value ? "学科を選択" : "先に入学年度を選択", ""));
      department.disabled = !year.value;
      const groups = new Map();
      for (const row of profiles.filter((row) => String(row.year) === year.value)) {
        if (!groups.has(row.faculty)) {
          const group = document.createElement("optgroup");
          group.label = row.faculty;
          groups.set(row.faculty, group);
          department.append(group);
        }
        groups.get(row.faculty).append(new Option(row.department, `${row.year}:${row.department}`));
      }
    }
    year.addEventListener("change", showDepartments);
    return (id, fallback) => {
      const saved = profiles.find((row) => `${row.year}:${row.department}` === id);
      year.value = String(saved?.year || fallback || "");
      showDepartments();
      if (saved) department.value = id;
    };
  }

  async function initialize(stored) {
    const status = document.getElementById("program-profile-status");
    const form = document.getElementById("program-profile-form");
    const fields = form.elements;
    const resources = document.getElementById("program-resources");
    try {
      const [index] = await load();
      const restoreCohort = cohortPicker(document.getElementById("program-year"), fields.cohort, Object.values(index.profiles));
      const initial = stored[settingsKey];
      for (const [key, yes, no] of [
        ["hirameki", "参加する・参加済み", "参加しない"],
        ["teaching", "履修する・履修済み", "履修しない"],
        ["tap", "参加する・参加済み", "参加しない"],
      ]) {
        fields[key].append(new Option("未設定", ""), new Option(yes, "yes"), new Option(no, "no"));
        if (["yes", "no"].includes(initial?.[key])) fields[key].value = initial[key];
      }
      const remembered = initial?.cohort ?? stored["academic-profile"]?.cohort ?? stored["planner-guide:profile"];
      restoreCohort(remembered, initial?.year ?? stored.webclassAdmissionYear);

      function values() {
        return { year: document.getElementById("program-year").value,
          ...Object.fromEntries(["cohort", ...Object.keys(programNames)].map((key) => [key, fields[key].value])) };
      }

      function render() {
        const cohort = index.profiles[fields.cohort.value];
        resources.replaceChildren();
        if (!cohort) return;
        const settings = values();
        for (const [key, label] of Object.entries(programNames)) {
          if (settings[key] !== "yes") continue;
          const href = cohort.documents[key] || hiramekiSources;
          let note;
          if (key === "tap") {
            note = cohort.tap ? `読み替え対象の国内科目 ${cohort.tap.titles.length}科目。認定後の単位は成績表で確認してください。`
              : "読み替え対象科目は要覧の単位認定表を確認してください。";
          } else if (cohort.scopes[key]) {
            note = "収録済みの同名科目を照合します。科目区分・適用条件は原資料を確認してください。";
          } else if (key === "teaching" && cohort.teachingDocument) {
            note = "教職課程の要覧を確認できます。科目別の区分は原資料を確認してください。";
          } else {
            note = "この入学年度・学科に対応する科目別データは未収録です。公式資料を確認してください。";
          }
          const row = resource(`${label}の公式資料`, href, note);
          if (key === "tap" && cohort.tap) {
            const details = document.createElement("details");
            const heading = document.createElement("summary");
            heading.textContent = "読み替え対象の国内科目を見る";
            const titles = document.createElement("p");
            titles.textContent = cohort.tap.titles.join("、");
            details.append(heading, titles);
            row.append(details);
          }
          resources.append(row);
        }
      }

      async function save() {
        const settings = values();
        try {
          await chrome.storage.local.set({
            [settingsKey]: settings, "planner-guide:profile": settings.cohort, studyLevel: "undergraduate"
          });
          const complete = Boolean(index.profiles[settings.cohort]);
          status.textContent = complete ? "参加状況を保存しました。" : "入学年度と学科を選んでください。";
          return complete;
        } catch {
          status.textContent = "保存できませんでした。もう一度お試しください。";
        }
      }
      form.addEventListener("change", (event) => {
        if (event.target.id !== "academic-course") { render(); void save(); }
      });
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (await save()) location.hash = "credits-title";
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        const saved = changes[settingsKey]?.newValue;
        if (area !== "local" || !saved) return;
        const local = values();
        if (Object.keys(local).every((key) => local[key] === saved[key])) return;
        restoreCohort(saved.cohort, saved.year);
        for (const key of Object.keys(programNames)) fields[key].value = saved[key] || "";
        render();
      });
      render();
      status.textContent = "学科と参加状況の変更は自動で保存されます。";
      form.hidden = false;
    } catch {
      status.textContent = "履修プログラムの資料を読み込めませんでした。プランナーを開き直してください。";
    }
  }

  globalThis.WCV_PLANNER_PROGRAMS = { load, initialize };
})();
