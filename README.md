# Claude Conversation Exporter

A personal-use Chrome extension (Manifest V3) that exports the current
Claude.ai conversation to a clean, downloadable `.md` or `.txt` file —
every message, in order, with speaker labels — so you can hand off full
context to a fresh chat without losing fidelity to a summary.

Not published to the Chrome Web Store. Load it unpacked in developer mode.

## Install

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this folder (`Transcript-exporter`)
5. Pin the extension if you want quick access from the toolbar

## Use

1. Open a conversation at `https://claude.ai/chat/...`
2. Click the extension icon
3. Pick **Markdown** or **Plain text**
4. Click **Export Conversation** — a file downloads to your default Downloads folder

## How it works

Three pieces, standard MV3 shape:

- `manifest.json` — permissions (`activeTab`, `scripting`, `downloads`) and
  the content script registration for `claude.ai`
- `content.js` — runs on the Claude.ai page itself, reads the *already
  rendered* DOM (same as a human copy-pasting — no API calls, no auth
  tokens touched), and converts it to Markdown-flavored text
- `popup.html` / `popup.js` — the toolbar button UI; triggers extraction
  and downloads the result via `chrome.downloads`

## Important: the DOM selectors will need live verification

Claude.ai's frontend markup isn't public and can change without notice.
This was built without live access to your actual claude.ai session (this
Claude Code session ran in a sandboxed cloud environment, not your
browser), so the selectors in `content.js` are a best-effort based on
patterns Claude.ai has used historically — **they have not been verified
against the live page.**

Everything DOM-specific lives in one clearly marked section at the top of
`content.js`:

```js
// ==========================================================================
// DOM EXTRACTION LOGIC — CLAUDE.AI SPECIFIC
// ==========================================================================
```

It tries a few selector strategies in order and uses the first one that
finds actual messages. If none of them match, **it fails loudly** instead
of exporting an empty/broken file — the popup will show an error and a
"Copy diagnostics" button.

### If export fails on your first real test

1. Click **Export Conversation** — if it fails, a diagnostics box appears
2. Click **Copy diagnostics** and send that output back (to Claude, or use
   it yourself) — it lists every `data-testid` value and relevant class-name
   pattern counts found on the page, which is normally enough to write a
   correct selector without needing a full devtools session
3. Alternatively, right-click a user message and an assistant message in
   devtools → **Inspect**, then **Copy → Copy outerHTML**, and share both —
   that's the fastest path to an exact fix

Once real selectors are confirmed, update `EXTRACTION_STRATEGIES` at the
top of `content.js` (add a new entry at the front of the list) — nothing
else in the file needs to change.

## Known limitations (v1)

- Formatting fidelity is best-effort: bold, italics, headings, lists, and
  fenced code blocks (with language tag when detectable) are converted to
  Markdown; anything else falls back to plain text extraction
- No pagination/lazy-load handling — if Claude.ai virtualizes very long
  conversations (only renders messages currently scrolled into view), you
  may need to scroll through the whole conversation once before exporting
  so everything is in the DOM
- Local download only — no cloud storage, accounts, or sync
