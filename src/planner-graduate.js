(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  let selection = null;
  let setVerified = () => {};

  function select(input, values, placeholder) {
    const previous = input.value;
    input.replaceChildren(new Option(placeholder, ""), ...values.map((value) => new Option(value)));
    input.value = values.includes(previous) ? previous : "";
    input.disabled = !values.length;
  }

  function link(source) {
    const anchor = document.createElement("a");
    anchor.textContent = source.label;
    anchor.href = source.url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    const item = document.createElement("li");
    item.append(anchor);
    return item;
  }

  function units(input) {
    return input.value !== "" && input.validity.valid ? Math.round(input.valueAsNumber * 100) : null;
  }

  async function initialize(stored) {
    const status = $("graduate-status");
    try {
      const response = await fetch(chrome.runtime.getURL("data/graduate-guides.json"));
      if (!response.ok) throw new Error("Graduate guides unavailable");
      const { profiles } = await response.json();
      const year = $("graduate-year");
      const school = $("graduate-school");
      const major = $("graduate-major");
      const program = $("graduate-program");
      const earned = $("graduate-earned");
      const planned = $("graduate-planned");
      const sources = $("graduate-sources");
      const summary = $("graduate-result");
      let selected;
      const verified = new Map();

      function renderRule() {
        const rule = selected?.programs.find((entry) => entry.name === program.value);
        sources.replaceChildren(...(selected?.sources || []).map(link));
        if (rule?.source) sources.prepend(link(rule.source));
        earned.disabled = planned.disabled = !Number.isFinite(rule?.minimum);
        if (!rule) {
          summary.textContent = selected ? "課程を選ぶと確認できる条件が表示されます。" : "";
          return;
        }
        if (!Number.isFinite(rule.minimum)) {
          summary.textContent = "博士後期課程の履修・研究指導、論文審査などは、上の履修要綱で確認してください。";
          return;
        }
        const recorded = verified.get(selection?.key);
        earned.placeholder = recorded == null ? "" : String(recorded / 100);
        const total = units(earned) ?? recorded;
        const projection = units(planned);
        const minimum = rule.minimum * 100;
        const target = document.createElement("strong");
        target.textContent = `修了に必要な総単位 ${rule.minimum}単位`;
        summary.replaceChildren(target);
        if (total != null) {
          const gap = document.createElement("p");
          gap.textContent = `取得済みで残り ${Math.max(0, minimum - total) / 100}単位` +
            (projection !== null ? ` ／ 見込みを含めて残り ${Math.max(0, minimum - total - projection) / 100}単位` : "");
          summary.append(gap);
        }
        const details = document.createElement("p");
        details.textContent = rule.note || "必修・区分別単位・在学期間・研究指導・論文審査は履修要綱とポータルの正誤表で確認してください。";
        summary.append(details);
      }

      function updateProgram() {
        const rule = selected?.programs.find((entry) => entry.name === program.value);
        const previousKey = selection?.key;
        selection = rule ? { key: JSON.stringify([year.value, school.value, major.value, program.value]),
          year: selected.year, major: selected.major, program: rule.name, rule, source: rule.source || selected.sources[0] } : null;
        renderRule();
        if (selection?.key !== previousKey) document.dispatchEvent(new Event("graduate-program-change"));
        const affiliation = [year.value && year.value + "年度入学", school.value, major.value, program.value];
        $("credit-graduate-profile").textContent = affiliation.filter(Boolean).join(" ／ ") || "入学年度と研究科を選んでください。";
        const result = $("credit-graduate-result");
        result.replaceChildren(...Array.from(summary.children, (node) => node.cloneNode(true)));
        if (!summary.children.length) result.textContent = summary.textContent;
        if (!earned.disabled && units(earned) !== null) {
          const recorded = document.createElement("p");
          recorded.textContent = `入力済みの取得単位 ${units(earned) / 100}単位`
            + (units(planned) === null ? "" : ` ／ 見込み ${units(planned) / 100}単位`);
          result.append(recorded);
        }
        const estimate = $("final-graduate-estimate");
        estimate.replaceChildren();
        if (Number.isFinite(rule?.minimum) && (units(earned) !== null || units(planned) !== null)) {
          const manual = units(earned);
          const base = manual ?? verified.get(selection.key);
          if (base != null) {
            const remaining = Math.max(0, rule.minimum * 100 - base - (units(planned) ?? 0));
            estimate.textContent = `試算（${manual === null ? "履修台帳の確認値" : "手入力した取得単位"} ${base / 100}単位 ＋ 見込み ${(units(planned) ?? 0) / 100}単位）では残り ${remaining / 100}単位`;
          }
        }
      }

      setVerified = (key, total) => {
        if (verified.get(key) === total) return;
        verified.set(key, total);
        if (selection?.key === key) updateProgram();
      };

      function updateProfile(saved) {
        const cohort = profiles.filter((row) => String(row.year) === year.value);
        select(school, [...new Set(cohort.map((row) => row.school))], "研究科を選択");
        if (saved) school.value = saved.school || "";
        const schoolProfiles = cohort.filter((row) => row.school === school.value);
        select(major, schoolProfiles.map((row) => row.major), "専攻を選択");
        if (saved) major.value = saved.major || "";
        const next = schoolProfiles.find((row) => row.major === major.value);
        if (selected !== next) {
          program.value = "";
          earned.value = planned.value = "";
        }
        selected = next;
        select(program, (selected?.programs || []).map((rule) => rule.name), "課程を選択");
        if (selected?.programs.length === 1) program.selectedIndex = 1;
        if (saved?.program && selected?.programs.some((rule) => rule.name === saved.program)) {
          program.value = saved.program;
        }
        if (saved) {
          const rule = selected?.programs.find((entry) => entry.name === program.value);
          earned.value = Number.isFinite(rule?.minimum) ? saved.earned || "" : "";
          planned.value = Number.isFinite(rule?.minimum) ? saved.planned || "" : "";
        }
        $("graduate-minimum").hidden = !selected;
        status.textContent = selected ? `${selected.year}年度入学・${selected.major}` : "入学年度、研究科、専攻の順に選んでください。";
        updateProgram();
      }

      select(year, [...new Set(profiles.map((row) => String(row.year)))], "入学年度を選択");
      const controls = { year, school, major, program, earned, planned };
      function values() {
        return Object.fromEntries(Object.entries(controls).map(([key, input]) => [key, input.value]));
      }
      function restore(saved = {}) {
        year.value = saved.year || "";
        updateProfile(saved);
      }
      function save() {
        chrome.storage.local.set({ "graduate-profile": values(), studyLevel: "graduate" }).catch(() => {
          status.textContent = "大学院の設定を保存できませんでした。";
        });
      }
      for (const input of [year, school, major]) input.addEventListener("change", () => {
        if (input === year) school.value = "";
        if (input !== major) major.value = "";
        updateProfile();
        save();
      });
      program.addEventListener("change", () => {
        earned.value = planned.value = "";
        updateProgram();
        save();
      });
      for (const input of [earned, planned]) input.addEventListener("input", () => {
        updateProgram();
        if (input.validity.valid) save();
      });
      restore(stored["graduate-profile"]);
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes["graduate-profile"]) return;
        const value = changes["graduate-profile"].newValue || {};
        if (Object.entries(controls).some(([key, input]) => input.value !== (value[key] || ""))) restore(value);
      });
      $("graduate-controls").hidden = false;
    } catch {
      status.textContent = "大学院のデータを読み込めませんでした。教学課の履修要綱を確認してください。";
      sourcesFallback(status);
    }
  }

  function sourcesFallback(status) {
    const source = document.createElement("a");
    source.href = "https://www.asc.tcu.ac.jp/syllabus_grad/";
    source.target = "_blank";
    source.rel = "noopener noreferrer";
    source.textContent = "教学課の大学院履修要綱";
    status.after(source);
  }

  globalThis.WCV_PLANNER_GRADUATE = { initialize, selectedRule: () => selection,
    setVerified: (key, total) => setVerified(key, total) };
})();
