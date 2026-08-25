const statusEl = document.getElementById("status");
const exportBtn = document.getElementById("exportBtn");
const diagBox = document.getElementById("diagBox");
const diagText = document.getElementById("diagText");
const copyDiagBtn = document.getElementById("copyDiag");

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = kind || "";
}

function getSelectedFormat() {
  const el = document.querySelector('input[name="format"]:checked');
  return el ? el.value : "markdown";
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendExtractMessage(tabId, format) {
  return chrome.tabs.sendMessage(tabId, { action: "EXTRACT_CONVERSATION", format });
}

async function ensureContentScriptInjected(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
}

function describeError(error) {
  switch (error) {
    case "NO_MESSAGES_FOUND":
      return "Couldn't find any messages on this page. Claude.ai's layout may have changed since this extension was built.";
    case "EMPTY_MESSAGES":
      return "Found message containers, but they were empty. Claude.ai's layout may have changed.";
    default:
      return "Something went wrong reading this page.";
  }
}

exportBtn.addEventListener("click", async () => {
  diagBox.style.display = "none";
  exportBtn.disabled = true;
  setStatus("Reading conversation… (scrolling through the full thread — long conversations can take several seconds)", "info");

  try {
    const tab = await getActiveTab();
    if (!tab || !tab.url || !tab.url.startsWith("https://claude.ai/")) {
      setStatus("Open a Claude.ai conversation tab first, then click Export.", "error");
      exportBtn.disabled = false;
      return;
    }

    const format = getSelectedFormat();
    // Always force-(re)inject content.js before messaging, rather than only
    // on failure. claude.ai is a single-page app, so a tab can carry a
    // content-script listener registered hours/days ago, from a much older
    // version of this file, that keeps answering sendMessage successfully
    // (so it never throws) even after content.js on disk has changed and
    // the extension has been reloaded. Forcing an injection here guarantees
    // the current on-disk code is what runs on every click; content.js
    // itself guards against the resulting double-injection by replacing its
    // own previous listener (see the version-guard at the top of that file).
    let response;
    try {
      await ensureContentScriptInjected(tab.id);
      response = await sendExtractMessage(tab.id, format);
    } catch (e) {
      // Injection itself can fail on restricted pages (e.g. chrome:// or an
      // extension gallery page slipped through the claude.ai check above).
      // Fall back to messaging whatever content script may already be there.
      response = await sendExtractMessage(tab.id, format);
    }

    if (!response || !response.success) {
      setStatus(describeError(response && response.error), "error");
      if (response && response.diagnostics) {
        diagText.value = JSON.stringify(response.diagnostics, null, 2);
        diagBox.style.display = "block";
      }
      exportBtn.disabled = false;
      return;
    }

    const blob = new Blob([response.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    chrome.downloads.download(
      { url, filename: response.filename, saveAs: false },
      () => {
        URL.revokeObjectURL(url);
        if (chrome.runtime.lastError) {
          setStatus(`Download failed: ${chrome.runtime.lastError.message}`, "error");
        } else {
          setStatus(`Exported ${response.messageCount} messages to ${response.filename}`, "success");
        }
        exportBtn.disabled = false;
      }
    );
  } catch (err) {
    setStatus(`Unexpected error: ${err.message}`, "error");
    exportBtn.disabled = false;
  }
});

copyDiagBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(diagText.value);
  copyDiagBtn.textContent = "Copied!";
  setTimeout(() => (copyDiagBtn.textContent = "Copy diagnostics"), 1200);
});

(async () => {
  const tab = await getActiveTab();
  if (!tab || !tab.url || !tab.url.startsWith("https://claude.ai/")) {
    setStatus("Open a Claude.ai conversation tab, then click Export.", "info");
  }
})();
