(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const format = (value) => String(value / 100);

  function element(tag, text) {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  }

  function amount(input) {
    return input.value !== "" && input.validity.valid ? Math.round(input.valueAsNumber * 100) : null;
  }

  function link(label, url) {
    const anchor = element("a", label);
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    return anchor;
  }

  async function index(path) {
    const response = await fetch(chrome.runtime.getURL(path));
    if (!response.ok) throw new Error("Missing data");
    return response.json();
  }

  async function progressionPanel(stored, inputs) {
    const [guides, progression] = await Promise.all([
      index("data/undergraduate-guides.json"), index("data/progression-rules.json")
    ]);
    const byId = new Map(guides.profiles.map((row) => [`${row.year}:${row.department}`, row]));
    const stage = $("enrollment-stage");
    const earned = $("enrollment-earned");
    const result = $("enrollment-result");
    const source = $("enrollment-source");
    let programs = stored[WCV_CURRICULUM.settingsKey];
    let overrideKey = "";
    const resetBase = $("enrollment-earned-reset");
    function render() {
      const cohort = programs?.cohort ?? stored["academic-profile"]?.cohort ?? stored["planner-guide:profile"];
      const row = byId.get(cohort);
      const flags = Object.entries(WCV_CURRICULUM.programNames).map(([key, label]) =>
        label + " " + (programs?.[key] === "yes" ? "あり" : programs?.[key] === "no" ? "なし" : "未設定"));
      const templates = row?.graduationTemplates || [];
      const academic = stored["academic-profile"];
      const track = templates.find((entry) => academic?.cohort === cohort && entry.id === academic.course)
        || (templates.length === 1 ? templates[0] : null);
      $("enrollment-affiliation").textContent = row ? [row.year + "年度入学", row.faculty, row.department, track?.name, ...flags].filter(Boolean).join(" ／ ")
        : "所属の設定で入学年度と学科を選んでください。";
      const rule = progression.profiles[cohort]?.find((entry) => entry.stage === Number(stage.value));
      const values = inputs.map(amount);
      const unentered = values.filter((value) => value === null).length;
      const loaded = !$("enrollment-content").hidden;
      const cutoff = row && WCV_PLANNER_ACADEMIC.progressionCutoff(row.year, Number(stage.value),
        academic?.cohort === cohort && academic.cutoffs?.[stage.value] ? Number(academic.cutoffs[stage.value]) : undefined);
      const records = Object.entries(stored).filter(([key]) => key.startsWith("academic-record:")).map(([, value]) => value);
      overrideKey = row ? `progression-earned:${cohort}:${stage.value}:${cutoff}` : "";
      const manual = stored[overrideKey];
      earned.disabled = !row;
      resetBase.hidden = !Number.isInteger(manual);
      const baseUnits = Number.isInteger(manual) ? manual : WCV_PLANNER_ACADEMIC.calculate(records, "progression", cutoff, cohort || "unset").total;
      if (!row || amount(earned) !== baseUnits) earned.value = row ? format(baseUnits) : "";
      const offline = [];
      if (!loaded && row) {
        const excluded = new Set(records.filter((record) => excludeForecast(record, cohort))
          .map((record) => `${record.year}:${record.code}`));
        for (const [key, selected] of Object.entries(stored)) {
          if (selected !== true || !key.startsWith("planner:")) continue;
          const [, year, code] = key.split(":");
          if (Number(year) < row.year || Number(year) > cutoff || excluded.has(`${year}:${code}`)) continue;
          const entry = stored[WCV_PLANNER_CREDITS.entryPrefix + key];
          if (entry?.status === "planned" && Number.isInteger(entry.units) && entry.units >= 0 && entry.units <= 99900) offline.push(entry.units);
        }
      }
      const planned = (loaded ? values : offline).reduce((sum, value) => sum + (value ?? 0), 0);
      const base = amount(earned);
      source.replaceChildren();
      if (row) {
        const url = rule?.url || row.sources[0].url;
        source.append(link(rule ? `進級条件の原表（PDF p.${rule.page}）` : "学修要覧を確認", rule ? `${url}#page=${rule.page}` : url));
      }
      result.replaceChildren(element("strong", loaded ? `入力済みの見込み ${format(planned)}単位`
        : offline.length ? `保存した時間割の見込み ${format(planned)}単位（${offline.length}科目）` : "WebClassの見込み単位は未読込"));
      $("enrollment-forecast").textContent = `見込み合計 ${format(planned)}単位 ／ 未入力 ${unentered}件`;
      if (unentered) result.append(element("span", `見込み単位が未入力 ${unentered}件`));
      if (!row || !rule) {
        result.append(element("p", row ? "この進級先の総単位条件は要覧で確認してください。" : "入学年度と学科を選ぶと、進級条件を表示します。"));
        return;
      }
      result.append(element("strong", `進級条件の総単位 ${rule.minimum}単位`));
      if (base !== null) {
        const minimum = rule.minimum * 100;
        const remaining = Math.max(0, minimum - base - planned);
        const earnedGap = Math.max(0, minimum - base);
        result.append(element("p", `取得済み ${format(base)}単位（総単位まで残り ${format(earnedGap)}単位）`));
        const year = Number($("enrollment-content").dataset.year);
        if ((loaded && year >= row.year && year <= cutoff) || offline.length) {
          result.append(element("p", `入力済みの見込みを含む ${format(base + planned)}単位（総単位まで残り ${format(remaining)}単位）`));
        } else if (loaded) {
          result.append(element("p", `${year}年度の見込みは、対象期間（${row.year}年度〜${cutoff}年度）の範囲外です。`));
        }
      }
      result.append(element("p", "確認しているのは総単位数です。必修・区分別単位・在学期間などの条件と、ポータルの正誤表も確認してください。"));
    }

    function saveBase(value) {
      if (!overrideKey) return;
      const key = overrideKey;
      if (value === null) delete stored[key];
      else stored[key] = value;
      const saving = value === null ? chrome.storage.local.remove(key) : chrome.storage.local.set({ [key]: value });
      render();
      saving.catch(() => { result.append(element("p", "試算用の取得済み単位を保存できませんでした。")); });
    }
    stage.addEventListener("change", render);
    earned.addEventListener("input", () => { if (earned.validity.valid) saveBase(amount(earned)); });
    resetBase.addEventListener("click", () => { saveBase(null); earned.focus(); });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      let changed = false;
      for (const [key, change] of Object.entries(changes)) {
        if (key === WCV_CURRICULUM.settingsKey) {
          programs = change.newValue;
        } else if (key !== "academic-profile" && key !== "planner-guide:profile" && !key.startsWith("academic-record:")
          && !key.startsWith("progression-earned:") && !key.startsWith("planner:") && !key.startsWith(WCV_PLANNER_CREDITS.entryPrefix)) continue;
        if (change.newValue === undefined) delete stored[key];
        else stored[key] = change.newValue;
        changed = true;
      }
      if (changed) render();
    });
    render();
    return render;
  }

  function excludeForecast(record, cohort) {
    const allowance = record.undergraduateAllowances?.[cohort]?.progression;
    return ["不可", "欠席"].includes(record.grade) || allowance === "no"
      || (allowance === "yes" && WCV_PLANNER_ACADEMIC.completed(record));
  }

  async function initialize(stored, catalogYear, catalog) {
    const token = new URLSearchParams(location.search).get("enrollment");
    const status = $("enrollment-status");
    const inputs = [];
    const render = await progressionPanel(stored, inputs);
    if (token !== null && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(token)) {
      status.textContent = "時間割の読み込み先が無効です。WebClassのコース一覧から開き直してください。";
      return;
    }
    status.textContent = "WebClassの時間割を読み込んでいます。";
    try {
      const key = "wcv-enrollment:" + token;
      let snapshot;
      if (token) snapshot = (await chrome.storage.session.get(key))[key];
      else {
        const tabs = await chrome.tabs.query({url: "https://webclass.tcu.ac.jp/*"});
        const snapshots = (await Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id,
          {type: "wcv-read-enrollment"}, {frameId: 0}).catch(() => null)))).filter(Boolean);
        if (snapshots.length > 1) {
          status.textContent = "複数の時間割が開いています。確認したいコース一覧の「履修・進級チェック」を押してください。";
          return;
        }
        snapshot = snapshots[0];
      }
      if (!snapshot) {
        status.textContent = "読み込んだ時間割がありません。WebClassのコース一覧から開き直してください。";
        return;
      }
      const currentYear = snapshot.year === catalogYear;
      const [evidence, courses] = await Promise.all([
        index("data/syllabus-credit-evidence.json"),
        currentYear ? catalog : index("data/historical-course-row-evidence.json")
          .then((history) => history.records.filter((course) => course.academicYear === snapshot.year))
      ]);
      const matching = WCV_ENROLLMENT_MATCH;
      const courseIndex = matching.createIndex(courses);
      let programSettings = stored[WCV_CURRICULUM.settingsKey];

      let matched = 0;
      let byContext = 0;
      const seenCodes = new Set();
      const entries = [];
      const gradedCourses = new Set();
      function indexGrades() {
        gradedCourses.clear();
        const cohort = programSettings?.cohort ?? stored["academic-profile"]?.cohort ?? stored["planner-guide:profile"];
        for (const [key, record] of Object.entries(stored)) {
          if (!key.startsWith("academic-record:") || record?.year !== snapshot.year) continue;
          if (excludeForecast(record, cohort)) {
            gradedCourses.add(key.slice("academic-record:".length));
            if (record.code) gradedCourses.add(`${record.year}:${record.code}`);
          }
        }
      }
      indexGrades();
      const assigned = new Set(snapshot.courses.map((row) => row.code).filter(Boolean));
      const lookupButton = $("enrollment-lookup");
      const lookupStatus = $("enrollment-lookup-status");
      const pending = () => entries.filter((entry) => entry.code && !entry.evidence);
      let lookupRunning = false;
      const syncLookup = () => { lookupButton.disabled = lookupRunning || !pending().length; };
      for (const row of snapshot.courses) {
        if (row.code && seenCodes.has(row.code)) continue;
        if (row.code) seenCodes.add(row.code);
        const match = matching.identify(row, courseIndex, snapshot.term, snapshot.year, currentYear);
        let course = match.course;
        if (course && match.method === "context" && assigned.has(course.courseCode)) course = null;
        if (course && match.method === "context") {
          assigned.add(course.courseCode);
          byContext++;
        }
        if (course && match.method === "code") matched++;
        const item = element("li", "");
        const info = element("div", "");
        const registration = matching.registration(row.name);
        const heading = element("strong", "");
        const matchStatus = element("p", "");
        const unitStatus = element("p", "");
        const programNotes = element("div", "");
        programNotes.className = "undergraduate-only";
        info.append(heading, matchStatus);
        const input = document.createElement("input");
        Object.assign(input, { type: "number", min: "0", max: "999", step: "0.01", inputMode: "decimal" });
        const entry = { code: match.method === "conflict" ? null : row.code || course?.courseCode, course, evidence: null, titles: [] };
        const reset = element("button", "標準値に戻す");
        reset.type = "button";
        const origin = element("span", "");
        const applyPlan = element("button", "");
        applyPlan.type = "button";
        function updateForecast() {
          const manual = stored[entry.overrideKey];
          const plan = stored[`${WCV_PLANNER_CREDITS.entryPrefix}planner:${snapshot.year}:${entry.code}`];
          const graded = gradedCourses.has(`${snapshot.year}:${entry.code}`) || gradedCourses.has(WCV_PLANNER_WEBCLASS.key(snapshot.year, row));
          const excluded = graded || ["earned", "excluded"].includes(plan?.status);
          entry.plannedUnits = plan?.status === "planned" && Number.isInteger(plan.units)
            && plan.units >= 0 && plan.units <= 99900 ? plan.units : null;
          const automatic = excluded ? 0 : entry.evidence?.units ?? entry.plannedUnits;
          const hasOverride = manual === null || Number.isInteger(manual);
          const units = excluded ? 0 : hasOverride ? manual : automatic;
          const value = units == null ? "" : format(units);
          if (input.value !== value) input.value = value;
          input.readOnly = excluded;
          origin.textContent = excluded ? "成績・算入設定から0単位（見込みに含めません）" : hasOverride ? "手動入力" : entry.evidence
            ? "シラバスから自動入力" : entry.plannedUnits !== null ? "時間割の保存値" : "単位数を確認してください";
          reset.hidden = !hasOverride || excluded;
          applyPlan.hidden = entry.plannedUnits === null || excluded || entry.plannedUnits === units;
          if (!applyPlan.hidden) applyPlan.textContent = `保存した予定 ${format(entry.plannedUnits)}単位を見込みに入れる`;
        }
        function saveForecast(value) {
          const key = entry.overrideKey;
          if (value === undefined) delete stored[key];
          else stored[key] = value;
          const write = value === undefined ? chrome.storage.local.remove(key) : chrome.storage.local.set({ [key]: value });
          write.catch(() => { lookupStatus.textContent = "見込み単位を保存できませんでした。"; });
        }
        input.addEventListener("input", () => {
          if (input.readOnly || !input.validity.valid) return;
          saveForecast(amount(input));
          origin.textContent = "手動入力";
          reset.hidden = false;
        });
        reset.addEventListener("click", () => { saveForecast(undefined); updateForecast(); render(); input.focus(); });
        applyPlan.addEventListener("click", () => { saveForecast(entry.plannedUnits); updateForecast(); render(); input.focus(); });
        function showEvidence(found) {
          entry.evidence = found;
          unitStatus.replaceChildren();
          if (found) unitStatus.append(link(`公式シラバス ${format(found.units)}単位`, found.source));
          else unitStatus.textContent = "シラバスの単位数は未確認";
          updateForecast();
        }
        function showMatch(method) {
          const selected = entry.course;
          item.dataset.needsReview = String(!selected);
          item.tabIndex = -1;
          heading.textContent = selected?.courseName || registration.title || row.name;
          const reason = method === "context" ? "授業名・担当・時限で照合"
            : method === "confirmed" ? "候補を選択済み" : selected ? "講義コードで照合" : "時間割データ未照合";
          matchStatus.textContent = entry.code
            ? [entry.code, ...(selected?.instructors || []), reason].join(" ／ ")
            : (method === "conflict" ? "開講年度が一致しません。WebClassの表示年度を確認してください。"
              : match.candidates.length ? `授業名が一致する候補 ${match.candidates.length}件` : "講義コードを照合できません");
          input.setAttribute("aria-label", `${registration.title || row.name}（${entry.code || "コード未照合"}）の見込み単位`);
          entry.titles = selected ? [selected.courseName, ...(selected.aliases || [])] : [registration.title];
          const half = matching.semesterFor(snapshot.term, selected);
          entry.overrideKey = `forecast:${snapshot.year}:${row.registrationId || row.code || row.name}:${entry.code || "unknown"}`;
          entry.cacheKey = `syllabus-units:${snapshot.year}:${entry.code}:${half || "all"}`;
          const cached = stored[entry.cacheKey];
          const available = cached?.checked > Date.now() - 30 * 86400000 ? [...evidence.records, cached.record] : evidence.records;
          const savedEvidence = available.filter((record) =>
            matching.validEvidence(record, snapshot.year, entry.code, entry.titles, half));
          showEvidence(savedEvidence.length && savedEvidence.every((record) => record.units === savedEvidence[0].units)
            ? savedEvidence[0] : null);
        }
        if (!row.code && !course && match.candidates.length) {
          const chooser = element("label", "講義コードを選ぶ");
          const select = document.createElement("select");
          select.append(new Option("候補を選択", ""));
          for (const candidate of match.candidates) {
            const firstMeeting = candidate.meetings?.[0];
            const time = firstMeeting ? `${firstMeeting.day}曜${firstMeeting.period}限` : "";
            const label = [candidate.courseCode, ...(candidate.termBlocks || []), ...(candidate.instructors || []), time].filter(Boolean).join(" ／ ");
            select.append(new Option(label, candidate.courseCode));
          }
          chooser.append(select);
          info.append(chooser);
          select.addEventListener("change", () => {
            if (select.value && assigned.has(select.value) && entry.code !== select.value) {
              select.value = entry.code || "";
              lookupStatus.textContent = "すでに照合済みの講義コードです。別の候補を確認してください。";
              return;
            }
            if (entry.code) assigned.delete(entry.code);
            entry.code = select.value || null;
            entry.course = match.candidates.find((candidate) => candidate.courseCode === entry.code);
            if (entry.code) assigned.add(entry.code);
            input.value = "";
            lookupStatus.textContent = "";
            showMatch(entry.course ? "confirmed" : "");
            syncLookup();
            renderStatus();
            renderPrograms();
            render();
            if (entry.course && !entry.evidence) void autoLookup(entry);
          });
        }
        info.append(programNotes, unitStatus, origin, reset, applyPlan);
        showMatch(match.method);
        const label = element("label", "見込み単位");
        label.append(input);
        item.append(info, label);
        $("enrollment-courses").append(item);
        inputs.push(input);
        entry.showEvidence = showEvidence;
        entry.updateForecast = updateForecast;
        entry.programNotes = programNotes;
        entry.fallbackName = registration.title;
        entries.push(entry);
      }
      if (!inputs.length) {
        $("enrollment-courses").append(element("li", "この表示範囲の時間割にコースがありません。"));
      }
      $("enrollment-all-tip").hidden = false;
      function renderStatus() {
        const unresolved = entries.filter((entry) => !entry.course).length;
        const selected = entries.length - unresolved - matched - byContext;
        status.textContent = `${snapshot.year}年度・${matching.terms[snapshot.term]} ／ WebClassの参加コース ${entries.length}件 ／ 科目の照合 ${entries.length - unresolved}件（うち手動選択 ${selected}件） ／ 科目の要確認 ${unresolved}件`;
      }
      renderStatus();

      if (entries.some(entry => !entry.course)) {
        const jump = element("button", "最初の要確認科目へ");
        jump.type = "button";
        jump.addEventListener("click", () => {
          const first = $("enrollment-courses").querySelector('[data-needs-review="true"]');
          first?.focus();
        });
        $("enrollment-status").after(jump);
        $("enrollment-courses").addEventListener("change", () => {
          jump.hidden = !entries.some(entry => !entry.course);
        });
      }

      async function lookupUnits(requestPermission, lookups = pending()) {
        if (lookupRunning || !lookups.length) return;
        lookupRunning = true;
        syncLookup();
        const selectors = [...$("enrollment-courses").querySelectorAll("select")];
        const total = lookups.length;
        let verified = 0;
        let checked = 0;
        let failed = 0;
        selectors.forEach((select) => { select.disabled = true; });
        try {
          if (requestPermission && !await chrome.permissions.request(matching.permission)) {
            lookupStatus.textContent = "シラバス照会の許可がありません。単位は手入力できます。";
            return;
          }
          lookupStatus.textContent = `公開シラバスを照合しています（0 / ${total}件）。`;
          const check = async () => {
            for (let entry = lookups.shift(); entry; entry = lookups.shift()) {
              try {
                const found = await matching.lookup(snapshot.year, entry.code, entry.titles,
                  matching.semesterFor(snapshot.term, entry.course));
                if (found) {
                  entry.showEvidence(found);
                  const cache = { record: found, checked: Date.now() };
                  stored[entry.cacheKey] = cache;
                  void chrome.storage.local.set({ [entry.cacheKey]: cache }).catch(() => {});
                  render();
                  verified++;
                }
              } catch {
                failed++;
              }
              checked++;
              lookupStatus.textContent = `公開シラバスを照合しています（${checked} / ${total}件）。`;
            }
          };
          await Promise.all([check(), check(), check()]);
          lookupStatus.textContent = `単位数を確認 ${verified}件、未確認 ${total - verified}件。` +
            (failed ? ` うち通信エラー ${failed}件。再照会できます。` : "") +
            (verified ? " 確認できた単位を自動入力しました。手動入力を優先します。" : " 単位は手入力できます。");
        } catch {
          lookupStatus.textContent = "公開シラバスに接続できませんでした。時間をおいてお試しください。";
        } finally {
          selectors.forEach((select) => { select.disabled = false; });
          lookupRunning = false;
          syncLookup();
        }
      }
      lookupButton.addEventListener("click", () => lookupUnits(true));
      syncLookup();

      let programs;
      function renderPrograms() {
        for (const entry of entries) {
          const name = entry.course?.level === "大学院" ? "" : entry.course?.courseName || entry.fallbackName;
          const rows = programs && programSettings?.cohort
            ? WCV_CURRICULUM.programMatches(...programs, programSettings, name) : [];
          entry.programNotes.replaceChildren(...rows.map((row) => {
            const note = element("p", "");
            note.append(link(WCV_CURRICULUM.programLabel(row), row.url), " ― ", row.note);
            return note;
          }));
        }
      }

      WCV_PLANNER_PROGRAMS.load().then((data) => {
        programs = data;
        renderPrograms();
      }).catch(() => {});
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        const change = changes[WCV_CURRICULUM.settingsKey];
        if (change) {
          programSettings = change.newValue;
          renderPrograms();
        }
        const keys = Object.keys(changes).filter((key) => key.startsWith("forecast:") ||
          key.startsWith(WCV_PLANNER_CREDITS.entryPrefix) || key.startsWith("academic-record:"));
        for (const key of keys) {
          if (changes[key].newValue === undefined) delete stored[key];
          else stored[key] = changes[key].newValue;
        }
        if (keys.length || change) {
          const gradesChanged = Boolean(change) || keys.some((key) => key.startsWith("academic-record:"));
          if (gradesChanged) indexGrades();
          for (const entry of entries) {
            if (gradesChanged || keys.includes(entry.overrideKey)
              || keys.includes(`${WCV_PLANNER_CREDITS.entryPrefix}planner:${snapshot.year}:${entry.code}`)) entry.updateForecast();
          }
          render();
        }
      });

      $("enrollment-content").addEventListener("input", render);
      $("enrollment-content").dataset.year = String(snapshot.year);
      $("enrollment-content").hidden = false;
      render();

      async function autoLookup(entry) {
        const allowed = await chrome.permissions.contains(matching.permission).catch(() => false);
        if (allowed) await lookupUnits(false, entry ? pending().filter((candidate) => candidate === entry) : pending());
        else if (pending().length) lookupStatus.textContent = "初回は「公式シラバスで単位を照合」で読取を許可してください。次回から自動で照合します。";
      }
      void autoLookup();
    } catch {
      status.textContent = "時間割または進級条件を読み込めませんでした。WebClassのコース一覧から開き直してください。";
    }
  }

  globalThis.WCV_PLANNER_ENROLLMENT = { initialize };
})();
