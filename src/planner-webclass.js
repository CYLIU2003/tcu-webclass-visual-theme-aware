(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const codePattern = /^[a-z]{3,4}\d{4,6}$/;
  const historyAutoKey = "wcv-webclass-history-auto";
  const firstYear = 2022;

  function key(year, row) {
    if (codePattern.test(row.code)) return `${year}:${row.code}`;
    if (/^[a-z0-9]{1,80}$/.test(row.registrationId || "")) return `${year}:wc:${row.registrationId}`;
    return null;
  }

  async function sources() {
    const tabs = await chrome.tabs.query({ url: "https://webclass.tcu.ac.jp/*" });
    const results = await Promise.all(tabs.map(async (tab) => {
      try {
        const snapshot = await chrome.tabs.sendMessage(tab.id, { type: "wcv-read-enrollment" }, { frameId: 0 });
        return snapshot ? { ...snapshot, tabId: tab.id } : null;
      } catch {
        return null;
      }
    }));
    return results.filter(Boolean);
  }

  async function initialize(onSnapshot, saveLedger, saveHistory, latestYear, autoEnabled) {
    const chooser = $("webclass-source-select");
    const status = $("webclass-source-status");
    const refresh = $("webclass-refresh");
    const save = $("webclass-save-ledger");
    const history = $("webclass-history-sync");
    const auto = $("webclass-history-auto");
    const historyStatus = $("webclass-history-status");
    const sourceLink = $("webclass-history-source");
    const token = new URLSearchParams(location.search).get("enrollment");
    let available = [];
    let snapshot;
    const years = Array.from({ length: latestYear - firstYear + 1 }, (_, index) => firstYear + index);
    $("webclass-history-range").textContent = `${firstYear}年度〜${latestYear}年度`;
    const scope = (row) => `${row.year}年度・${WCV_ENROLLMENT_MATCH.terms[row.term] || "表示中の学期"}`;

    function show(selected) {
      snapshot = selected;
      save.disabled = !snapshot?.courses.length;
      status.textContent = snapshot
        ? `WebClass ${scope(snapshot)}・参加コース ${snapshot.courses.length}件`
        : "取込元のコース一覧を選んでください。WebClassで対象年度・学期を表示できます。";
      onSnapshot(snapshot);
    }

    async function update(tryToken) {
      refresh.disabled = true;
      try {
        const previous = snapshot?.tabId || chooser.value;
        available = await sources();
        const pinned = tryToken && /^[0-9a-f-]{36}$/.test(token || "")
          ? (await chrome.storage.session.get("wcv-enrollment:" + token))["wcv-enrollment:" + token] : null;
        chooser.replaceChildren(new Option("コース一覧を選択", ""),
          ...available.map((row, index) => new Option(`${scope(row)}（タブ ${index + 1}）`, String(row.tabId))));
        $("webclass-source-picker").hidden = available.length < 2;
        const current = available.find((row) => String(row.tabId) === String(previous));
        show(pinned || current || (available.length === 1 ? available[0] : null));
        if (snapshot?.tabId) chooser.value = String(snapshot.tabId);
      } catch {
        available = [];
        show(null);
        status.textContent = "WebClassのコースを読み込めませんでした。コース一覧を確認して再読込してください。";
      } finally {
        refresh.disabled = false;
      }
    }

    chooser.addEventListener("change", () => show(available.find((row) => String(row.tabId) === chooser.value)));
    refresh.addEventListener("click", () => update(false));
    save.addEventListener("click", async () => {
      const selected = snapshot;
      if (!selected || save.getAttribute("aria-busy") === "true") return;
      save.setAttribute("aria-busy", "true");
      try {
        const { added, conflicts } = await saveLedger(selected);
        if (snapshot === selected) status.textContent = `WebClass ${scope(selected)} ／ 履修台帳に ${added}件追加しました（成績は未確認）。` +
          (conflicts ? ` 開講年度の不一致 ${conflicts}件を保留しました。` : "");
      } catch {
        status.textContent = "履修台帳に保存できませんでした。再度お試しください。";
      } finally {
        save.removeAttribute("aria-busy");
        save.disabled = !snapshot?.courses.length;
      }
    });

    async function syncHistory() {
      if (history.getAttribute("aria-disabled") === "true") return;
      history.setAttribute("aria-disabled", "true");
      sourceLink.hidden = true;
      try {
        await navigator.locks.request("wcv-webclass-history", { ifAvailable: true }, async (lock) => {
          if (!lock) {
            historyStatus.textContent = "別のプランナータブで同期中です。";
            return;
          }
          historyStatus.textContent = "WebClassのコース一覧を確認しています…";
          await update(false);
          const tabId = snapshot?.tabId;
          if (!tabId) {
            sourceLink.hidden = available.length < 2;
            historyStatus.textContent = sourceLink.hidden
              ? "ログイン済みのWebClassでコース一覧を表示してから同期してください。"
              : "複数のコース一覧があります。時間割で同期元を選んでから、もう一度同期してください。";
            return;
          }
          const snapshots = [];
          const failed = [];
          const empty = [];
          for (const year of years) {
            historyStatus.textContent = `${year}年度の参加コースを読み取っています…`;
            const result = await chrome.tabs.sendMessage(tabId, { type: "wcv-read-enrollment-year", year },
              { frameId: 0 }).catch(() => null);
            if (result?.year !== year || result.term !== "all" || !Array.isArray(result.courses)) {
              failed.push(year);
            } else {
              if (!result.courses.length) empty.push(year);
              snapshots.push(result);
            }
          }
          const outcomes = [];
          if (snapshots.length) {
            const { added, conflicts, existing } = await saveHistory(snapshots);
            outcomes.push(`同期 ${snapshots.length}年度。新規 ${added}件、登録済み ${existing}件。`);
            if (conflicts) outcomes.push(`開講年度が一致しないコース ${conflicts}件を保留。`);
          }
          if (empty.length) outcomes.push(`参加コースなし ${empty.join("・")}年度。`);
          if (failed.length) outcomes.push(`読込失敗 ${failed.join("・")}年度。WebClassを確認して再同期してください。`);
          historyStatus.textContent = outcomes.join(" ");
        });
      } catch {
        historyStatus.textContent = "履修台帳に保存できませんでした。再度同期してください。";
      } finally {
        history.removeAttribute("aria-disabled");
      }
    }

    history.addEventListener("click", syncHistory);
    auto.checked = autoEnabled === true;
    auto.addEventListener("change", async () => {
      const enabled = auto.checked;
      try {
        await chrome.storage.local.set({ [historyAutoKey]: enabled });
      } catch {
        auto.checked = !enabled;
        historyStatus.textContent = "自動同期の設定を保存できませんでした。";
        return;
      }
      if (auto.checked) void syncHistory();
    });
    await update(true);
    if (auto.checked) void syncHistory();
  }

  globalThis.WCV_PLANNER_WEBCLASS = { initialize, key, historyAutoKey };
})();
