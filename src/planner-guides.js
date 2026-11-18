(() => {
  "use strict";

  const profileKey = "planner-guide:profile";
  const prefix = "planner-guide:rule:";
  const profilePattern = /^20[2-9][0-9]:[\p{L}・]{2,30}$/u;
  const rulePattern = /^20[2-9][0-9]:[\p{L}・]{2,30}:(?:[0-9a-f-]{36}|preset-[a-z0-9-]{1,64})$/u;
  const coursePattern = /^[a-z][a-z0-9]{4,14}$/;
  const $ = (id) => document.getElementById(id);
  const amount = (value) => Number.isInteger(value) && value >= 0 && value <= 99900;
  const display = (value) => String(value / 100);
  const units = (value) => Math.round(Number(value) * 100);

  function valid(key, record) {
    if (key === profileKey) return typeof record === "string" && profilePattern.test(record);
    return Boolean(key.startsWith(prefix) && rulePattern.test(key.slice(prefix.length)) && record
      && typeof record.title === "string" && record.title.trim().length > 0 && record.title.length <= 100
      && ["minimum", "maximum"].includes(record.kind) && amount(record.target)
      && (record.courses === undefined || (Array.isArray(record.courses) && record.courses.length <= 500
        && record.courses.every((code) => typeof code === "string" && coursePattern.test(code))
        && new Set(record.courses).size === record.courses.length))
      && [record.earned, record.planned].every((value) => value === null || amount(value)));
  }

  function backupRecord(record, getCourse) {
    if (typeof record === "string") return record;
    const { title, kind, target, earned, planned, courses = [] } = record;
    if (courses.some((code) => !getCourse(code))) throw new Error("Unknown course in requirement record");
    return { title, kind, target, earned, planned, courses };
  }

  function el(tag, text) {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  }

  function select(input, values, placeholder, previous) {
    input.replaceChildren(new Option(placeholder, ""), ...values.map((value) => new Option(value, value)));
    if (values.includes(previous)) input.value = previous;
  }

  function link(text, url) {
    const node = el("a", text);
    node.href = url;
    node.target = "_blank";
    node.rel = "noopener noreferrer";
    return node;
  }

  function amountField(label, name, value) {
    const field = el("label", label);
    const input = document.createElement("input");
    Object.assign(input, { type: "number", name, min: "0", max: "999", step: "0.01", inputMode: "decimal" });
    input.value = value === null ? "" : display(value);
    field.append(input);
    return field;
  }

  function result(record, totals) {
    const measure = (value) => {
      const delta = record.kind === "minimum" ? record.target - value : value - record.target;
      if (delta <= 0) return record.kind === "minimum" ? "必要単位に到達" : "上限内";
      return `${display(delta)}単位${record.kind === "minimum" ? "不足" : "超過"}`;
    };
    const entered = record.earned !== null || record.planned !== null || totals.known > 0;
    if (!entered) return "単位を入力するか、時間割の授業を選んでください。";
    const completed = (record.earned || 0) + totals.earned;
    const forecast = completed + (record.planned || 0) + totals.planned;
    const earned = `取得済み ${measure(completed)}`;
    return record.planned === null && !totals.planned ? earned : `${earned} ／ 見込み込み ${measure(forecast)}`;
  }

  async function initialize(planPrefix, getCourse) {
    try {
      const response = await fetch(chrome.runtime.getURL("data/undergraduate-guides.json"));
      if (!response.ok) throw new Error("Guide index unavailable");
      const data = await response.json();
      if (data.schemaVersion !== 1 || !data.profiles.length) throw new Error("Invalid guide index");
      const stored = await chrome.storage.local.get(null);
      const year = $("guide-year");
      const faculty = $("guide-faculty");
      const department = $("guide-department");
      const status = $("guide-status");
      const ruleStatus = $("guide-rule-status");
      const addForm = $("guide-rule-form");
      const course = $("guide-course");
      const addTemplate = $("guide-template-add");
      const byYear = () => data.profiles.filter((row) => String(row.year) === year.value);
      const id = () => `${year.value}:${department.value}`;
      const active = () => byYear().find((row) => row.faculty === faculty.value && row.department === department.value);
      const formValues = (form) => Object.fromEntries(new FormData(form));
      const creditPrefix = WCV_PLANNER_CREDITS.entryPrefix + planPrefix;
      const planCourses = new Set(Object.keys(stored).filter((key) => key.startsWith(planPrefix) && stored[key] === true)
        .map((key) => key.slice(planPrefix.length)).filter(getCourse));

      function courseTotals(codes) {
        const totals = { earned: 0, planned: 0, known: 0, missing: 0 };
        for (const code of codes) {
          if (!planCourses.has(code)) continue;
          const credit = stored[creditPrefix + code];
          if (credit?.status === "excluded") continue;
          if (!amount(credit?.units) || !credit.units || !["earned", "planned"].includes(credit.status)) {
            totals.missing++;
            continue;
          }
          totals[credit.status] += credit.units;
          totals.known++;
        }
        return totals;
      }

      function courseFields(row, open) {
        const chosen = row.courses || [];
        const details = el("details", "");
        details.className = "guide-mapped-courses";
        details.open = open;
        details.append(el("summary", `時間割の授業を集計（選択 ${chosen.length}件）`));
        function renderChoices() {
          if (!details.open) return;
          const previous = details.querySelector("fieldset");
          const selected = previous ? [...previous.querySelectorAll("input:checked")].map((input) => input.value) : chosen;
          const fieldset = el("fieldset", "");
          fieldset.append(el("legend", "この条件に含める授業"));
          fieldset.append(el("p", "授業別に記録した単位を加算します。選んだ授業の単位はこの条件に重ねて入力しないでください。"));
          const codes = new Set([...planCourses, ...selected]);
          if (!codes.size) fieldset.append(el("p", "先に時間割の検索結果から授業を追加してください。"));
          for (const code of codes) {
            const label = el("label", "");
            const input = document.createElement("input");
            Object.assign(input, { type: "checkbox", name: "course", value: code, checked: selected.includes(code) });
            const course = getCourse(code);
            const name = course?.courseName || "授業";
            const teachers = course?.instructors?.length ? " ／ " + course.instructors.join("・") : "";
            const status = planCourses.has(code) ? "" : "・時間割から削除済み";
            label.append(input, el("span", `${name}（${code}）${teachers}${status}`));
            fieldset.append(label);
          }
          if (previous) previous.replaceWith(fieldset);
          else details.append(fieldset);
        }
        details.addEventListener("toggle", renderChoices);
        details.addEventListener("guide-plan-updated", renderChoices);
        renderChoices();
        return details;
      }

      async function save(button, operation, success) {
        button.disabled = true;
        try {
          await operation();
          ruleStatus.textContent = success;
          return true;
        } catch {
          ruleStatus.textContent = "保存できませんでした。もう一度お試しください。";
          return false;
        } finally {
          button.disabled = false;
        }
      }

      function renderRules(changedKeys = new Set()) {
        const start = prefix + id() + ":";
        const presetKeys = active()?.graduationTemplates?.flatMap((template) =>
          template.rules.map((rule) => `${start}preset-${template.id}-${rule.id}`)) || [];
        const order = new Map(presetKeys.map((key, index) => [key, index]));
        const rows = Object.entries(stored).filter(([key, row]) => key.startsWith(start) && valid(key, row))
          .sort(([left], [right]) => (order.get(left) ?? Infinity) - (order.get(right) ?? Infinity));
        const list = $("guide-rules");
        const previous = new Map([...list.children].map((item) => [item.dataset.key, item]));
        const current = rows.map(([key, row]) => {
          if (previous.has(key) && !changedKeys.has(key)) return previous.get(key);
          const item = el("li", "");
          const heading = el("strong", `${row.title} · ${row.kind === "minimum" ? "必要" : "上限"} ${display(row.target)}単位`);
          const form = el("form", "");
          form.className = "credit-inputs guide-rule-fields";
          form.setAttribute("aria-label", row.title);
          const submit = el("button", "記録を保存");
          submit.className = "guide-primary";
          submit.setAttribute("aria-label", `${row.title}の記録を保存`);
          const remove = el("button", "条件を削除");
          remove.className = "guide-remove";
          remove.setAttribute("aria-label", `${row.title}の条件を削除`);
          remove.type = "button";
          const coursePicker = courseFields(row, previous.get(key)?.querySelector("details")?.open || false);
          form.append(
            amountField("取得済み（単位）", "earned", row.earned), amountField("見込み（単位）", "planned", row.planned),
            coursePicker, submit, remove
          );
          form.addEventListener("submit", (event) => {
            event.preventDefault();
            const values = formValues(form);
            const courses = coursePicker.querySelector("fieldset")
              ? new FormData(form).getAll("course") : (row.courses || []);
            const value = (name) => values[name] === "" ? null : units(values[name]);
            const next = { ...row, earned: value("earned"), planned: value("planned"), courses };
            if (!valid(key, next)) {
              ruleStatus.textContent = "まとめて集計できる授業は500件までです。";
              return;
            }
            save(submit, () => chrome.storage.local.set({
              [key]: next
            }), "単位の記録を保存しました。");
          });
          remove.addEventListener("click", () => {
            if (confirm(`「${row.title}」を削除しますか？`)) {
              save(remove, () => chrome.storage.local.remove(key), "条件を削除しました。");
            }
          });
          const progress = el("p", "");
          progress.className = "guide-rule-result";
          item.append(heading, progress, form);
          item.dataset.key = key;
          updateResult(item, row);
          return item;
        });
        const keep = new Set(current);
        for (const item of previous.values()) {
          if (!keep.has(item)) item.remove();
        }
        for (const [index, item] of current.entries()) {
          if (list.children[index] !== item) list.insertBefore(item, list.children[index] || null);
        }
      }

      function updateResult(item, row) {
        const totals = courseTotals(row.courses || []);
        const note = totals.missing ? ` 単位の確認で未入力の授業 ${totals.missing}件。` : "";
        item.querySelector(".guide-rule-result").textContent = result(row, totals) + note;
      }

      function showProfile() {
        const row = active();
        $("guide-detail").hidden = !row;
        status.textContent = row ? "" : "入学年度・学部・学科を選んでください。";
        if (!row) return;
        const templates = row.graduationTemplates || [];
        $("guide-template").hidden = !templates.length;
        course.replaceChildren(new Option("コースを選択", ""),
          ...templates.map(({ id, name }) => new Option(name, id)));
        if (templates.length === 1) course.value = templates[0].id;
        addTemplate.disabled = !course.value;
        const note = $("guide-template-note");
        note.replaceChildren();
        if (templates.length) {
          const pages = [...new Set(templates.flatMap((template) => [template.sourcePage, ...(template.additionalPages || [])]))];
          for (const page of pages) {
            note.append(link(pages.length > 1 ? `卒業要件の表 p.${page}` : "要覧の卒業要件の表",
              `${row.sources[0].url}#page=${page}`), " ");
          }
          note.append(el("span", "取得済みの単位は成績表で照合してください。卒業には、個別の必修科目や修業年限などの条件もあります。"));
        }
        const labels = { department: "学科の学修要覧", faculty: "学部の学修要覧", common: "共通分野", teaching: "教職課程" };
        $("guide-sources").replaceChildren(...row.sources.map(({ kind, url }) => {
          const item = el("li", "");
          item.append(link(labels[kind], url));
          if (!templates.length && url === row.sources[0].url) {
            for (const page of data.documents[url]?.graduationPages || []) {
              item.append(link(`卒業要件の候補 p.${page}`, `${url}#page=${page}`));
            }
          }
          return item;
        }));
        renderRules();
      }

      const updateDepartments = (previous = "") => {
        select(department, byYear().filter((row) => row.faculty === faculty.value).map((row) => row.department), "学科を選択", previous);
        department.disabled = !faculty.value;
      };
      const updateFaculties = (previous = "") => {
        select(faculty, [...new Set(byYear().map((row) => row.faculty))], "学部を選択", previous);
        faculty.disabled = !year.value;
      };
      function restoreProfile(value) {
        const saved = data.profiles.find((row) => `${row.year}:${row.department}` === value);
        select(year, [...new Set(data.profiles.map((row) => String(row.year)))].reverse(), "入学年度を選択", String(saved?.year ?? stored.webclassAdmissionYear ?? ""));
        updateFaculties(saved?.faculty);
        updateDepartments(saved?.department);
        showProfile();
      }
      restoreProfile(stored[profileKey]);
      year.addEventListener("change", () => { updateFaculties(); updateDepartments(); showProfile(); });
      faculty.addEventListener("change", () => { updateDepartments(); showProfile(); });
      department.addEventListener("change", () => {
        showProfile();
        if (active()) save(department, () => chrome.storage.local.set({ [profileKey]: id() }), "");
      });
      course.addEventListener("change", () => { addTemplate.disabled = !course.value; });
      addTemplate.addEventListener("click", () => {
        const template = active()?.graduationTemplates?.find((item) => item.id === course.value);
        if (!template) return;
        const records = Object.fromEntries(template.rules.flatMap(({ id: ruleId, title, units, kind = "minimum" }) => {
          const key = `${prefix}${id()}:preset-${template.id}-${ruleId}`;
          return stored[key] ? [] : [[key, {
            title: `${template.name}｜${title}`, kind, target: Math.round(units * 100), earned: null, planned: null
          }]];
        }));
        if (Object.keys(records).length) {
          save(addTemplate, () => chrome.storage.local.set(records), "要覧の単位条件を追加しました。");
        } else {
          ruleStatus.textContent = "このコースの条件は追加済みです。";
        }
      });
      addForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!active()) return;
        const values = formValues(addForm);
        const record = { title: values.title.trim(), kind: values.kind, target: units(values.target), earned: null, planned: null };
        const key = prefix + id() + ":" + crypto.randomUUID();
        if (!valid(key, record)) {
          ruleStatus.textContent = "条件名と基準の単位数を入力してください。";
          return;
        }
        if (await save(event.submitter, () => chrome.storage.local.set({ [key]: record }), "条件を追加しました。")) {
          addForm.reset();
          addForm.elements.title.focus();
        }
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        const changed = new Set();
        let creditsChanged = false;
        let planChanged = false;
        const start = prefix + id() + ":";
        for (const [key, { newValue }] of Object.entries(changes)) {
          if (key.startsWith(planPrefix) || key.startsWith(creditPrefix)) {
            stored[key] = newValue;
            if (key.startsWith(planPrefix)) {
              planChanged = true;
              const code = key.slice(planPrefix.length);
              if (newValue === true && getCourse(code)) planCourses.add(code);
              else planCourses.delete(code);
            }
            creditsChanged = true;
            continue;
          }
          if (!key.startsWith(prefix)) continue;
          if (newValue === undefined) delete stored[key];
          else stored[key] = newValue;
          if (key.startsWith(start)) changed.add(key);
        }
        const profile = changes[profileKey];
        if (profile && profile.newValue !== id()) {
          restoreProfile(profile.newValue);
        } else if (changed.size) {
          const focused = document.activeElement;
          const key = focused?.closest("li[data-key]")?.dataset.key;
          const index = focused?.form ? [...focused.form.elements].indexOf(focused) : -1;
          renderRules(changed);
          if (key && changed.has(key) && index >= 0) {
            const replacement = $("guide-rules").querySelector(`li[data-key="${CSS.escape(key)}"] form`);
            (replacement?.elements[index] ?? $("guide-rule-add").querySelector("summary")).focus();
          }
        }
        if (creditsChanged) {
          for (const item of $("guide-rules").children) updateResult(item, stored[item.dataset.key]);
        }
        if (planChanged) {
          for (const details of $("guide-rules").querySelectorAll(".guide-mapped-courses[open]")) {
            details.dispatchEvent(new Event("guide-plan-updated"));
          }
        }
      });
      $("guide-controls").hidden = false;
    } catch {
      $("guide-status").textContent = "索引を読み込めませんでした。";
      $("guide-status").append(" ", link("教学課の学修要覧", "https://www.asc.tcu.ac.jp/syllabus_archives/"));
    }
  }

  globalThis.WCV_PLANNER_GUIDES = { initialize, valid, backupRecord };
})();
