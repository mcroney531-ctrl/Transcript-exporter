# Handoff: Claude Conversation Exporter (Chrome Extension)

Read this whole document into a fresh Claude Code session before continuing. It captures everything needed to pick this up cold: the goal, what's built, what's broken, and the exact next steps — no need to re-derive any of it.

## Update (2026-08-25): stale-content-script mystery diagnosed and fixed (code-only, not yet browser-verified)

The session that wrote everything below this line ran with **no live browser access** either, so this fix is reasoned from Chrome extension semantics, not confirmed against the real page. Verify it first (see "Next step" at the end of this section) before trusting anything past it.

**Root cause, most likely:** two compounding bugs, both in the wiring, not in the DOM-extraction logic:

1. `popup.js`'s old flow only called `chrome.scripting.executeScript` (force-inject fresh `content.js`) when `chrome.tabs.sendMessage` **threw** — i.e. only when literally no listener existed in the tab yet. claude.ai is a single-page app: the manifest's declarative `content_scripts` entry only runs once per real page load/navigation, and a long-lived tab keeps whatever content-script listener it registered back then across client-side route changes *and* across reloading the unpacked extension in `chrome://extensions`. So once a tab had any listener — even one from a much older `content.js` — `sendMessage` kept succeeding against it, the throw/catch fallback never fired, and the fresh on-disk code was never the thing answering. This matches every symptom logged below: pulls confirmed, extension reloaded, hard refreshes done, even a "brand-new" tab could still be showing this if the extension's own reload in `chrome://extensions` was itself lagging or hitting a duplicate install.
2. Even a naive fix ("just always force-inject") wouldn't have been enough: injecting `content.js` a second time into the same page re-runs the whole IIFE, which would register a **second** `chrome.runtime.onMessage` listener without removing the first. Chrome invokes all listeners in a page for an incoming message, but only the first one to synchronously call `sendResponse` wins the reply — and that's the listener registered *earliest* (registration order), i.e. the stale one, every time.

**Fix applied (commit after `30014f1`):**
- `content.js` now stashes its message listener function on `window.__claudeExporterOnMessageListener` and, on each execution, removes any previous instance's listener before registering its own — so the most recently injected copy always wins the reply race.
- `content.js` also now renders a small fixed-position on-page banner (bottom-right, auto-removes after 6s) showing `CONTENT_SCRIPT_VERSION`, as a visual confirmation that doesn't depend on DevTools console timing — this was explicitly suggested but untried in the original debugging trail below.
- `popup.js` now **always** calls `ensureContentScriptInjected` (force re-injects `content.js` from disk) before every `sendExtractMessage`, instead of only on catch. The try/catch around the pair now exists only to fall back to messaging-without-injecting if injection itself fails (e.g. a restricted page slipped through the `claude.ai/` URL check).
- `CONTENT_SCRIPT_VERSION` bumped to `2026-08-25-v4-force-reinject`.

**Why this should make the diagnostics-version mystery moot going forward:** every Export click now guarantees the current on-disk `content.js` is what answers, regardless of tab age, prior injections, or how many times the extension has been reloaded. The `contentScriptVersion` field (and now the on-page banner) should always match what's actually in the repo from here on — no more "Remove + Load unpacked" ritual needed to get new code to run.

**What this fix does NOT touch:** the actual DOM extraction logic (`EXTRACTION_STRATEGIES`, `locateMessages`, virtualized-list handling) is unchanged. It was never actually exercised against real, current code before now, so the original "concrete next steps" below (get real `codeSessionTranscript` diagnostics, identify user-vs-assistant row structure, build the auto-scroll capture loop) still stand — they just might finally be reachable now.

