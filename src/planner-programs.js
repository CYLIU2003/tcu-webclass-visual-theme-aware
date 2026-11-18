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

  async function initialize(stored) {
    const status = document.getElementById("program-profile-status");
    const form = document.getElementById("program-profile-form");
    const fields = form.elements;
    const resources = document.getElementById("program-resources");
    try {
      const [index] = await load();
      const cohorts = Object.entries(index.profiles).reverse();
      fields.cohort.append(new Option("入学年度と学科を選択", ""));
      for (const year of [...new Set(cohorts.map(([, row]) => row.year))]) {
        const group = document.createElement("optgroup");
        group.label = `${year}年度入学`;
        for (const [id, row] of cohorts.filter(([, profile]) => profile.year === year)) {
          group.append(new Option(row.department, id));
        }
        fields.cohort.append(group);
      }
      const initial = stored[settingsKey];
      for (const [key, yes, no] of [
        ["hirameki", "参加する・参加済み", "参加しない"],
        ["teaching", "履修する・履修済み", "履修しない"],
        ["tap", "参加する・参加済み", "参加しない"],
      ]) {
        fields[key].append(new Option("未設定", ""), new Option(yes, "yes"), new Option(no, "no"));
        if (["yes", "no"].includes(initial?.[key])) fields[key].value = initial[key];
      }
      const remembered = initial?.cohort || stored["planner-guide:profile"];
      if (index.profiles[remembered]) fields.cohort.value = remembered;

      function render() {
        const cohort = index.profiles[fields.cohort.value];
        resources.replaceChildren();
        if (!cohort) return;
        const settings = Object.fromEntries(new FormData(form));
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

      form.addEventListener("change", () => {
        status.textContent = "参加状況を保存すると、コース一覧と履修確認に反映されます。";
        render();
      });
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const settings = Object.fromEntries(new FormData(form));
        if (!index.profiles[settings.cohort]) return;
        const button = event.submitter;
        button.disabled = true;
        try {
          await chrome.storage.local.set({ [settingsKey]: settings });
          status.textContent = "参加状況を保存しました。";
        } catch {
          status.textContent = "保存できませんでした。もう一度お試しください。";
        } finally {
          button.disabled = false;
        }
      });
      render();
      status.textContent = "参加・履修するプログラムを選んで保存してください。";
      form.hidden = false;
    } catch {
      status.textContent = "履修プログラムの資料を読み込めませんでした。プランナーを開き直してください。";
    }
  }

  globalThis.WCV_PLANNER_PROGRAMS = { load, initialize };
})();
