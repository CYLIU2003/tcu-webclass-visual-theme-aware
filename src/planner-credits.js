(() => {
  "use strict";

  const profileKey = "planner-credit:profile";
  const priorKey = "planner-credit:prior";
  const entryPrefix = "planner-credit:course:";
  const categories = [
    ["liberal", "教養科目"], ["sports", "体育科目"], ["language", "外国語科目"],
    ["foundation", "情報工学基盤科目"], ["major", "専門科目"],
    ["recognized", "卒業要件に加算される特別履修"]
  ];
  const thresholds = {
    "it-general": [10, 1, 8, 33, 60, 12],
    "it-international": [10, 1, 12, 33, 60, 8]
  };
  const states = [["planned", "見込み"], ["earned", "取得済み"], ["excluded", "集計対象外（不可・取消など）"]];
  const $ = (id) => document.getElementById(id);
  const toUnits = (value) => Number.isInteger(value) && value >= 0 && value <= 99900 ? value : 0;
  const display = (value) => String(value / 100);

  function node(tag, text) {
    const result = document.createElement(tag);
    result.textContent = text;
    return result;
  }

  function field(label, input) {
    const wrapper = node("label", label);
    wrapper.append(input);
    return wrapper;
  }

  function amountInput(value) {
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = "999";
    input.step = "0.01";
    input.inputMode = "decimal";
    input.value = value ? display(toUnits(value)) : "";
    return input;
  }

  function select(options, selected) {
    const input = document.createElement("select");
    for (const [value, label] of options) input.append(new Option(label, value));
    if (options.some(([value]) => value === selected)) input.value = selected;
    return input;
  }

  function backupChanges(file, planPrefix, getCourse) {
    if (file?.format !== "webclass-visual-planner" || file.version !== 1
      || file.plan !== planPrefix || !file.records || typeof file.records !== "object" || Array.isArray(file.records)) {
      throw new Error("Unsupported backup");
    }
    const amounts = new Set(categories.map(([key]) => key));
    const result = {};
    const validUnits = (value) => toUnits(value) === value;
    const validCourse = (code) => /^[a-z][a-z0-9]{4,14}$/.test(code) && Boolean(getCourse(code));
    for (const [key, value] of Object.entries(file.records)) {
      if (key.startsWith(planPrefix) && validCourse(key.slice(planPrefix.length)) && value === true) {
        result[key] = true;
      } else if (key === profileKey && (value === "manual" || Object.hasOwn(thresholds, value))) {
        result[key] = value;
      } else if ([priorKey + ":manual", priorKey + ":it"].includes(key) && value && typeof value === "object" && !Array.isArray(value)) {
        const fields = Object.entries(value);
        const valid = fields.every(([category, units]) =>
          (key.endsWith(":manual") ? category === "total" : amounts.has(category)) && validUnits(units));
        if (!valid) throw new Error("Invalid prior credits");
        result[key] = Object.fromEntries(fields);
      } else if (key.startsWith(entryPrefix + planPrefix) && validCourse(key.slice((entryPrefix + planPrefix).length))
        && states.some(([status]) => value?.status === status) && validUnits(value.units)
        && (value.category === "" || amounts.has(value.category))) {
        result[key] = { status: value.status, units: value.units, category: value.category };
      } else if (WCV_PLANNER_TASKS.valid(key, value)) {
        result[key] = { title: value.title, date: value.date, course: value.course, done: value.done };
      } else if (WCV_PLANNER_GUIDES.valid(key, value)) {
        result[key] = WCV_PLANNER_GUIDES.backupRecord(value, getCourse);
      } else {
        throw new Error("Invalid backup record");
      }
    }
    return result;
  }

  function initialize(data, planPrefix, getCourse) {
    let changesPending = 0;
    const stored = { ...data };
    const profile = $("credit-profile");
    const courseList = $("credit-courses");
    const entryKey = (code) => entryPrefix + planPrefix + code;
    const courses = () => Object.keys(stored)
      .filter((key) => key.startsWith(planPrefix) && stored[key] === true)
      .map((key) => key.slice(planPrefix.length));

    async function save(control, values) {
      control.disabled = true;
      changesPending++;
      try {
        await chrome.storage.local.set(values);
        $("credit-status").textContent = "単位の記録を保存しました。";
      } catch {
        $("credit-status").textContent = "保存できませんでした。もう一度お試しください。";
      } finally {
        changesPending--;
        control.disabled = false;
      }
    }

    function renderSummary() {
      const mode = profile.value;
      const official = thresholds[mode];
      const prior = stored[priorKey + (official ? ":it" : ":manual")] || {};
      const earned = new Map(categories.map(([key]) => [key, toUnits(prior[key])]));
      const planned = new Map();
      let earnedTotal = official ? [...earned.values()].reduce((sum, amount) => sum + amount, 0) : toUnits(prior.total);
      let plannedTotal = 0;
      let unentered = 0;
      let unclassified = 0;
      for (const code of courses()) {
        const entry = stored[entryKey(code)];
        if (entry?.status === "excluded") continue;
        const units = toUnits(entry?.units);
        if (!units) {
          unentered++;
          continue;
        }
        const sum = entry.status === "earned" ? earned : planned;
        if (entry.status === "earned") earnedTotal += units;
        else plannedTotal += units;
        if (!earned.has(entry.category)) unclassified += units;
        else sum.set(entry.category, (sum.get(entry.category) || 0) + units);
      }
      $("credit-summary").replaceChildren(
        node("strong", `取得済み ${display(earnedTotal)}単位`),
        node("strong", `見込みを含む ${display(earnedTotal + plannedTotal)}単位`),
        node("span", `単位未入力 ${unentered}件${official ? ` · 区分未設定 ${display(unclassified)}単位` : ""}`)
      );
      $("credit-progress").hidden = !official;
      $("credit-note").hidden = !official;
      $("credit-free-note").hidden = !official;
      if (!official) return;

      let freeEarned = earned.get("recognized");
      let freeForecast = freeEarned + (planned.get("recognized") || 0);
      const rows = categories.slice(0, 5).map(([key, label], index) => {
        const minimum = official[index] * 100;
        const completed = earned.get(key);
        const forecast = completed + (planned.get(key) || 0);
        freeEarned += Math.max(0, completed - minimum);
        freeForecast += Math.max(0, forecast - minimum);
        return [label, minimum, completed, forecast];
      });
      rows.push(["自由選択", official[5] * 100, freeEarned, freeForecast]);
      $("credit-progress-rows").replaceChildren(...rows.map(([label, minimum, completed, forecast]) => {
        const row = document.createElement("tr");
        const heading = node("th", label);
        heading.scope = "row";
        row.append(heading, ...[minimum, completed, forecast, Math.max(0, minimum - forecast)].map(value => node("td", display(value))));
        return row;
      }));
    }

    function renderPrior() {
      const official = Boolean(thresholds[profile.value]);
      const key = priorKey + (official ? ":it" : ":manual");
      const prior = stored[key] || {};
      $("prior-credit-inputs").replaceChildren(...(official ? categories : [["total", "取得済みの合計"]]).map(([name, label]) => {
        const input = amountInput(prior[name]);
        input.name = name;
        return field(`${label}（単位）`, input);
      }));
    }

    function renderCourses() {
      const rows = courses().map((code) => {
        const entry = stored[entryKey(code)] || {};
        const item = document.createElement("li");
        const form = document.createElement("form");
        const title = node("strong", `${getCourse(code)?.courseName || "授業名未登録"}（${code}）`);
        const wrapper = document.createElement("div");
        wrapper.className = "credit-inputs";
        const status = select(states, entry.status);
        const units = amountInput(entry.units);
        const category = select([["", "区分を指定しない"], ...categories], entry.category);
        wrapper.append(field("取得状況", status), field("単位数", units), field("科目区分", category));
        const submit = node("button", "この授業の単位を保存");
        form.append(title, wrapper, submit);
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          save(submit, { [entryKey(code)]: {
            status: status.value, units: Math.round(Number(units.value) * 100), category: category.value
          } });
        });
        item.append(form);
        return item;
      });
      courseList.replaceChildren(...(rows.length ? rows : [node("li", "時間割の検索結果から授業を追加すると、ここに表示されます。")]));
    }

    function syncProfile() {
      profile.value = Object.hasOwn(thresholds, stored[profileKey]) ? stored[profileKey] : "manual";
    }

    syncProfile();
    profile.addEventListener("change", async () => {
      const selected = profile.value;
      await save(profile, { [profileKey]: selected });
      syncProfile();
      renderPrior();
      renderSummary();
    });
    $("prior-credit-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const amounts = Object.fromEntries([...new FormData(event.currentTarget)]
        .map(([key, value]) => [key, Math.round(Number(value) * 100)]));
      save(event.submitter, { [priorKey + (thresholds[profile.value] ? ":it" : ":manual")]: amounts });
    });
    $("backup-download").addEventListener("click", () => {
      const records = Object.fromEntries(Object.entries(stored).filter(([key, value]) => value !== undefined &&
        ([profileKey, priorKey + ":manual", priorKey + ":it"].includes(key)
          || (key.startsWith(planPrefix) && value === true && getCourse(key.slice(planPrefix.length)))
          || (key.startsWith(entryPrefix + planPrefix) && getCourse(key.slice((entryPrefix + planPrefix).length)))
          || WCV_PLANNER_TASKS.valid(key, value) || WCV_PLANNER_GUIDES.valid(key, value))));
      const file = new Blob([JSON.stringify({ format: "webclass-visual-planner", version: 1, plan: planPrefix, records }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = "webclass-visual-planner.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    $("backup-restore").addEventListener("submit", async (event) => {
      event.preventDefault();
      const file = $("backup-file").files[0];
      const control = event.submitter;
      control.disabled = true;
      try {
        if (!file || file.size > 2_000_000) throw new Error("Invalid backup size");
        const changes = backupChanges(JSON.parse(await file.text()), planPrefix, getCourse);
        await chrome.storage.local.set(changes);
        $("backup-status").textContent = "バックアップの記録を読み込みました。";
        $("backup-file").value = "";
      } catch {
        $("backup-status").textContent = "読み込めませんでした。この年度のプランナーから書き出したファイルを確認してください。";
      } finally {
        control.disabled = false;
      }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      const entries = Object.entries(changes).filter(([key]) => key.startsWith(planPrefix) || key.startsWith("planner-credit:") || key.startsWith("planner-task:") || key.startsWith("planner-guide:"));
      if (!entries.length) return;
      for (const [key, change] of entries) stored[key] = change.newValue;
      if (!changesPending && (changes[profileKey] || Object.keys(changes).some((key) => key.startsWith(priorKey)))) {
        syncProfile();
        renderPrior();
      }
      if (entries.some(([key]) => key.startsWith(planPrefix)) || (!changesPending && entries.some(([key]) => key.startsWith(entryPrefix)))) {
        renderCourses();
      }
      renderSummary();
    });
    renderPrior();
    renderCourses();
    renderSummary();
  }

  globalThis.WCV_PLANNER_CREDITS = { initialize, entryPrefix };
})();