**Next step for whoever has live browser access:** load the extension fresh (or just reload it once — the new force-reinject logic means a stale tab shouldn't matter anymore), open a real `claude.ai/chat/...` tab, click Export, and confirm (a) the on-page banner shows `2026-08-25-v4-force-reinject` and (b) if extraction still fails, the diagnostics JSON now has `contentScriptVersion` matching. If both hold, the stale-code problem is solved for good and it's safe to move straight to step 2 of "Concrete next steps" below (pull real `transcript-row` outerHTML and rewrite the extraction logic for the virtualized list). If the banner still doesn't show the new version even after this, that really does point back to a duplicate-install or wrong-directory `Load unpacked` problem — check `chrome://extensions` for more than one card matching this extension's name before anything else.

---

## The goal

A personal-use Chrome extension (Manifest V3, "Load unpacked" only, not published) that exports the current Claude.ai conversation — every message, both sides, in order — to a downloadable `.md` or `.txt` file. Why: the user runs very long multi-session projects in Claude.ai (a long-form article-drafting project is the driving example) and needs to hand off full raw context to a fresh chat once a conversation gets unwieldy. A manual "ask Claude to summarize" handoff loses fidelity (exact wording, exact quotes); a full raw transcript export doesn't.

Non-goals: no Anthropic API calls, no auth-token access — it only reads the already-rendered page DOM, same as a human copy-pasting. No cloud/sync — local file download only.

## Repo state

- GitHub: `mcroney531-ctrl/Transcript-exporter`
- Branch (work here, never main): `claude/conversation-export-extension-k70kw0`
- Commits so far, oldest first:
  - `df6251d` — initial scaffold (manifest, popup, content script, README)
  - `6db09b9` — added Code-session inspection to failure diagnostics
  - `24ebbe6` — added a `contentScriptVersion` marker to diagnostics, for reload debugging
- Files: `manifest.json`, `popup.html`, `popup.js`, `content.js`, `README.md`, this file.

## Architecture (this part is solid, not in question)

Standard MV3 three-piece extension:
- `manifest.json`: `permissions: [activeTab, scripting, downloads]`, `host_permissions: ["https://claude.ai/*"]`, a declarative `content_scripts` entry matching `https://claude.ai/*`, and a popup-based toolbar action.
- `popup.html`/`popup.js`: format radio (Markdown/plain text) + Export button. On click: queries the active tab, sends it a `chrome.tabs.sendMessage({action: "EXTRACT_CONVERSATION", format})`. If that throws (no content script listener yet), it falls back to `chrome.scripting.executeScript({files: ["content.js"]})` to inject on demand, then retries the message. On success, builds a `Blob` and calls `chrome.downloads.download`. On failure, shows the error and a "Copy diagnostics" button that dumps `response.diagnostics` (JSON) into a textarea.
- `content.js`: runs in the page. Has an isolated, clearly-marked "DOM EXTRACTION LOGIC" section (this is the part that needs rework — see below), a markdown-flavored DOM-to-text converter (`nodeToMarkdown`, handles p/br/strong/em/pre+code/ul/ol/li/headings/blockquote/a/hr reasonably well), and a `runDiagnostics()` function that on failure captures all `data-testid` values present, counts of a few candidate class-name substrings, and (added in `6db09b9`) sample row HTML + scroll-container info when `[data-testid="transcript-row"]` elements are present.

This popup/content-script/download wiring has never been proven to fail — every failure so far has been in DOM extraction (selectors not matching) or in getting updated `content.js` code to actually run in the browser (see "Blocking bug" below). Don't assume the wiring is the problem without evidence.

## What we learned live from the actual site (important — this took several diagnostic round-trips to get)

**Both `claude.ai/chat/<uuid>` (normal chat) and `claude.ai/code/session_<id>` (Claude Code web sessions) use a *virtualized* transcript list.** This invalidates the original assumption (baked into the current `EXTRACTION_STRATEGIES` in `content.js`) that a plain `document.querySelectorAll(...)` over the whole page would find every message. In a virtualized list, only the rows currently scrolled into view actually exist in the DOM — the rest are stripped out for performance. The telltale markers, seen on both surfaces:
- `data-testid="transcript-row"` — one per rendered message row
- `data-testid="transcript-sizer"` / `data-testid="transcript-spacer"` — virtualization scaffolding (sizer holds total scroll height, spacer offsets the visible window)
- `data-testid="transcript-list"` (chat) / `data-testid="epitaxy-virtual-transcript"` (Code sessions) — the virtualized container itself

**Implication:** a correct extractor for either surface needs to auto-scroll the container from top to bottom (or vice versa), capture each `transcript-row` as it renders, dedupe, and reassemble in order — not just query the current DOM once. This is real added complexity beyond the current `content.js`, which still uses the old naive-DOM approach and has never successfully extracted a real conversation.

**Chat-page (`claude.ai/chat/...`) diagnostics actually collected** (from `runDiagnostics()`, pre-virtualization-awareness code):
```json
{
  "url": "https://claude.ai/chat/be490984-caf9-491d-853c-bea4882f2daa",
  "dataTestIds": [
    "sidebar", "sidebar-projects", "sidebar-pinned", "sidebar-recents", "user-menu-button",
    "chat-stale-nav-frame", "chat-stale-nav-sink-before", "chat-stale-nav-body",
    "chat-header", "chat-title-split",
    "wiggle-controls-actions", "wiggle-controls-actions-group", "wiggle-controls-actions-toggle", "wiggle-controls-actions-share",
    "chat-column", "transcript-list", "transcript-sizer", "transcript-spacer", "transcript-row",
    "tool-status-pill", "tool-status-spark", "tool-status-caret",
    "file-thumbnail", "user-message", "action-bar-read-aloud",
    "transcript-trailing", "chat-footer-spark", "transcript-end", "last-message-sentinel", "chat-extra-space",
    "file-upload", "chat-input", "chat-input-attach", "model-selector-dropdown", "chat-input-send",
    "chat-stale-nav-shield", "chat-stale-nav-sink-after"
  ],
  "classPatternCounts": { "message": 10, "chat": 2, "turn": 0, "font-": 111, "prose": 0, "markdown": 10 },
  "bodyChildCount": 17
}
```
Key facts from this: there IS a `data-testid="user-message"` for user turns. There is **no equivalent `assistant-message`/`claude-message` testid visible** in the collected list — the assistant/Claude side is identified some other way (possibly by class, e.g. the un-confirmed `.font-claude-message` guess already in the code, or by row position/absence of `user-message`, or by something inside the row not surfaced by this diagnostic pass). `font-` class prefix has 111 matches on the page — consistent with `font-user-message`/`font-claude-message` existing, but this was never confirmed via actual `outerHTML`.

**Code-session (`claude.ai/code/session_...`) diagnostics** (same shape, different testids — this is the surface *this very Claude Code conversation* runs in):
```json
{
  "dataTestIds": [
    "sidebar", "sidebar-projects", "sidebar-pinned", "sidebar-recents", "user-menu-button",
    "code-sidebar-feedback-button", "pending-nav-frame", "pending-nav-body",
    "epitaxy-origin-gutter", "epitaxy-origin-label", "epitaxy-virtual-transcript",
    "transcript-sizer", "transcript-spacer", "transcript-row", "epitaxy-read-aloud",
    "code-prompt-input", "code-prompt-send", "pending-nav-shield"
  ],
  "classPatternCounts": { "message": 4, "chat": 24, "turn": 9, "font-": 38, "prose": 0, "markdown": 16 },
  "bodyChildCount": 15
}
```
Code sessions are a secondary/optional target (the user asked "can we get it to work on C[C]ode too" mid-session) — the chat surface is the primary, original goal and should be finished first.

**Still missing, and required before writing real extraction logic:** actual `outerHTML` of a `transcript-row` element (one containing a user turn, one containing an assistant/Claude turn) and identification of the actual scrollable ancestor element. `content.js`'s `runDiagnostics()` was already extended (commit `6db09b9`) to capture exactly this — `diagnostics.codeSessionTranscript = { rowCountCurrentlyInDom, sampleRowOuterHtml: [...up to 3 outerHTML strings, truncated to 2000 chars...], scrollContainer: {tag, className, testId, scrollHeight, clientHeight, scrollTop} }` — triggered whenever any `[data-testid="transcript-row"]` element exists, i.e. on both chat and Code-session pages. **This has never actually been observed in a diagnostics dump** — every diagnostics copy pasted back so far has had the old, pre-`6db09b9` shape (missing `codeSessionTranscript`, and even missing `contentScriptVersion` from the even-later `24ebbe6` commit). That's the blocking bug — see next section.

## Blocking bug: updated `content.js` never appeared to be running, across ~6 attempts

This ate most of the session and was **not resolved**. Symptoms, in the order discovered:

1. First diagnostics copy (on a Code session tab) came back in the pre-`6db09b9` shape — expected, hadn't pushed yet.
2. After pushing `6db09b9` and having the user `git pull` (confirmed successful via terminal output) + reload the extension (`chrome://extensions` reload icon) + hard-refresh the tab: diagnostics **still** came back in the old shape, no `codeSessionTranscript`.
3. Suspected a stale content-script instance persisting in an already-open tab. Had the user fully close and reopen the tab. **Still** old shape.
4. Pushed `24ebbe6` adding `contentScriptVersion` + a `console.log` on script load, specifically so we could tell definitively (via DevTools console, and via the diagnostics JSON itself) which code version was actually executing, without relying on interpreting behavior. Had the user `git pull` again, do a full extension **off/on toggle** (not just reload), open a **brand new tab**.
5. User checked DevTools console filtered on "Exporter" — **zero results**, even after clicking Export (which nonetheless returned a valid-looking diagnostics response to the popup). This is contradictory on its face: the message handler clearly ran (it returned data) but its very first line (`console.log` at module scope, `contentScriptVersion` in the returned diagnostics object) apparently didn't — unless the console just wasn't attached at the moment of injection (plausible: the on-load `console.log` only fires once, at injection time, and if DevTools wasn't open yet at that instant, it's simply lost — Chrome doesn't retroactively show it). This makes the console.log approach unreliable as a detector; **the diagnostics-JSON version field is the reliable check**, and it *also* never appeared.
6. Verified via `git log --oneline -5` + `git status` on the actual test machine: local clone **is** at `24ebbe6`, clean, matching `origin/claude/conversation-export-extension-k70kw0`. So it is not a "forgot to pull" problem.
7. Checked `chrome://extensions` → Details for the extension: shows "On", `Inspect views: No active views`, `Site access` for `https://claude.ai/*` shown with the "automatically allow access" toggle **off** (i.e., likely in "on click" access mode rather than "on all sites" — this is default/normal for a fresh extension in recent Chrome and *shouldn't* block the popup's own `activeTab`-based fallback injection path, but wasn't fully ruled out as a contributing factor). Loaded-from path shown as `...\Transcript-exporter` (truncated in the screenshot, not fully confirmed character-for-character).
8. Retested on a **completely different, fresh, never-before-tested `claude.ai/chat/...` tab** (not the long-lived Code-session tab this conversation runs in, which was the leading suspect for "never actually got reloaded because reloading it would kill this conversation"). **Still** got the old diagnostics shape (no `contentScriptVersion`, no `codeSessionTranscript`, despite `transcript-row` being present in `dataTestIds`, which should have triggered the `codeSessionTranscript` block). This rules out "it's just this one stuck tab" as the sole explanation.

**Where the investigation was cut off:** about to check `chrome://extensions` for a **duplicate installed copy** of the extension (e.g. two separate "Load unpacked" entries with different extension IDs, both matching `claude.ai/*`, with the user unknowingly testing against/being answered by the older one) and, regardless of what that shows, do one fully clean cycle: **Remove** the extension entirely (not just toggle off), then **Load unpacked** fresh pointing at the current folder, then retest immediately on a brand-new tab. That is the very next action to take.

If duplicates aren't the answer either, other things worth checking that weren't yet tried:
- Confirm there isn't a `chrome://extensions` "pinned" older version cached via Chrome's extension sync/profile settings (unlikely for unpacked, but check `chrome://version` → profile path matches, and that there isn't a second Chrome profile/window involved).
- Add a temporary, impossible-to-miss visible signal instead of console/JSON — e.g. have `content.js` inject a bright fixed-position banner div into the page on load reading the version string, so it's visually obvious without needing devtools timing luck.
- As a last resort, have the user run `chrome://extensions` → "Errors" button (if red) on the card to check for a runtime exception that might be preventing the new listener from registering (though this seems unlikely since *a* response is coming back successfully each time).

## Environment note

This Claude Code session ran in a cloud sandbox with **no live browser access** — all DOM inspection was done collaboratively, round-trip, via the extension's own "Copy diagnostics" feature and the user's screenshots/console output. That workflow itself is sound (it's how `6db09b9`'s facts above were obtained) — the blocker is specifically about Chrome not seemingly running the latest `content.js`, which is an environment/reload issue, not a code-logic issue.

## Concrete next steps, in order

1. **Resolve the stale-code mystery first** — nothing else can be verified until we know real code is executing. Do the clean Remove + Load-unpacked cycle described above; confirm via the `contentScriptVersion` field in a fresh diagnostics dump that current code is actually running.
2. Once confirmed live, click Export on a real `claude.ai/chat/...` conversation and pull the `codeSessionTranscript` diagnostics block (sample `transcript-row` outerHTML ×3, plus `scrollContainer` info). This is the data needed to write correct extraction.
3. Rewrite the "DOM EXTRACTION LOGIC" section of `content.js`:
   - Identify how to tell a user row from an assistant row within `transcript-row` markup (some attribute/class/child-structure — currently unknown, will be visible in the outerHTML samples).
   - Identify the real scrollable ancestor (the `scrollContainer` diagnostic gives tag/class/testid/scrollHeight/clientHeight — use that instead of guessing).
   - Implement an auto-scroll capture loop: scroll the container to top, then step down (e.g. by ~80% of `clientHeight` per step) collecting/deduping `transcript-row` content by a stable key (needs a real identifier from the row markup — a `key`/`id`/`data-*` attribute; if none exists, may need to key by extracted text hash as a fallback), until `scrollTop` stops advancing (reached bottom) or a sane iteration cap is hit. Reassemble by original document/scroll order.
   - This same virtualization-aware approach should work for both `claude.ai/chat/...` and `claude.ai/code/session_...` since both use the same `transcript-row`/`transcript-sizer`/`transcript-spacer` pattern — likely shareable extraction code with just a different scroll-container selector or role-detection rule per surface.
4. Re-test end to end on a real long conversation (ideally the user's actual article-drafting project) and confirm completeness, order, and readability of the exported file.
5. Only after chat export is solid, treat Code-session export as the secondary nice-to-have it was requested as.

## Working style notes for whoever picks this up

The user prefers small, verified increments over long unverified stretches — ship one small change, get it verified (even just via a diagnostics paste), then move on. They're comfortable in PowerShell (not Git Bash) on Windows; local working copy in this session was at `C:\Users\Trevor Newsome\Documents\Transcript-exporter` (a previous attempt at `$HOME\Transcript-exporter` failed with permission denied because `$HOME` resolved to a stale/mismatched `C:\Users\Rone` path rather than their actual profile — worth being aware this environment has that quirk). They're clearly fine debugging collaboratively via copy-pasted terminal output, screenshots, and DevTools — lean on that rather than guessing blind.
