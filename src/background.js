"use strict";

// インストール直後に「はじめかた」を自動で開く（更新時は開かない）
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/welcome.html") });
  }
});
