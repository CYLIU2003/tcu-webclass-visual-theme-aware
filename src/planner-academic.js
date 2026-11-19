(() => {
  "use strict";

  const prefix = "academic-record:";
  const profileKey = "academic-profile";
  const $ = (id) => document.getElementById(id);
  const codePattern = /^[a-z]{3,4}\d{4,6}$/;
  const grades = ["", "不可", "可", "良", "優", "秀", "認定", "欠席", "履修中"];
  const passing = new Set(["秀", "優", "良", "可", "認定"]);

  function el(tag, text) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    return node;
  }

  function field(label, control) {
    const wrapper = el("label", label);
    wrapper.append(control);
    return wrapper;
  }

  function select(name, choices, value = "") {
    const input = el("select");
    input.name = name;
    for (const [id, label] of choices) input.append(new Option(label, id));
    input.value = value;
    return input;
  }

  function input(name, value = "", type = "text") {
    const control = el("input");
    Object.assign(control, { name, type, value });
    return control;
  }

  function button(text, type = "button") {
    const control = el("button", text);
    control.type = type;
    return control;
  }

  function source(text, url) {
    const link = el("a", text);
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  }

  function toUnits(value) {
    const normalized = String(value ?? "").normalize("NFKC").trim();
    return /^\d{1,2}(?:\.\d{1,2})?$/.test(normalized) ? Math.round(Number(normalized) * 100) : null;
  }

  function completed(record) {
    return passing.has(record.grade) && Number.isInteger(record.units) && record.units > 0;
  }

  function progressionCutoff(admissionYear, stage, override) {
    return override ?? (admissionYear + stage - 2);
  }

  function calculate(records, allowance, through) {
    const included = records.filter((row) => completed(row) && row[allowance] === "yes"
      && (!through || row.year <= through));
    const byCode = new Map();
    const byName = new Map();
    for (const row of included) {
      const title = WCV_CURRICULUM.normalize(row.name);
      byName.set(title, (byName.get(title) || 0) + 1);
      if (row.code) byCode.set(row.code, (byCode.get(row.code) || 0) + 1);
    }
    const conflicts = included.filter((row) => byName.get(WCV_CURRICULUM.normalize(row.name)) > 1
      || (row.code && byCode.get(row.code) > 1));
    const duplicates = new Set(conflicts);
    const eligible = included.filter((row) => !duplicates.has(row));
    return { eligible, conflicts, total: eligible.reduce((sum, row) => sum + row.units, 0) };
  }

  function readGradeRows(value) {
    const lines = value.replace(/^\uFEFF/, "").replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, "").split(/\r?\n/);
    const headings = lines[0].normalize("NFKC").split("\t").map((label) => label.trim());
    const columns = {
      year: headings.findIndex((label) => ["年度", "開講年度", "修得期"].includes(label)),
      code: headings.findIndex((label) => ["講義コード", "科目コード"].includes(label)),
      name: headings.findIndex((label) => ["授業名", "科目", "科目名", "授業科目名"].includes(label)),
      grade: headings.findIndex((label) => ["評価", "成績"].includes(label)),
      units: headings.findIndex((label) => ["単位", "単位数"].includes(label))
    };
    if ([columns.year, columns.name, columns.grade, columns.units].includes(-1) || lines.length < 2 || lines.length > 1001) {
      throw new Error("年度（または修得期）・科目名・評価・単位の見出しを含む表を貼り付けてください。");
    }
    const seen = new Set();
    return lines.slice(1).map((line, index) => {
      const cells = line.split("\t").map((item) => item.trim());
      const year = Number(cells[columns.year]?.normalize("NFKC").match(/^20\d{2}(?!\d)/)?.[0]);
      const code = cells[columns.code]?.normalize("NFKC").toLowerCase() || null;
      const name = cells[columns.name];
      const grade = cells[columns.grade]?.normalize("NFKC");
      const units = toUnits(cells[columns.units]);
      const id = `${year}:${code || WCV_CURRICULUM.normalize(name)}`;
      if (cells.length !== headings.length || !Number.isInteger(year) || year < 2022 || year > 2099
        || (code && !codePattern.test(code)) || !name || name.length > 160 || !grade || !grades.includes(grade)
        || (units === null && !(grade === "履修中" && !cells[columns.units]))
        || (passing.has(grade) && !(units > 0)) || seen.has(id)) {
        throw new Error(`${index + 2}行目の年度・科目名・評価・単位と重複を確認してください。`);
      }
      seen.add(id);
      return { year, code, name, grade, units };
    });
  }

  function resolveGradeRows(rows, records) {
    const used = new Set();
    return rows.map((row) => {
      const codeKey = row.code ? `${prefix}${row.year}:${row.code}` : null;
      const title = WCV_CURRICULUM.normalize(row.name);
      if (codeKey && records.has(codeKey) && WCV_CURRICULUM.normalize(records.get(codeKey).name) !== title) {
        throw new Error(`${row.year}年度の ${row.code} は台帳の科目名と一致しません。`);
      }
      const candidates = [...records].filter(([, entry]) => entry.year === row.year
        && (!row.code || !entry.code || row.code === entry.code) && WCV_CURRICULUM.normalize(entry.name) === title);
      if ((!codeKey || !records.has(codeKey)) && candidates.length > 1) {
        throw new Error(`${row.year}年度の「${row.name}」は台帳に複数の候補があります。講義コードを確認するか、科目カードで個別に入力してください。`);
      }
      const key = codeKey && records.has(codeKey) ? codeKey : candidates[0]?.[0] || codeKey
        || `${prefix}${row.year}:grades:${crypto.randomUUID()}`;
      const before = records.get(key);
      if (used.has(key)) throw new Error(`「${row.name}」の成績が重複しています。`);
      used.add(key);
      return { key, before, row: { ...row, code: row.code || before?.code || null } };
    });
  }

  async function read(path) {
    const response = await fetch(chrome.runtime.getURL(path));
    if (!response.ok) throw new Error("Academic data unavailable");
    return response.json();
  }

  async function initialize(stored) {
    const root = $("academic-ledger");
    const status = el("p");
    status.setAttribute("role", "status");
    status.tabIndex = -1;
    try {
      const [guides, progression, programData] = await Promise.all([
        read("data/undergraduate-guides.json"), read("data/progression-rules.json"),
        WCV_PLANNER_PROGRAMS.load()
      ]);
      const cohorts = new Map(guides.profiles.map((row) => [`${row.year}:${row.department}`, row]));
      const data = new Map(Object.entries(stored).filter(([key, row]) => key.startsWith(prefix) && row));
      let programs = stored[WCV_CURRICULUM.settingsKey];
      let initial = stored[profileKey] || {};
      if (initial.through && !initial.cutoffs) {
        status.textContent = "進級の集計年度が年次別になりました。以前に指定した年度は、該当する進級先の欄に設定し直せます。";
      }
      const choices = [["", "入学年度と学科を選択"], ...[...cohorts].reverse().map(([id, row]) =>
        [id, `${row.year}年度・${row.department}`])];
      const cohort = select("cohort", choices, initial.cohort || programs?.cohort || stored["planner-guide:profile"] || "");
      const course = select("course", []);
      const cutoffs = new Map([[3, input("through", "", "number")], [4, input("through4", "", "number")]]);
      for (const control of cutoffs.values()) {
        Object.assign(control, { min: "2022", max: "2099", step: "1", placeholder: "標準の年度末" });
      }
      const controls = el("div");
      controls.className = "credit-inputs";
      controls.append(field("入学年度と学科", cohort), field("卒業要件のコース", course));
      for (const [stage, control] of cutoffs) controls.append(field(`${stage}年次進級の集計対象（年度末）`, control));
      const profile = el("div");
      profile.className = "academic-card";
      const programStatus = el("p");
      const profileLink = el("a", "ひらめき・教職・TAPの参加状況を設定");
      profileLink.href = "#programs-title";
      profile.append(el("h3", "入学年度・所属とプログラム"), controls, programStatus, profileLink);

      const summary = el("div");
      summary.className = "academic-summary";
      summary.setAttribute("aria-live", "polite");
      const results = el("ul");
      results.id = "academic-records";
      results.className = "academic-list";
      const listCard = el("div");
      listCard.className = "academic-card";
      const yearFilter = select("yearFilter", [["", "すべての開講年度"]]);
      const gradeFilter = select("gradeFilter", [["", "すべての評価"], ["unconfirmed", "未確認・履修中"], ["pass", "合格・認定"], ["fail", "不可・欠席"]]);
      const filters = el("div");
      filters.className = "credit-inputs";
      filters.append(field("開講年度", yearFilter), field("評価の状態", gradeFilter));
      const more = button("さらに表示");
      const recordsTitle = el("h3", "履修台帳");
      recordsTitle.id = "academic-records-title";
      recordsTitle.tabIndex = -1;
      listCard.append(recordsTitle, filters, results, more);

      const imports = el("details");
      imports.className = "academic-card";
      imports.append(el("summary", "成績表の内容をまとめて読み込む"));
      const form = el("form");
      const paste = el("textarea");
      paste.rows = 5;
      paste.maxLength = 160000;
      paste.required = true;
      paste.placeholder = "年度\t講義コード\t授業名\t評価\t単位\n2025\tsaa001102\t科目名\t優\t2";
      const preview = el("p");
      preview.setAttribute("role", "status");
      const importButton = button("確認して履修台帳に保存");
      importButton.hidden = true;
      form.append(el("p", "成績照会の内容を見出しごと貼り付けます。必要な列は年度（または修得期）・科目名・評価・単位です。講義コードの列がある場合は照合に使います。同名で候補が絞れない場合は科目カードで入力できます。"),
        field("成績表のタブ区切りデータ", paste), button("読み込む内容を確認", "submit"), preview, importButton);
      imports.append(form);
      const custom = el("details");
      custom.className = "academic-card";
      custom.append(el("summary", "成績表の科目を1件追加"));
      const customForm = el("form");
      customForm.className = "credit-inputs";
      const newYear = input("year", "", "number");
      Object.assign(newYear, { min: "2022", max: "2099", step: "1", required: true });
      const newCode = input("code");
      newCode.maxLength = 10;
      const newName = input("name");
      Object.assign(newName, { maxLength: 160, required: true });
      customForm.append(field("開講年度", newYear), field("講義コード（任意）", newCode), field("授業名", newName), button("科目を追加", "submit"));
      custom.append(customForm);
      root.append(profile, source("大学ポータルの成績照会", "https://websrv.tcu.ac.jp/tcu_web_v3"),
        el("p", "履修台帳の科目カードを開き、大学ポータルの成績照会に沿って成績と単位を入力してください。"),
        status, summary, imports, custom, listCard);

      let limit = 24;
      let additionsPending = false;
      const current = () => cohorts.get(cohort.value);
      const template = () => current()?.graduationTemplates?.find((item) => item.id === course.value);
      const categoryKey = () => `${cohort.value}:${course.value}`;
      const choice = [["", "要確認"], ["yes", "算入する"], ["no", "算入しない"]];
      const entries = () => [...data].sort(([, a], [, b]) => b.year - a.year || a.name.localeCompare(b.name, "ja"));
      const persist = (changes) => chrome.storage.local.set(changes);
      const locked = (callback) => navigator.locks.request("wcv-academic-records", callback);

      function renderSummary() {
        const records = [...data.values()];
        const forGraduation = calculate(records, "graduation", null);
        const linked = programs?.cohort === cohort.value ? programs : {};
        programStatus.textContent = Object.entries(WCV_CURRICULUM.programNames).map(([key, label]) =>
          `${label} ${linked[key] === "yes" ? "あり" : linked[key] === "no" ? "なし" : "未設定"}`).join(" ／ ");
        const active = current();
        const display = (units) => `${units / 100}単位`;
        const metric = (title, units) => {
          const card = el("section");
          card.className = "academic-card";
          card.append(el("h3", title));
          if (units !== undefined) card.append(el("strong", `算入を確認済み ${display(units)}`));
          return card;
        };
        const progressCard = metric("進級の総単位");
        const graduationCard = metric("卒業要件の単位", forGraduation.total);
        const warnings = new Set(forGraduation.conflicts);
        const difference = (limit, total, kind) => {
          const delta = kind === "maximum" ? total - limit : limit - total;
          return delta > 0 ? `${display(delta)}${kind === "maximum" ? "超過" : "不足"}`
            : kind === "maximum" ? "入力済み単位は上限内" : "この単位条件に到達";
        };
        for (const rule of progression.profiles[cohort.value] || []) {
          const control = cutoffs.get(rule.stage);
          const override = control.value && control.validity.valid ? control.valueAsNumber : undefined;
          const endYear = progressionCutoff(active.year, rule.stage, override);
          const counted = calculate(records, "progression", endYear);
          for (const conflict of counted.conflicts) warnings.add(conflict);
          const row = el("p", `${rule.stage}年次 ／ ${endYear}年度末 ／ 算入を確認済み ${display(counted.total)} ／ ${rule.minimum}単位以上 ／ ${difference(rule.minimum * 100, counted.total)} `);
          row.append(source("原表", `${rule.url || active.sources[0].url}#page=${rule.page}`));
          progressCard.append(row);
        }
        if (!progression.profiles[cohort.value]?.length) progressCard.append(el("p", "総単位条件は学修要覧を確認してください。"));
        progressCard.append(el("p", "各進級の年度末までに修得した単位を集計します。休学・留年などで時期が異なる場合は、上の年度を変更できます。"));
        if (template()) {
          const list = el("ul");
          for (const rule of template().rules) {
            const counted = rule.id === "total" ? forGraduation.total : forGraduation.eligible.filter((row) =>
              row.categories?.[categoryKey()]?.includes(rule.id)).reduce((sum, row) => sum + row.units, 0);
            const item = el("li", `${rule.title} ／ ${rule.units}単位${rule.kind === "maximum" ? "以下" : "以上"} ／ ${display(counted)}を確認 ／ ${difference(rule.units * 100, counted, rule.kind)}`);
            list.append(item);
          }
          graduationCard.append(source("学修要覧の原表", `${active.sources[0].url}#page=${template().sourcePage}`), list);
        } else {
          graduationCard.append(el("p", "入学年度・学科・コースを選ぶと、要覧の単位条件を表示します。"));
        }
        graduationCard.append(el("p", "科目カードで選んだ区分を集計します。必修科目の内訳、算入上限、在学期間などは学修要覧で確認してください。"));
        const pending = records.filter((row) => !row.grade || row.grade === "履修中"
          || (passing.has(row.grade) && (!completed(row) || !row.graduation || !row.progression))).length;
        summary.replaceChildren(progressCard, graduationCard);
        if (pending) summary.append(el("p", `成績・単位・算入の確認が必要な科目 ${pending}件`));
        if (warnings.size) summary.append(el("p", `同名または同じ講義コードの算入候補 ${warnings.size}件を集計から保留しています。算入する履歴を成績表で確認してください。`));
      }

      function recordCard(key, row) {
        const item = el("li");
        item.className = "academic-record";
        const heading = el("strong", row.name);
        const gradeLabel = row.grade ? (passing.has(row.grade) && row.grade !== "認定" ? `合格・${row.grade}` : row.grade)
          : row.origin === "webclass" ? "WebClassの参加履歴・成績未確認" : "成績未確認";
        const state = el("span", gradeLabel);
        state.className = "academic-state";
        state.dataset.grade = row.grade === "認定" ? "recognized" : passing.has(row.grade) ? "passed"
          : ["不可", "欠席"].includes(row.grade) ? "failed" : "pending";
        const unitLabel = completed(row) ? ` ／ 修得 ${row.units / 100}単位` : "";
        item.append(state, heading, el("p", `${row.year}年度・${row.code || "講義コード未入力"}${unitLabel}`));
        if (row.registrationContext) item.append(el("p", row.registrationContext));
        const flags = programs?.cohort === cohort.value ? WCV_CURRICULUM.programMatches(...programData, programs, row.name) : [];
        for (const flag of flags) item.append(source(WCV_CURRICULUM.programLabel(flag), flag.url));
        const editor = el("details");
        editor.append(el("summary", "成績・単位・算入を編集"));
        const edit = el("form");
        edit.className = "credit-inputs";
        const grade = select("grade", grades.map((value) => [value, value || "未確認"]), row.grade);
        const units = input("units", Number.isInteger(row.units) ? row.units / 100 : "", "number");
        Object.assign(units, { min: "0", max: "99", step: "0.01" });
        const graduation = select("graduation", choice, row.graduation);
        const next = select("progression", choice, row.progression);
        edit.append(field("成績", grade), field("単位", units), field("卒業への算入", graduation), field("進級への算入", next));
        const categories = template()?.rules.filter((rule) => rule.id !== "total") || [];
        if (categories.length) {
          const group = el("fieldset");
          group.className = "academic-categories";
          group.append(el("legend", "成績表と学修要覧で確認した卒業区分"));
          for (const rule of categories) {
            const check = input("categories", rule.id, "checkbox");
            check.checked = row.categories?.[categoryKey()]?.includes(rule.id) || false;
            group.append(field(rule.title, check));
          }
          edit.append(group);
        }
        edit.append(button("成績と算入を保存", "submit"));
        edit.addEventListener("submit", async (event) => {
          event.preventDefault();
          const amount = toUnits(units.value);
          if (passing.has(grade.value) && !(amount > 0)) {
            status.textContent = "合格・認定した科目は成績表の単位数を入力してください。";
            units.focus();
            return;
          }
          const updates = { grade: grade.value, units: amount, graduation: graduation.value, progression: next.value };
          if (categories.length) updates.categories = { ...row.categories,
            [categoryKey()]: new FormData(edit).getAll("categories") };
          try {
            await locked(async () => {
              const latest = (await chrome.storage.local.get(key))[key];
              if (latest) await persist({ [key]: { ...latest, ...updates } });
            });
            status.textContent = `${row.name}の成績と算入を保存しました。`;
            status.focus({ preventScroll: true });
          } catch {
            status.textContent = "成績を保存できませんでした。";
          }
        });
        editor.append(edit);
        editor.addEventListener("toggle", () => {
          if (!editor.open && additionsPending && !results.querySelector("details[open]")) renderRecords();
        });
        item.append(editor);
        return item;
      }

      function renderRecords() {
        additionsPending = false;
        const previous = yearFilter.value;
        const years = [...new Set(entries().map(([, row]) => String(row.year)))];
        yearFilter.replaceChildren(new Option("すべての開講年度", ""), ...years.map((year) => new Option(year)));
        if (years.includes(previous)) yearFilter.value = previous;
        const selected = entries().filter(([, row]) => (!yearFilter.value || String(row.year) === yearFilter.value)
          && (!gradeFilter.value || (gradeFilter.value === "pass" && passing.has(row.grade))
            || (gradeFilter.value === "fail" && ["不可", "欠席"].includes(row.grade))
            || (gradeFilter.value === "unconfirmed" && (!row.grade || row.grade === "履修中"))));
        results.replaceChildren(...selected.slice(0, limit).map(([key, row]) => recordCard(key, row)));
        if (!selected.length) results.append(el("li", "表示する履修記録がありません。"));
        more.hidden = selected.length <= limit;
      }

      function applyProfile() {
        const previous = course.value;
        course.replaceChildren(new Option("コースを選択", ""), ...(current()?.graduationTemplates || [])
          .map((item) => new Option(item.name, item.id)));
        const target = initial.cohort === cohort.value ? initial.course || previous : "";
        if (target && [...course.options].some((option) => option.value === target)) course.value = target;
        else if (course.options.length === 2) course.selectedIndex = 1;
        for (const [stage, control] of cutoffs) {
          const active = current();
          control.value = initial.cohort === cohort.value ? initial.cutoffs?.[stage] || "" : "";
          control.placeholder = active ? String(progressionCutoff(active.year, stage)) : "標準の年度末";
        }
      }

      async function saveProfile() {
        initial = { cohort: cohort.value, course: course.value, cutoffs: Object.fromEntries(
          [...cutoffs].map(([stage, control]) => [stage, control.validity.valid ? control.value : ""])) };
        try {
          await persist({ [profileKey]: initial });
        } catch {
          status.textContent = "所属を保存できませんでした。";
        }
        renderSummary();
        renderRecords();
      }

      cohort.addEventListener("change", () => { applyProfile(); saveProfile(); });
      for (const control of [course, ...cutoffs.values()]) control.addEventListener("change", saveProfile);
      for (const control of [yearFilter, gradeFilter]) {
        control.addEventListener("change", () => { limit = 24; renderRecords(); });
      }
      more.addEventListener("click", () => { limit += 24; renderRecords(); });
      applyProfile();
      renderSummary();
      renderRecords();

      let reviewedRows = null;
      paste.addEventListener("input", () => { reviewedRows = null; importButton.hidden = true; preview.textContent = ""; });
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        try {
          reviewedRows = readGradeRows(paste.value);
          resolveGradeRows(reviewedRows, data);
          const received = reviewedRows.filter((row) => passing.has(row.grade)).length;
          preview.textContent = `${reviewedRows.length}件（合格・認定 ${received}件）を確認しました。同じ年度・講義コード、または年度内で特定できる同名科目を更新します。算入を科目カードで確認してください。`;
          importButton.hidden = false;
        } catch (error) {
          preview.textContent = error.message;
          reviewedRows = null;
          importButton.hidden = true;
        }
      });
      importButton.addEventListener("click", async () => {
        if (!reviewedRows) return;
        const rows = reviewedRows;
        importButton.disabled = true;
        try {
          await locked(async () => {
            const previous = new Map(Object.entries(await chrome.storage.local.get(null)).filter(([key, row]) => key.startsWith(prefix) && row));
            const resolved = resolveGradeRows(rows, previous);
            const records = Object.fromEntries(resolved.map(({ key, before, row }) => {
              const unchanged = before?.grade === row.grade && before.units === row.units
                && WCV_CURRICULUM.normalize(before.name) === WCV_CURRICULUM.normalize(row.name);
              return [key, { ...before, ...row, origin: "grades",
                graduation: unchanged ? before.graduation : "", progression: unchanged ? before.progression : "",
                categories: unchanged ? before.categories || {} : {} }];
            }));
            await persist(records);
          });
          preview.textContent = `${rows.length}件の成績を保存しました。`;
          importButton.hidden = true;
          paste.value = "";
          reviewedRows = null;
        } catch (error) {
          preview.textContent = error.message || "成績を取り込めませんでした。";
        } finally {
          importButton.disabled = false;
        }
      });

      customForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const code = newCode.value.trim().normalize("NFKC").toLowerCase();
        const name = newName.value.trim();
        const year = newYear.valueAsNumber;
        if (!name || !Number.isInteger(year) || year < 2022 || year > 2099 || (code && !codePattern.test(code))) {
          status.textContent = "授業名と講義コードを確認してください。";
          return;
        }
        const key = `${prefix}${year}:${code || "manual:" + crypto.randomUUID()}`;
        try {
          await locked(async () => {
            if ((await chrome.storage.local.get(key))[key]) throw new Error("duplicate");
            await persist({ [key]: { code: code || null, year, name, origin: "manual" } });
          });
          customForm.reset();
          status.textContent = `${name}を追加しました。科目カードで成績を入力できます。`;
        } catch {
          status.textContent = "追加できませんでした。履修台帳に同じ年度・講義コードがある場合は既存の科目を編集してください。";
        }
      });

      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        let changed = false;
        let additionsOnly = true;
        for (const [key, { newValue }] of Object.entries(changes)) {
          if (key === WCV_CURRICULUM.settingsKey) {
            additionsOnly = false;
            programs = newValue;
            if (cohorts.has(programs?.cohort) && !cohort.value) {
              cohort.value = programs.cohort;
              applyProfile();
            }
            changed = true;
          } else if (key.startsWith(prefix)) {
            if (data.has(key) || !newValue) additionsOnly = false;
            if (newValue) data.set(key, newValue);
            else data.delete(key);
            changed = true;
          }
        }
        if (changed) {
          renderSummary();
          if (additionsOnly && results.querySelector("details[open]")) additionsPending = true;
          else renderRecords();
        }
      });

      function importSnapshots(snapshots) {
        return locked(async () => {
          const items = new Map();
          let conflicts = 0;
          for (const {year, courses} of snapshots) {
            for (const row of courses) {
              const raw = WCV_ENROLLMENT_MATCH.registration(row.name);
              if (WCV_ENROLLMENT_MATCH.hasYearConflict(row, year, raw)) {
                conflicts++;
                continue;
              }
              const id = WCV_PLANNER_WEBCLASS.key(year, row);
              if (!id) continue;
              items.set(prefix + id, {
                year, code: row.code, name: raw.title || row.name, origin: "webclass",
                registrationContext: raw.context
              });
            }
          }
          const existing = await chrome.storage.local.get(null);
          const known = new Set(Object.entries(existing)
            .filter(([key, row]) => key.startsWith(prefix) && row?.code)
            .map(([, row]) => `${row.year}:${row.code}`));
          const additions = Object.fromEntries([...items].filter(([key, row]) =>
            !existing[key] && !known.has(`${row.year}:${row.code}`)));
          const added = Object.keys(additions).length;
          if (added) await persist(additions);
          return { added, conflicts, existing: items.size - added };
        });
      }
      return { importSnapshots, importSnapshot: (snapshot) => importSnapshots([snapshot]) };
    } catch {
      root.replaceChildren(el("p", "履修台帳を読み込めませんでした。プランナーを開き直してください。"));
      const unavailable = () => { throw new Error("Academic ledger unavailable"); };
      return { importSnapshots: unavailable, importSnapshot: unavailable };
    }
  }

  globalThis.WCV_PLANNER_ACADEMIC = { initialize, calculate, progressionCutoff, readGradeRows };
})();
