// Claude Conversation Exporter — content script
// Runs in the context of the claude.ai page. Reads the already-rendered
// DOM (the same content a human would see/copy) and turns it into a
// clean, ordered transcript. Does NOT touch any network requests or auth.

(() => {
  "use strict";

  // Bump this string whenever content.js changes. Logged on load and
  // included in diagnostics so a stale/cached injection is obvious
  // instead of silently producing confusing partial results.
  const CONTENT_SCRIPT_VERSION = "2026-08-25-v6-code-session-extraction";
  console.log("[Claude Conversation Exporter] content.js loaded — version", CONTENT_SCRIPT_VERSION);

  // claude.ai is a single-page app: manifest-declared content_scripts only
  // run once per real page load, and a long-lived tab can outlive many
  // extension reloads. popup.js now force-reinjects this file on every
  // Export click (see ensureContentScriptInjected) so the on-disk code is
  // always what runs — but that means this IIFE can execute more than once
  // in the same page. Without a guard, each execution would register its
  // own chrome.runtime.onMessage listener, and since Chrome delivers the
  // response from whichever listener calls sendResponse first (registration
  // order, called synchronously), the OLDEST listener would keep winning
  // forever — the exact "updated code never seems to run" symptom this
  // version marker was added to debug. So: remove any previous instance's
  // listener before registering this one.
  if (window.__claudeExporterOnMessageListener) {
    chrome.runtime.onMessage.removeListener(window.__claudeExporterOnMessageListener);
  }
  window.__claudeExporterVersion = CONTENT_SCRIPT_VERSION;

  // Impossible-to-miss visual confirmation of which version is live,
  // independent of devtools console timing or the diagnostics JSON.
  (function showVersionBanner() {
    const existing = document.getElementById("__claude-exporter-version-banner");
    if (existing) existing.remove();
    const banner = document.createElement("div");
    banner.id = "__claude-exporter-version-banner";
    banner.textContent = `Exporter content.js: ${CONTENT_SCRIPT_VERSION}`;
    banner.style.cssText =
      "position:fixed;bottom:8px;right:8px;z-index:2147483647;" +
      "background:#111;color:#0f0;font:11px/1.4 monospace;padding:4px 8px;" +
      "border-radius:4px;opacity:0.85;pointer-events:none;";
    document.documentElement.appendChild(banner);
    setTimeout(() => banner.remove(), 6000);
  })();

  // ==========================================================================
  // DOM EXTRACTION LOGIC — CLAUDE.AI SPECIFIC
  // ==========================================================================
  // Claude.ai's DOM structure is not publicly documented and can change
  // without notice. Everything that depends on the page's actual markup
  // lives in this one section so it's easy to find and fix later.
  //
  // Approach: try a short list of selector strategies, in order of how
  // likely they are to be correct/stable. Use the first strategy that
  // finds at least one user message AND at least one assistant message.
  // If nothing matches, fail loudly (return an error + diagnostics)
  // instead of exporting an empty or garbled file.
  // ==========================================================================

  // Fallback only — see captureVirtualizedTranscript() below for the
  // primary extraction path, confirmed live against claude.ai on
  // 2026-08-25. This static list stays as a safety net for a page that,
  // for whatever reason, doesn't have any [data-testid="transcript-row"]
  // elements at all (layout change, or a surface we haven't seen).
  const EXTRACTION_STRATEGIES = [
    {
      name: "data-testid user-message + font-claude-response",
      userSelector: '[data-testid="user-message"]',
      assistantSelector: ".font-claude-response",
    },
    {
      name: "data-testid user-message + font-claude-message (older guess)",
      userSelector: '[data-testid="user-message"]',
      assistantSelector: ".font-claude-message",
    },
    {
      name: "generic data-testid message roles",
      userSelector: '[data-testid*="user"][data-testid*="message"]',
      assistantSelector: '[data-testid*="assistant"][data-testid*="message"], [data-testid*="claude"][data-testid*="message"]',
    },
  ];

  function findMessagesWithStrategy(strategy) {
    const userEls = Array.from(document.querySelectorAll(strategy.userSelector));
    const assistantEls = Array.from(document.querySelectorAll(strategy.assistantSelector));
    return { userEls, assistantEls };
  }

  function locateMessages() {
    for (const strategy of EXTRACTION_STRATEGIES) {
      const { userEls, assistantEls } = findMessagesWithStrategy(strategy);
      if (userEls.length > 0 && assistantEls.length > 0) {
        return { strategyName: strategy.name, userEls, assistantEls };
      }
    }
    return null;
  }

  // Recursively walk a message's DOM subtree, converting it into
  // reasonably clean Markdown-flavored text. Falls back to plain text
  // for anything it doesn't specifically handle.
  function nodeToMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const tag = node.tagName.toLowerCase();
    const childText = () => Array.from(node.childNodes).map(nodeToMarkdown).join("");

    switch (tag) {
      case "p":
        return childText().trim() + "\n\n";
      case "br":
        return "\n";
      case "strong":
      case "b":
        return `**${childText().trim()}**`;
      case "em":
      case "i":
        return `*${childText().trim()}*`;
      case "pre": {
        const codeEl = node.querySelector("code");
        const raw = (codeEl || node).textContent.replace(/\n+$/, "");
        let lang = "";
        const classAttr = (codeEl && codeEl.className) || "";
        const langMatch = classAttr.match(/language-(\w+)/);
        if (langMatch) lang = langMatch[1];
        return "```" + lang + "\n" + raw + "\n```\n\n";
      }
      case "code":
        // Inline code (code blocks are handled via the parent <pre> case above)
        return `\`${node.textContent}\``;
      case "ul":
        return (
          Array.from(node.children)
            .map((li) => `- ${nodeToMarkdown(li).trim()}`)
            .join("\n") + "\n\n"
        );
      case "ol":
        return (
          Array.from(node.children)
            .map((li, i) => `${i + 1}. ${nodeToMarkdown(li).trim()}`)
            .join("\n") + "\n\n"
        );
      case "li":
        return childText();
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const level = Number(tag[1]);
        return "#".repeat(level) + " " + childText().trim() + "\n\n";
      }
      case "blockquote":
        return (
          childText()
            .trim()
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n") + "\n\n"
        );
      case "a": {
        const href = node.getAttribute("href");
        const text = childText().trim();
        if (href && href !== text) return `${text} (${href})`;
        return text;
      }
      case "hr":
        return "\n---\n\n";
      case "script":
      case "style":
      case "svg":
      case "button":
        return "";
      default:
        return childText();
    }
  }

  function extractTextFromElement(el) {
    const raw = nodeToMarkdown(el);
    return raw
      .replace(/[ \t]+\n/g, "\n") // trailing spaces before newlines
      .replace(/\n{3,}/g, "\n\n") // collapse excess blank lines
      .trim();
  }

  // Both claude.ai/chat/... and claude.ai/code/session_... virtualize the
  // transcript: only rows currently scrolled into view exist in the DOM
  // (confirmed live: at rest near the bottom of a 198-message thread, only
  // 21 [data-testid="transcript-row"] elements existed; scrolling to top
  // dropped that to a handful with a small tail buffer, and directly
  // re-querying a mid-thread data-index after scrolling away returned
  // null — rows are actually removed, not hidden). So extraction has to
  // drive the scroll container from top to bottom, capturing each row as
  // it renders and deduping by its data-index, rather than a single query.
  // Value differs by surface — "true" on chat pages, "" (empty string) on
  // Code session pages ([data-testid="epitaxy-virtual-transcript"]) — so
  // match on attribute presence only, not a specific value.
  const SCROLL_CONTAINER_SELECTOR = "[data-autoscroll-container]";

  function findScrollContainer(sampleRow) {
    const explicit = document.querySelector(SCROLL_CONTAINER_SELECTOR);
    if (explicit) return explicit;
    // Fallback for a surface where the confirmed selector above doesn't
    // apply (e.g. Code sessions, not yet directly confirmed): walk up from
    // a row looking for the nearest genuinely scrollable ancestor.
    let node = sampleRow && sampleRow.parentElement;
    while (node && node !== document.body) {
      const style = window.getComputedStyle(node);
      const scrollable =
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        node.scrollHeight > node.clientHeight;
      if (scrollable) return node;
      node = node.parentElement;
    }
    return null;
  }

  // A row's role is given directly by data-perf-row — confirmed live on
  // both surfaces, and more reliable than inferring from child markup.
  // Values: "human", "assistant", and (Code sessions only) "marker" for
  // non-turn divider rows like "Resumed session" — those get skipped.
  //
  // Message text location differs by surface:
  // - Chat: user text in [data-testid="user-message"]; assistant text in
  //   .standard-markdown (or .progressive-markdown mid-stream) under
  //   .font-claude-response.
  // - Code sessions: no [data-testid="user-message"] at all — user text is
  //   in .epitaxy-user-turn instead. Assistant text is one or more
  //   .epitaxy-markdown blocks, which can be interleaved with collapsed
  //   tool-call summaries (button.group/tool, e.g. "Ran 2 commands, read
  //   HANDOFF.md") — see extractAssistantRowText for how those combine.
  function extractRowMessage(row) {
    const roleAttr = row.getAttribute("data-perf-row");
    let role;
    if (roleAttr === "human") role = "user";
    else if (roleAttr === "assistant") role = "assistant";
    else return null; // "marker" or unrecognized row shape — not a real turn

    let text;
    if (role === "user") {
      const container =
        row.querySelector('[data-testid="user-message"]') || // chat
        row.querySelector('[data-cds="UserMessage"]') || // chat
        row.querySelector(".epitaxy-user-turn"); // Code sessions
      if (!container) return null;
      text = extractTextFromElement(container);
    } else {
      text = extractAssistantRowText(row);
    }
    if (!text) return null;

    const indexAttr = row.getAttribute("data-index") ?? row.getAttribute("data-rs-index");
    const index = indexAttr !== null ? Number(indexAttr) : null;
    if (index === null || Number.isNaN(index)) return null;

    return { role, text, index };
  }

  function extractAssistantRowText(row) {
    const chatContainer =
      row.querySelector(".standard-markdown") ||
      row.querySelector(".progressive-markdown") ||
      row.querySelector(".font-claude-response");
    if (chatContainer) return extractTextFromElement(chatContainer);

    // Code sessions: prose and tool-call summaries are siblings within the
    // row. querySelectorAll on a combined selector returns matches in
    // document order regardless of selector order, so this naturally
    // reconstructs the real sequence (e.g. tool call, then the response
    // text that follows it) without a separate sort step.
    const parts = [];
    row.querySelectorAll(".epitaxy-markdown, button.group\\/tool").forEach((el) => {
      if (el.matches(".epitaxy-markdown")) {
        const t = extractTextFromElement(el);
        if (t) parts.push(t);
      } else {
        const t = el.textContent.trim().replace(/\s+/g, " ");
        if (t) parts.push(`*[tool] ${t}*`);
      }
    });
    return parts.join("\n\n");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function captureVirtualizedTranscript() {
    const firstRow = document.querySelector('[data-testid="transcript-row"]');
    const scrollContainer = findScrollContainer(firstRow);
    if (!scrollContainer) {
      return { success: false, error: "NO_SCROLL_CONTAINER", diagnostics: runDiagnostics() };
    }

    const originalScrollTop = scrollContainer.scrollTop;
    const captured = new Map(); // data-index -> {role, text, index}
    let expectedTotal = null;

    function captureVisibleRows() {
      document.querySelectorAll('[data-testid="transcript-row"]').forEach((row) => {
        if (expectedTotal === null) {
          const article = row.querySelector("[aria-setsize]");
          if (article) {
            const setSize = Number(article.getAttribute("aria-setsize"));
            if (!Number.isNaN(setSize)) expectedTotal = setSize;
          }
        }
        const msg = extractRowMessage(row);
        if (!msg || captured.has(msg.index)) return;
        captured.set(msg.index, msg);
      });
    }

    scrollContainer.scrollTop = 0;
    await sleep(200);
    captureVisibleRows();

    // Deliberately smaller than a full viewport so consecutive capture
    // windows overlap — avoids skipping rows the virtualizer never
    // rendered because a step jumped clean over them.
    const stepSize = Math.max(150, Math.round(scrollContainer.clientHeight * 0.5));
    let lastScrollTop = -1;
    let stableIterations = 0;
    const maxIterations = 300;

    for (let i = 0; i < maxIterations; i++) {
      if (expectedTotal !== null && captured.size >= expectedTotal) break;

      scrollContainer.scrollTop += stepSize;
      await sleep(150);
      captureVisibleRows();

      if (scrollContainer.scrollTop === lastScrollTop) {
        stableIterations++;
        if (stableIterations >= 3) break; // reached the bottom
      } else {
        stableIterations = 0;
        lastScrollTop = scrollContainer.scrollTop;
      }
    }

    // One more explicit pass pinned to the very bottom, in case the
    // stepping loop overshot and stopped just short of it.
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    await sleep(200);
    captureVisibleRows();

    scrollContainer.scrollTop = originalScrollTop;

    const messages = Array.from(captured.values())
      .sort((a, b) => a.index - b.index)
      .map(({ role, text }) => ({ role, text }));

    return { success: true, messages, expectedTotal, capturedCount: messages.length };
  }

  async function extractConversation() {
    const hasVirtualizedTranscript = document.querySelector('[data-testid="transcript-row"]') !== null;

    if (hasVirtualizedTranscript) {
      const captureResult = await captureVirtualizedTranscript();
      if (!captureResult.success) return captureResult;

      if (captureResult.messages.length === 0) {
        return { success: false, error: "EMPTY_MESSAGES", diagnostics: runDiagnostics() };
      }

      const countNote =
        captureResult.expectedTotal != null
          ? ` (captured ${captureResult.capturedCount} of ${captureResult.expectedTotal})`
          : ` (captured ${captureResult.capturedCount})`;

      return {
        success: true,
        messages: captureResult.messages,
        strategyUsed: "virtualized-scroll-capture" + countNote,
        pageTitle: document.title,
      };
    }

    // Non-virtualized fallback — see the EXTRACTION_STRATEGIES comment above.
    const located = locateMessages();
    if (!located) {
      return { success: false, error: "NO_MESSAGES_FOUND", diagnostics: runDiagnostics() };
    }

    const tagged = [
      ...located.userEls.map((el) => ({ el, role: "user" })),
      ...located.assistantEls.map((el) => ({ el, role: "assistant" })),
    ];

    // Sort into actual page order regardless of which selector found them.
    tagged.sort((a, b) => {
      const pos = a.el.compareDocumentPosition(b.el);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    const messages = tagged
      .map(({ el, role }) => ({ role, text: extractTextFromElement(el) }))
      .filter((m) => m.text.length > 0);

    if (messages.length === 0) {
      return { success: false, error: "EMPTY_MESSAGES", diagnostics: runDiagnostics() };
    }

    return {
      success: true,
      messages,
      strategyUsed: located.strategyName,
      pageTitle: document.title,
    };
  }

  // When extraction fails, gather a quick snapshot of what IS on the page
  // so a human (or a future pass fixing this file) can figure out the
  // new selectors fast, without having to open devtools from scratch.
  function runDiagnostics() {
    const testIds = new Set();
    document.querySelectorAll("[data-testid]").forEach((el) => {
      testIds.add(el.getAttribute("data-testid"));
    });

    const candidateClassPatterns = ["message", "chat", "turn", "font-", "prose", "markdown"];
    const classHits = {};
    candidateClassPatterns.forEach((pattern) => {
      classHits[pattern] = document.querySelectorAll(`[class*="${pattern}"]`).length;
    });

    const diagnostics = {
      contentScriptVersion: CONTENT_SCRIPT_VERSION,
      url: location.href,
      dataTestIds: Array.from(testIds).slice(0, 50),
      classPatternCounts: classHits,
      bodyChildCount: document.body ? document.body.children.length : 0,
    };

    // Claude Code web sessions (claude.ai/code/session_...) use a
    // virtualized transcript list (data-testid="transcript-row") instead
    // of the plain-DOM chat layout. Extraction there needs an auto-scroll
    // capture routine, which needs real row markup + the scroll container
    // to be built correctly. Capture that here so one failed export run
    // gives us everything needed to add support, instead of guessing.
    const transcriptRows = document.querySelectorAll('[data-testid="transcript-row"]');
    if (transcriptRows.length > 0) {
      const sampleRows = Array.from(transcriptRows)
        .slice(0, 3)
        .map((el) => el.outerHTML.slice(0, 2000));

      let scrollContainer = null;
      const containerNode = findScrollContainer(transcriptRows[0]);
      if (containerNode) {
        scrollContainer = {
          tag: containerNode.tagName.toLowerCase(),
          className: containerNode.className,
          testId: containerNode.getAttribute("data-testid"),
          hasAutoscrollAttr: containerNode.hasAttribute("data-autoscroll-container"),
          scrollHeight: containerNode.scrollHeight,
          clientHeight: containerNode.clientHeight,
          scrollTop: containerNode.scrollTop,
        };
      }

      diagnostics.codeSessionTranscript = {
        rowCountCurrentlyInDom: transcriptRows.length,
        sampleRowOuterHtml: sampleRows,
        scrollContainer,
      };
    }

    return diagnostics;
  }

  // ==========================================================================
  // END DOM EXTRACTION LOGIC
  // ==========================================================================

  function sanitizeFilenamePart(str, maxLen = 60) {
    return str
      .replace(/[\\/:*?"<>|]/g, "")
      .trim()
      .slice(0, maxLen)
      .trim() || "conversation";
  }

  function formatAsMarkdown(result) {
    const title = result.pageTitle && result.pageTitle !== "Claude" ? result.pageTitle : "Claude Conversation";
    const lines = [`# ${title}`, "", `*Exported from Claude.ai on ${new Date().toLocaleString()}*`, "", "---", ""];
    for (const msg of result.messages) {
      lines.push(msg.role === "user" ? "### User" : "### Claude");
      lines.push("");
      lines.push(msg.text);
      lines.push("");
      lines.push("---");
      lines.push("");
    }
    return lines.join("\n");
  }

  function formatAsText(result) {
    const title = result.pageTitle && result.pageTitle !== "Claude" ? result.pageTitle : "Claude Conversation";
    const divider = "-".repeat(66);
    const lines = [
      "Claude.ai Conversation Export",
      `Title: ${title}`,
      `Exported: ${new Date().toLocaleString()}`,
      `Messages: ${result.messages.length}`,
      "=".repeat(66),
      "",
    ];
    for (const msg of result.messages) {
      lines.push(msg.role === "user" ? "User:" : "Claude:");
      lines.push("");
      lines.push(msg.text);
      lines.push("");
      lines.push(divider);
      lines.push("");
    }
    return lines.join("\n");
  }

  function onExtractMessage(request, _sender, sendResponse) {
    if (request.action !== "EXTRACT_CONVERSATION") return;

    // Extraction now drives an auto-scroll capture loop (virtualized
    // transcript), so it's async — this listener must return true to keep
    // the message channel open for the eventual sendResponse below.
    extractConversation()
      .then((result) => {
        if (!result.success) {
          sendResponse(result);
          return;
        }

        const content = request.format === "text" ? formatAsText(result) : formatAsMarkdown(result);
        const ext = request.format === "text" ? "txt" : "md";
        const titlePart = sanitizeFilenamePart(
          result.pageTitle && result.pageTitle !== "Claude" ? result.pageTitle : "claude-conversation"
        );
        const dateStamp = new Date().toISOString().slice(0, 10);
        const filename = `${titlePart}-${dateStamp}.${ext}`;

        sendResponse({
          success: true,
          content,
          filename,
          messageCount: result.messages.length,
          strategyUsed: result.strategyUsed,
        });
      })
      .catch((err) => {
        sendResponse({
          success: false,
          error: "EXTRACTION_EXCEPTION",
          diagnostics: { message: String((err && err.message) || err), stack: err && err.stack },
        });
      });

    return true;
  }

  chrome.runtime.onMessage.addListener(onExtractMessage);
  window.__claudeExporterOnMessageListener = onExtractMessage;
})();
