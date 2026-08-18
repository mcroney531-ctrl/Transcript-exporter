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
  setStatus("Reading conversation…", "info");

  try {
    const tab = await getActiveTab();
    if (!tab || !tab.url || !tab.url.startsWith("https://claude.ai/")) {
      setStatus("Open a Claude.ai conversation tab first, then click Export.", "error");
      exportBtn.disabled = false;
      return;
    }

    const format = getSelectedFormat();
    let response;
    try {
      response = await sendExtractMessage(tab.id, format);
    } catch (e) {
      // Content script probably wasn't injected yet (e.g. extension was
      // just installed/reloaded on an already-open tab). Inject and retry.
      await ensureContentScriptInjected(tab.id);
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
