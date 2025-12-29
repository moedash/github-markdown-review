# GitHub MD Review

A lightweight Chrome extension that adds inline commenting to GitHub's **rich diff view** for markdown files.

## How It Works

1. Open a PR with markdown files on GitHub
2. Click **"Display the rich diff"** button on a `.md` file
3. **Select any text** in the rendered markdown
4. A comment box appears - type your comment
5. Comment is pre-filled in GitHub's comment form with a reference to your selection

## Installation

```bash
npm install
npm run build
```

Then in Chrome:
1. Go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `dist` folder

## Features

- **No token required** - works with GitHub's native UI
- **Uses GitHub's rich diff** - no custom rendering needed
- **Character-level selection** - comment on specific phrases
- **Keyboard shortcuts** - ⌘/Ctrl+Enter to submit, Escape to cancel

## Comment Format

Comments include a hidden metadata reference:

```markdown
[//]: # (md-review:{"file":"README.md","start":150,"end":180,"text":"selected phrase"})

**On "selected phrase":**

Your comment here.
```

This metadata allows the extension (or other tools) to locate the exact text selection.

## Development

```bash
npm run dev    # Watch mode
npm run build  # Production build
npm run clean  # Remove dist/
```
