(() => {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    restyle: true,
    appearance: "standard",
    modernizeNativeLayout: true,
    showInlineMetadata: true,
    showDeadlineList: true
  };

  const SUB_KEYS = ["modernizeNativeLayout", "showInlineMetadata", "showDeadlineList"];

  const controls = {
    enabled: document.getElementById("enabled"),
    restyle: document.getElementById("restyle"),
    modernizeNativeLayout: document.getElementById("modernizeNativeLayout"),
    showInlineMetadata: document.getElementById("showInlineMetadata"),
    showDeadlineList: document.getElementById("showDeadlineList")
  };

  const statusCard = document.getElementById("statusCard");
  const statusTitle = document.getElementById("statusTitle");
  const statusDetail = document.getElementById("statusDetail");
  const statusCount = document.getElementById("statusCount");
  const saveNotice = document.getElementById("saveNotice");
  const datasetSummary = document.getElementById("datasetSummary");
  const datasetQuality = document.getElementById("datasetQuality");
  const datasetQualityTitle = document.getElementById("datasetQualityTitle");
  const datasetQualityDetail = document.getElementById("datasetQualityDetail");
  const reloadCard = document.getElementById("reloadCard");
  const optionsSummary = document.getElementById("optionsSummary");
  const openWebClass = document.getElementById("openWebClass");
  const appearancePicker = document.getElementById("appearancePicker");
  const appearanceHelp = document.getElementById("appearanceHelp");
  const webclassTools = [...document.querySelectorAll("[data-webclass-tool]")];

  let activeTab = null;
  let noticeTimer = 0;

  function storageGet(defaults) {
    return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
  }

  function storageSet(values) {
    return new Promise((resolve) => chrome.storage.local.set(values, resolve));
  }

  function queryActiveTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0] || null));
    });
  }

  function sendToTab(tabId, message) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response || null);
      });
    });
  }

  function setStatus(kind, title, detail, countText = "", { reload = false } = {}) {
    statusCard.dataset.kind = kind;
    statusTitle.textContent = title;
    statusDetail.textContent = detail;
    statusCount.hidden = !countText;
    statusCount.textContent = countText;
    reloadCard.hidden = !reload;
  }

  function updateOptionsSummary() {
    const on = SUB_KEYS.filter((key) => controls[key].checked).length;
    optionsSummary.textContent = `${on} / ${SUB_KEYS.length} 項目がオン`;
    SUB_KEYS.forEach((key) => { controls[key].disabled = !controls.enabled.checked; });
    controls.restyle.disabled = !controls.enabled.checked;
    appearancePicker.disabled = !controls.enabled.checked || !controls.restyle.checked;
    appearanceHelp.textContent = !controls.enabled.checked ? "拡張機能をオンにすると選べます。"
      : !controls.restyle.checked ? "「画面を整える」をオンにすると選べます。"
      : "時間割・コース一覧・教材一覧に反映します。";
  }

  function showSaved(text = "保存しました。画面へ自動反映します。") {
    saveNotice.textContent = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { saveNotice.textContent = ""; }, 2000);
  }

  async function loadDatasetSummary() {
    try {
      const [data, historyResponse] = await Promise.all([
        globalThis.WCV_DATA ? globalThis.WCV_DATA.load() : fetch(chrome.runtime.getURL("data/timetable-2026.json")).then((r) => r.json()),
        fetch(chrome.runtime.getURL("data/historical-course-row-evidence.json"))
      ]);
      if (!historyResponse.ok) throw new Error(`過年度資料 ${historyResponse.status}`);
      const history = await historyResponse.json();
      const scope = data.dataset?.scope || {};
      const count = (scope.uniqueCourses || data.courses?.length || 0).toLocaleString("ja-JP");
      const year = data.dataset?.academicYear || 2026;
      const generatedDate = String(data.dataset?.generatedAt || "").slice(0, 10);
      const fallSummary = history.currentFallCandidates?.summary || {};
      const fallOccurrences = Number(fallSummary.sourceOccurrences) || 0;
      const fallReviewed = Number(fallSummary.visuallyReviewedOccurrences) || 0;
      const corrCount = Number(history.correctionEvents?.summary?.eventCount) || 0;
      datasetSummary.textContent = `${year}年度 基本スナップショット${count}科目＋後期PDF候補${fallOccurrences.toLocaleString("ja-JP")}行・訂正表${corrCount}件${generatedDate ? `（${generatedDate}生成）` : ""}`;
      const summary = history.summary || {};
      const years = Array.isArray(summary.academicYears) ? summary.academicYears.join("・") : "";
      const candidates = Number(summary.sourceOccurrences) || 0;
      const reviewed = Number(summary.visuallyReviewedOccurrences) || 0;
      const unreviewed = Number(summary.unreviewedOccurrences) || 0;
      const guideSummary = history.studyGuideNavigation?.summary || {};
      const guideCount = Number(guideSummary.studyGuideCount) || 0;
      const guideIndexed = Number(guideSummary.indexedTermPagePairs) || 0;
      datasetQuality.dataset.kind = "warning";
      datasetQualityTitle.textContent = "現行資料との全件照合・要件確定は未完了です";
      const fallText = fallOccurrences
        ? `2026後期PDF候補${fallOccurrences.toLocaleString("ja-JP")}行（目視確認${fallReviewed}件）・訂正表候補${corrCount}件（未適用）、`
        : "";
      const pastText = candidates
        ? `過年度${years || "一部年度"}のPDF掲載行${candidates.toLocaleString("ja-JP")}件（目視確認${reviewed.toLocaleString("ja-JP")}件、未確認${unreviewed.toLocaleString("ja-JP")}件）を区別収録。`
        : "過年度の時間割行候補はありません。";
      const guideText = guideCount
        ? `授業検索には学修要覧${guideCount}冊の用語ページ案内${guideIndexed.toLocaleString("ja-JP")}件を収録。卒業要件メモは2022〜2026年度の入学者が対象です。`
        : "";
      datasetQualityDetail.textContent = `${fallText}${pastText}${guideText}最新の休講・変更はWebClassのお知らせと公式PDFをご確認ください。`;
    } catch (error) {
      datasetSummary.textContent = `時間割データを読み込めませんでした（${error.message}）`;
      datasetQuality.dataset.kind = "warning";
      datasetQualityTitle.textContent = "収録データを確認できません";
      datasetQualityDetail.textContent = "拡張機能を再読み込みしてから、WebClassタブを更新してください。";
    }
  }

  async function refreshStatus() {
    activeTab = await queryActiveTab();
    webclassTools.forEach((control) => { control.hidden = true; });

    if (!activeTab?.url?.startsWith("https://webclass.tcu.ac.jp/")) {
      setStatus(
        "idle",
        "WebClassのコース一覧に表示を追加します",
        "課題の締切と過年度検索はWebClassのコース一覧から開けます。"
      );
      return;
    }

    const response = await sendToTab(activeTab.id, { type: "wcv-get-status" });
    if (!response?.ready) {
      setStatus(
        "error",
        "まだ読み込まれていません",
        "拡張機能を入れた直後や更新した直後は、WebClassの再読み込みが必要です。",
        "",
        { reload: true }
      );
      return;
    }

    if (!response.enabled) {
      setStatus("off", "いまはオフです", "右上のスイッチをオンにすると、教室と担当教員が表示されます。");
      return;
    }
    for (const control of webclassTools) {
      control.hidden = !response.pageTools?.includes(control.dataset.webclassTool);
    }

    if (response.isLoginPage) {
      setStatus(
        "ready",
        "ログイン画面で待機しています",
        "ログインすると時間割に教室・担当教員が出ます。ログイン前でも画面内から全学DB・訂正表を検索できます。"
      );
      return;
    }

    const current = response.currentCourse
      ? `表示中の科目：${response.currentCourse}`
      : "コースリストを開くと、科目ごとに教室・担当教員が出ます。";
    setStatus(
      "ready",
      "WebClassで動いています",
      current,
      response.detectedCount > 0 ? `この画面で ${response.detectedCount} 科目を検出` : ""
    );
  }

  async function initialize() {
    const settings = await storageGet(DEFAULTS);
    const appearanceChoices = [...appearancePicker.querySelectorAll("input")];
    const showAppearance = (mode) => {
      const selected = mode === "modern" ? "modern" : "standard";
      appearanceChoices.forEach((choice) => { choice.checked = choice.value === selected; });
    };
    showAppearance(settings.appearance);
    for (const choice of appearanceChoices) {
      choice.addEventListener("change", async () => {
        await storageSet({ appearance: choice.value });
        showSaved(choice.value === "modern" ? "モダンに切り替えました。" : "標準に切り替えました。");
      });
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.appearance) showAppearance(changes.appearance.newValue);
      let summaryDirty = false;
      for (const key of Object.keys(controls)) {
        if (changes[key]) {
          controls[key].checked = Boolean(changes[key].newValue ?? DEFAULTS[key]);
          summaryDirty = true;
        }
      }
      if (summaryDirty) updateOptionsSummary();
    });

    Object.entries(controls).forEach(([key, control]) => {
      control.checked = Boolean(settings[key]);
      control.addEventListener("change", async () => {
        await storageSet({ [key]: control.checked });
        updateOptionsSummary();
        showSaved(key === "enabled"
          ? (control.checked ? "オンにしました。" : "オフにしました。元の画面に戻ります。")
          : undefined);
        setTimeout(refreshStatus, 200);
      });
    });
    updateOptionsSummary();

    openWebClass.addEventListener("click", async () => {
      try {
        const tabs = await chrome.tabs.query({ url: "https://webclass.tcu.ac.jp/*" });
        const existing = tabs.find((tab) => tab.id === activeTab?.id)
          || tabs.find((tab) => tab.url?.startsWith("https://webclass.tcu.ac.jp/webclass/"))
          || tabs[0];
        if (existing) {
          await chrome.tabs.update(existing.id, { active: true });
          await chrome.windows.update(existing.windowId, { focused: true });
        } else {
          await chrome.tabs.create({ url: "https://webclass.tcu.ac.jp/" });
        }
        window.close();
      } catch {
        showSaved("WebClassを開けませんでした。もう一度お試しください。");
      }
    });

    for (const button of document.querySelectorAll("[data-planner-section]")) {
      button.addEventListener("click", async () => {
        try {
          const result = await chrome.runtime.sendMessage({
            type: "wcv-open-planner", section: button.dataset.plannerSection
          });
          if (result?.opened) {
            window.close();
            return;
          }
        } catch {
          // The popup remains available if the extension was reloaded.
        }
        showSaved("ツールを開けませんでした。もう一度お試しください。");
      });
    }
    for (const button of webclassTools) {
      button.addEventListener("click", async () => {
        const result = await sendToTab(activeTab.id, { type: "wcv-open-page-tool", tool: button.dataset.webclassTool });
        if (result?.opened) window.close();
        else showSaved("WebClassのコース一覧を開いてお試しください。");
      });
    }

    document.getElementById("openGuide").addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("src/welcome.html") });
      window.close();
    });

    document.getElementById("openOptions").addEventListener("click", () => {
      chrome.runtime.openOptionsPage();
      window.close();
    });

    document.getElementById("reloadTab").addEventListener("click", () => {
      if (activeTab?.id != null) chrome.tabs.reload(activeTab.id);
      setStatus("checking", "更新しています…", "少し待つと反映されます。");
      setTimeout(refreshStatus, 1800);
    });

    loadDatasetSummary();
    refreshStatus();
  }

  initialize();
})();
