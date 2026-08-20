// Claude Conversation Exporter — content script
// Runs in the context of the claude.ai page. Reads the already-rendered
// DOM (the same content a human would see/copy) and turns it into a
// clean, ordered transcript. Does NOT touch any network requests or auth.

(() => {
  "use strict";

  // Bump this string whenever content.js changes. Logged on load and
  // included in diagnostics so a stale/cached injection is obvious
  // instead of silently producing confusing partial results.
  const CONTENT_SCRIPT_VERSION = "2026-08-20-v3-code-session-inspect";
  console.log("[Claude Conversation Exporter] content.js loaded — version", CONTENT_SCRIPT_VERSION);

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

  const EXTRACTION_STRATEGIES = [
    {
      name: "data-testid user-message + font-claude-message",
      userSelector: '[data-testid="user-message"]',
      assistantSelector: ".font-claude-message",
    },
    {
      name: "font-user-message + font-claude-message classes",
      userSelector: ".font-user-message",
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

  function extractConversation() {
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
      let node = transcriptRows[0].parentElement;
      while (node && node !== document.body) {
        const style = window.getComputedStyle(node);
        const scrollable =
          (style.overflowY === "auto" || style.overflowY === "scroll") &&
          node.scrollHeight > node.clientHeight;
        if (scrollable) {
          scrollContainer = {
            tag: node.tagName.toLowerCase(),
            className: node.className,
            testId: node.getAttribute("data-testid"),
            scrollHeight: node.scrollHeight,
            clientHeight: node.clientHeight,
            scrollTop: node.scrollTop,
          };
          break;
        }
        node = node.parentElement;
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

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action !== "EXTRACT_CONVERSATION") return;

    const result = extractConversation();
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
  });
})();
