(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

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

  async function initialize() {
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

      function updateProgram() {
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
        const total = units(earned);
        const projection = units(planned);
        const minimum = rule.minimum * 100;
        const target = document.createElement("strong");
        target.textContent = `修了に必要な総単位 ${rule.minimum}単位`;
        summary.replaceChildren(target);
        if (total !== null) {
          const gap = document.createElement("p");
          gap.textContent = `取得済みで残り ${Math.max(0, minimum - total) / 100}単位` +
            (projection !== null ? ` ／ 見込みを含めて残り ${Math.max(0, minimum - total - projection) / 100}単位` : "");
          summary.append(gap);
        }
        const details = document.createElement("p");
        details.textContent = rule.note || "必修・区分別単位・在学期間・研究指導・論文審査は履修要綱とポータルの正誤表で確認してください。";
        summary.append(details);
      }

      function updateProfile() {
        const cohort = profiles.filter((row) => String(row.year) === year.value);
        select(school, [...new Set(cohort.map((row) => row.school))], "研究科を選択");
        const schoolProfiles = cohort.filter((row) => row.school === school.value);
        select(major, schoolProfiles.map((row) => row.major), "専攻を選択");
        const next = schoolProfiles.find((row) => row.major === major.value);
        if (selected !== next) {
          program.value = "";
          earned.value = planned.value = "";
        }
        selected = next;
        select(program, (selected?.programs || []).map((rule) => rule.name), "課程を選択");
        if (selected?.programs.length === 1) program.selectedIndex = 1;
        $("graduate-minimum").hidden = !selected;
        status.textContent = selected ? `${selected.year}年度入学・${selected.major}` : "入学年度、研究科、専攻の順に選んでください。";
        updateProgram();
      }

      select(year, [...new Set(profiles.map((row) => String(row.year)))], "入学年度を選択");
      for (const input of [year, school, major]) input.addEventListener("change", updateProfile);
      program.addEventListener("change", () => {
        earned.value = planned.value = "";
        updateProgram();
      });
      for (const input of [earned, planned]) input.addEventListener("input", updateProgram);
      updateProfile();
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

  globalThis.WCV_PLANNER_GRADUATE = { initialize };
})();
