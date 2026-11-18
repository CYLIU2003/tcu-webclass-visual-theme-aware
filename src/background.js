"use strict";

const plannerSections = new Map([
  ["plan", ""],
  ["credits", "#credits-title"],
  ["requirements", "#requirements-title"],
  ["graduate", "#graduate-title"],
  ["programs", "#programs-title"],
  ["tasks", "#planner-tasks-title"],
  ["enrollment", "#enrollment-title"]
]);

const courseCode = /^[a-z]{3,4}\d{4,6}$/;

function enrollmentSnapshot(value) {
  if (!Number.isInteger(value?.year) || value.year < 2022 || value.year > 2099
    || !["all", "1", "2", "3", "4", "5", "6"].includes(value.term)
    || !Array.isArray(value.courses) || value.courses.length > 300) return null;
  const courses = [];
  const codes = new Set();
  for (const row of value.courses) {
    if (typeof row?.name !== "string" || !row.name.trim() || row.name.length > 160
      || (row.code !== null && (typeof row.code !== "string" || !courseCode.test(row.code)))) return null;
    if (row.code && codes.has(row.code)) continue;
    if (row.code) codes.add(row.code);
    const registrationId = /^[a-z0-9]{1,80}$/.test(row.registrationId || "") ? row.registrationId : undefined;
    courses.push({ code: row.code, name: row.name, registrationId });
  }
  return { year: value.year, term: value.term, courses };
}

async function openPlanner(message, fromWebClass, tabId) {
  const hash = plannerSections.get(message.section);
  const base = chrome.runtime.getURL("src/planner.html");
  if (message.snapshot === undefined) {
    await chrome.tabs.create({ url: base + hash });
    return;
  }
  const snapshot = fromWebClass && ["enrollment", "plan", "credits"].includes(message.section) && enrollmentSnapshot(message.snapshot);
  if (!snapshot) throw new Error("Invalid enrollment snapshot");
  const token = crypto.randomUUID();
  const key = "wcv-enrollment:" + token;
  await chrome.storage.session.set({ [key]: { ...snapshot, tabId } });
  try {
    await chrome.tabs.create({ url: base + "?enrollment=" + token + hash });
  } catch (error) {
    await chrome.storage.session.remove(key);
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "wcv-open-planner" || !plannerSections.has(message.section)) return;
  const popup = chrome.runtime.getURL("src/popup.html");
  const fromWebClass = sender.frameId === 0 && sender.url?.startsWith("https://webclass.tcu.ac.jp/");
  if (sender.id !== chrome.runtime.id || (sender.url !== popup && !fromWebClass)) return;
  openPlanner(message, fromWebClass, sender.tab?.id).then(() => respond({ opened: true }), () => respond({ opened: false }));
  return true;
});

// インストール直後に「はじめかた」を自動で開く（更新時は開かない）
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/welcome.html") });
  }
});
