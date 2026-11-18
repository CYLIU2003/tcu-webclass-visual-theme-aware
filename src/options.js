(() => {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    restyle: true,
    appearance: "standard",
    modernizeNativeLayout: true,
    showInlineMetadata: true,
    showDeadlineList: true,
    showSidebarTools: true,
    showFloatingPanel: true,
    showSourceLabel: true,
    userCourses: [],
    curriculumPlan: "",
    webclassAdmissionYear: "",
    curriculumTeaching: false,
    curriculumHirameki: false
  };

  const toggleIds = [
    "enabled",
    "restyle",
    "modernizeNativeLayout",
    "showInlineMetadata",
    "showDeadlineList",
    "showSidebarTools",
    "showFloatingPanel",
    "showSourceLabel"
  ];

  const editor = document.getElementById("jsonEditor");
  const message = document.getElementById("message");
  const overrideCount = document.getElementById("overrideCount");
  const overridePreviewList = document.getElementById("overridePreviewList");
  const datasetSummary = document.getElementById("datasetSummary");
  const datasetQuality = document.getElementById("datasetQuality");
  const savedChip = document.getElementById("savedChip");
  const detailPanel = document.getElementById("detailPanel");
  let chipTimer = 0;

  function flashSaved() {
    savedChip.textContent = "✓ 保存しました";
    savedChip.classList.add("show");
    clearTimeout(chipTimer);
    chipTimer = setTimeout(() => savedChip.classList.remove("show"), 1800);
  }

  function storageGet(defaults) {
    return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
  }

  function storageSet(values) {
    return new Promise((resolve) => chrome.storage.local.set(values, resolve));
  }

  function setMessage(text, kind = "") {
    message.className = `message ${kind}`.trim();
    message.textContent = text;
  }

  function prettyOverrides(courses) {
    return JSON.stringify({ courses: Array.isArray(courses) ? courses : [] }, null, 2);
  }

  function normalizePayload(parsed) {
    const courses = Array.isArray(parsed) ? parsed : parsed?.courses;
    if (!Array.isArray(courses)) {
      throw new Error('最上位は { "courses": [ ... ] }、または科目配列にしてください。');
    }

    const validated = courses.map((course, index) => {
      if (!course || typeof course !== "object" || Array.isArray(course)) {
        throw new Error(`${index + 1}件目の科目がオブジェクトではありません。`);
      }
      if (typeof course.courseName !== "string" || !course.courseName.trim()) {
        throw new Error(`${index + 1}件目に courseName がありません。`);
      }
      if (course.instructors != null && !Array.isArray(course.instructors)) {
        throw new Error(`${course.courseName}: instructors は配列にしてください。`);
      }
      if (course.meetings != null && !Array.isArray(course.meetings)) {
        throw new Error(`${course.courseName}: meetings は配列にしてください。`);
      }

      const meetings = (course.meetings || []).map((meeting, meetingIndex) => {
        if (!meeting || typeof meeting !== "object") {
          throw new Error(`${course.courseName}: meetings[${meetingIndex}] が不正です。`);
        }
        const period = Number(meeting.period);
        if (!meeting.day || !Number.isInteger(period) || period < 1 || period > 9) {
          throw new Error(`${course.courseName}: day と period を確認してください。`);
        }
        return {
          ...meeting,
          day: String(meeting.day).trim(),
          period,
          room: meeting.room == null ? "" : String(meeting.room).trim()
        };
      });

      return {
        ...course,
        courseName: course.courseName.trim(),
        courseCode: course.courseCode ? String(course.courseCode).trim() : undefined,
        aliases: Array.isArray(course.aliases)
          ? course.aliases.map(String).map((value) => value.trim()).filter(Boolean)
          : [],
        instructors: Array.isArray(course.instructors)
          ? course.instructors.map(String).map((value) => value.trim()).filter(Boolean)
          : [],
        meetings
      };
    });

    return validated;
  }

  function updateCount(courses) {
    overrideCount.textContent = `${courses.length}件`;
    renderOverridePreview(courses);
  }

  function renderOverridePreview(courses) {
    if (!overridePreviewList) return;
    overridePreviewList.replaceChildren();
    for (let i = 0; i < courses.length; i += 1) {
      const course = courses[i];
      const item = document.createElement("div");
      item.className = "override-preview-item";
      const main = document.createElement("div");
      main.className = "override-preview-main";
      const heading = document.createElement("strong");
      heading.textContent = course.courseCode ? `${course.courseName} (${course.courseCode})` : course.courseName;
      const details = [];
      const meetings = (course.meetings || []).map((m) => `${m.day}${m.period}${m.room ? ` ${m.room}` : ""}`);
      if (meetings.length) details.push(`時間割: ${meetings.join(" / ")}`);
      if (course.instructors?.length) details.push(`担当: ${course.instructors.join("・")}`);
      const sub = document.createElement("span");
      sub.textContent = details.length ? details.join(" ／ ") : "時間割・担当の指定なし";
      main.append(heading, sub);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "override-remove-btn";
      removeBtn.textContent = "削除";
      removeBtn.addEventListener("click", async () => {
        try {
          const parsed = JSON.parse(editor.value || '{"courses":[]}');
          const current = normalizePayload(parsed);
          current.splice(i, 1);
          editor.value = prettyOverrides(current);
          await storageSet({ userCourses: current });
          updateCount(current);
          setMessage(`「${course.courseName}」の上書きを削除しました。`, "success");
        } catch (error) {
          setMessage(`削除できません: ${error.message}`, "error");
        }
      });

      item.append(main, removeBtn);
      overridePreviewList.append(item);
    }
  }

  async function loadBundledData() {
    try {
      const [data, historyResponse] = await Promise.all([
        globalThis.WCV_DATA ? globalThis.WCV_DATA.load() : fetch(chrome.runtime.getURL("data/timetable-2026.json")).then((r) => r.json()),
        fetch(chrome.runtime.getURL("data/historical-course-row-evidence.json"))
      ]);
      if (!historyResponse.ok) throw new Error(`過年度データ: HTTP ${historyResponse.status}`);
      const history = await historyResponse.json();
      const scope = data.dataset?.scope || {};
      const count = scope.uniqueCourses || (Array.isArray(data.courses) ? data.courses.length : 0);
      const departmentLabels = Array.from(new Set((scope.departments || []).map((item) => item.label).filter(Boolean)));
      const generatedDate = String(data.dataset?.generatedAt || "").slice(0, 10);
      const fallSummary = history.currentFallCandidates?.summary || {};
      const fallOccurrences = Number(fallSummary.sourceOccurrences) || 0;
      const fallReviewed = Number(fallSummary.visuallyReviewedOccurrences) || 0;
      const fallUnmatched = Number(fallSummary.baseSnapshotUnmatchedPairs) || 0;
      const corrCount = Number(history.correctionEvents?.summary?.eventCount) || 0;
      datasetSummary.textContent = `${data.dataset?.title || "時間割データ"}：${count.toLocaleString("ja-JP")}科目（${scope.sourceDocuments?.length || 0}資料・${scope.timetablePages || 0}頁、${departmentLabels.length}学科・研究科区分、${(scope.campuses || []).join("・")}）。2026後期PDF候補${fallOccurrences.toLocaleString("ja-JP")}行（目視確認${fallReviewed}件）と訂正表候補${corrCount}件は別途表示します。旧2,556科目版との照合では${fallUnmatched.toLocaleString("ja-JP")}組が未収録でした。${generatedDate ? `（${generatedDate}生成）` : ""}`;
      const years = Array.isArray(history.summary?.academicYears) ? history.summary.academicYears.join("・") : "";
      const candidates = Number(history.summary?.sourceOccurrences) || 0;
      const reviewed = Number(history.summary?.visuallyReviewedOccurrences) || 0;
      const unreviewed = Number(history.summary?.unreviewedOccurrences) || 0;
      const guideSummary = history.studyGuideNavigation?.summary || {};
      const guideCount = Number(guideSummary.studyGuideCount) || 0;
      const guidePages = Number(guideSummary.totalStudyGuidePages) || 0;
      const guideIndexed = Number(guideSummary.indexedTermPagePairs) || 0;
      const pastText = candidates
        ? `過年度${years || "一部年度"}のPDF掲載行${candidates.toLocaleString("ja-JP")}件を授業詳細に候補表示します（目視確認${reviewed.toLocaleString("ja-JP")}件、未確認${unreviewed.toLocaleString("ja-JP")}件）。`
        : "過年度の時間割行候補はありません。";
      const guideText = guideCount
        ? `2026年度履修要覧${guideCount}冊（計${guidePages.toLocaleString("ja-JP")}頁・用語索引${guideIndexed.toLocaleString("ja-JP")}件）のPDFページ案内を収録していますが、確定した卒業・履修要件構造化データは未登録（0件）です。`
        : "履修要覧のPDF・要件データは未登録です。";
      datasetQuality.textContent = `現行時間割との全件照合は未完了です。${pastText}未確認候補や訂正表候補は公式PDFで確認してください。${guideText}最新の休講・教室変更はWebClassのお知らせを優先してください。`;
    } catch (error) {
      datasetSummary.textContent = `時間割データを読み込めませんでした: ${error.message}`;
      datasetQuality.textContent = "拡張機能を再読み込みしてから、この設定画面を開き直してください。";
    }
  }

  async function initialize() {
    const settings = await storageGet(DEFAULTS);
    const appearance = document.getElementById("appearancePicker");
    const appearanceHelp = document.getElementById("appearanceHelp");
    const choices = [...appearance.querySelectorAll("input")];
    const showAppearance = (mode) => {
      const selected = mode === "modern" ? "modern" : "standard";
      for (const choice of choices) choice.checked = choice.value === selected;
    };
    const updateAppearanceAvailability = () => {
      const enabled = document.getElementById("enabled").checked;
      const restyle = document.getElementById("restyle");
      restyle.disabled = !enabled;
      appearance.disabled = !enabled || !restyle.checked;
      appearanceHelp.textContent = !enabled ? "拡張機能をオンにすると選べます。"
        : !restyle.checked ? "「画面を整える」をオンにすると選べます。"
        : "時間割・コース一覧・教材一覧に反映します。";
    };
    showAppearance(settings.appearance);
    appearance.addEventListener("change", async (event) => {
      await storageSet({ appearance: event.target.value });
      flashSaved();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.appearance) showAppearance(changes.appearance.newValue);
      for (const key of toggleIds) {
        if (changes[key]) document.getElementById(key).checked = Boolean(changes[key].newValue ?? DEFAULTS[key]);
      }
      if (changes.curriculumPlan) document.getElementById("curriculumPlan").value = changes.curriculumPlan.newValue || "";
      if (changes.curriculumTeaching) document.getElementById("curriculumTeaching").checked = Boolean(changes.curriculumTeaching.newValue);
      if (changes.curriculumHirameki) document.getElementById("curriculumHirameki").checked = Boolean(changes.curriculumHirameki.newValue);
      if (changes.userCourses) {
        const updatedCourses = Array.isArray(changes.userCourses.newValue) ? changes.userCourses.newValue : [];
        editor.value = prettyOverrides(updatedCourses);
        updateCount(updatedCourses);
      }
      if (changes.enabled || changes.restyle) {
        detailPanel.classList.toggle("dim", !document.getElementById("enabled").checked);
        updateAppearanceAvailability();
      }
    });

    const plan = document.getElementById("curriculumPlan");
    const admissionYear = document.getElementById("webclassAdmissionYear");
    const teaching = document.getElementById("curriculumTeaching");
    const hirameki = document.getElementById("curriculumHirameki");
    plan.value = settings.curriculumPlan || "";
    admissionYear.value = settings.webclassAdmissionYear || "";
    teaching.checked = Boolean(settings.curriculumTeaching);
    hirameki.checked = Boolean(settings.curriculumHirameki);
    plan.addEventListener("change", async () => { await storageSet({ curriculumPlan: plan.value }); flashSaved(); });
    admissionYear.addEventListener("change", async () => {
      if (!admissionYear.reportValidity()) return;
      await storageSet({ webclassAdmissionYear: admissionYear.value });
      flashSaved();
    });
    teaching.addEventListener("change", async () => { await storageSet({ curriculumTeaching: teaching.checked }); flashSaved(); });
    hirameki.addEventListener("change", async () => { await storageSet({ curriculumHirameki: hirameki.checked }); flashSaved(); });

    for (const id of toggleIds) {
      const control = document.getElementById(id);
      control.checked = Boolean(settings[id]);
      control.addEventListener("change", async () => {
        await storageSet({ [id]: control.checked });
        if (id === "enabled") detailPanel.classList.toggle("dim", !control.checked);
        if (id === "enabled" || id === "restyle") updateAppearanceAvailability();
        flashSaved();
      });
    }

    detailPanel.classList.toggle("dim", !settings.enabled);
    updateAppearanceAvailability();

    const courses = Array.isArray(settings.userCourses) ? settings.userCourses : [];
    editor.value = prettyOverrides(courses);
    updateCount(courses);
    if (courses.length) document.getElementById("advanced").open = true;
    loadBundledData();

    document.getElementById("saveJson").addEventListener("click", async () => {
      try {
        const parsed = JSON.parse(editor.value || '{"courses":[]}');
        const validated = normalizePayload(parsed);
        editor.value = prettyOverrides(validated);
        await storageSet({ userCourses: validated });
        updateCount(validated);
        setMessage(`${validated.length}件の上書きデータを検証して保存しました。`, "success");
      } catch (error) {
        setMessage(`保存できません: ${error.message}`, "error");
      }
    });

    document.getElementById("formatJson").addEventListener("click", () => {
      try {
        const parsed = JSON.parse(editor.value || '{"courses":[]}');
        editor.value = JSON.stringify(parsed, null, 2);
        setMessage("JSONを整形しました。保存ボタンを押すまで設定は変わりません。", "success");
      } catch (error) {
        setMessage(`整形できません: ${error.message}`, "error");
      }
    });

    document.getElementById("loadSample").addEventListener("click", async () => {
      try {
        const response = await fetch(chrome.runtime.getURL("data/sample-user-overrides.json"));
        const sample = await response.json();
        editor.value = JSON.stringify(sample, null, 2);
        setMessage("記入例を表示しました。必要箇所を修正して保存してください。", "success");
      } catch (error) {
        setMessage(`記入例を読み込めません: ${error.message}`, "error");
      }
    });

    document.getElementById("exportJson").addEventListener("click", () => {
      try {
        const parsed = JSON.parse(editor.value || '{"courses":[]}');
        const validated = normalizePayload(parsed);
        const blob = new Blob([prettyOverrides(validated) + "\n"], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "webclass-course-overrides.json";
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setMessage("上書きデータを書き出しました。", "success");
      } catch (error) {
        setMessage(`書き出せません: ${error.message}`, "error");
      }
    });

    document.getElementById("addQuickOverride")?.addEventListener("click", async () => {
      try {
        const courseName = document.getElementById("quickCourseName").value.trim();
        const courseCode = document.getElementById("quickCourseCode").value.trim();
        const instructorsRaw = document.getElementById("quickInstructors").value.trim();
        const day = document.getElementById("quickDay").value.trim();
        const periodRaw = document.getElementById("quickPeriod").value.trim();
        const room = document.getElementById("quickRoom").value.trim();

        if (!courseName) {
          setMessage("科目名を入力してください。", "error");
          document.getElementById("quickCourseName").focus();
          return;
        }
        if ((day && !periodRaw) || (!day && periodRaw)) {
          setMessage("曜日と時限はセットで選択してください。", "error");
          return;
        }
        let current = [];
        try {
          current = normalizePayload(JSON.parse(editor.value || '{"courses":[]}'));
        } catch {
          current = [];
        }
        const normalizedCode = courseCode.toLowerCase();
        const normalizedName = courseName.normalize("NFKC").toLowerCase();
        const existingIndex = current.findIndex((item) =>
          (normalizedCode && String(item.courseCode || "").trim().toLowerCase() === normalizedCode)
          || (!normalizedCode && String(item.courseName || "").normalize("NFKC").toLowerCase() === normalizedName)
        );
        const existing = existingIndex >= 0 ? current[existingIndex] : null;
        if (room && !day && !periodRaw && !(existing?.meetings?.length)) {
          setMessage("教室を登録するには曜日と時限も選択してください。", "error");
          return;
        }

        const instructors = instructorsRaw
          ? instructorsRaw.split(/[・、,，/／]+/).map((s) => s.trim()).filter(Boolean)
          : (existing?.instructors || []);
        let meetings = Array.isArray(existing?.meetings) ? existing.meetings.map((m) => ({ ...m })) : [];
        if (day && periodRaw) {
          const period = Number(periodRaw);
          const slotIdx = meetings.findIndex((m) => m.day === day && Number(m.period) === period);
          const nextMeeting = { day, period, room: room || meetings[slotIdx]?.room || "" };
          if (slotIdx >= 0) meetings[slotIdx] = nextMeeting;
          else meetings.push(nextMeeting);
        } else if (room && meetings.length) {
          meetings = meetings.map((m) => ({ ...m, room }));
        }

        const entry = {
          ...(existing || {}),
          courseName,
          ...(courseCode ? { courseCode } : {}),
          instructors,
          meetings
        };
        if (existingIndex >= 0) current[existingIndex] = entry;
        else current.push(entry);

        const validated = normalizePayload(current);
        editor.value = prettyOverrides(validated);
        await storageSet({ userCourses: validated });
        updateCount(validated);
        flashSaved();
        setMessage(`「${courseName}」を上書き保存しました（計${validated.length}件）。`, "success");
      } catch (error) {
        setMessage(`追加できません: ${error.message}`, "error");
      }
    });

    document.getElementById("resetJson").addEventListener("click", async () => {
      if (!confirm("上書きデータをすべて削除します。よろしいですか？")) return;
      await storageSet({ userCourses: [] });
      editor.value = prettyOverrides([]);
      updateCount([]);
      setMessage("上書きデータを削除し、同梱時間割データへ戻しました。", "success");
    });
  }

  initialize();
})();
