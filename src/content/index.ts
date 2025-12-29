// Content script - adds inline commenting to GitHub's rich diff view
import './styles.css';

console.log('[MD Review] Content script loaded');

interface SelectionInfo {
    text: string;
    filePath: string;
    startOffset: number;
    endOffset: number;
    rect: DOMRect;
}

interface Comment {
    id: string;
    text: string;
    selectedText: string;
    filePath: string;
    startOffset: number;
    endOffset: number;
    timestamp: number;
    postedToGitHub: boolean;
}

let activeCommentBox: HTMLElement | null = null;
let comments: Comment[] = [];

function getPRKey(): string {
    const match = window.location.pathname.match(/\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : 'unknown-pr';
}

function init(): void {
    console.log('[MD Review] Initializing...');

    // Load saved comments
    loadComments();

    // Load existing GitHub comments
    setTimeout(loadExistingGitHubComments, 500);

    // Add selection listener
    document.addEventListener('mouseup', handleTextSelection);

    // Watch for rich diff views
    observeRichDiffViews();

    // Process existing rich diffs
    processExistingRichDiffs();

    // Show sidebar if we have comments
    if (comments.length > 0) {
        renderCommentsSidebar();
    }
}

async function loadExistingGitHubComments(): Promise<void> {
    // Fetch comments from GitHub's API (same-origin, uses session cookies)
    await fetchCommentsFromAPI();

    // Also parse embedded JSON data for comments
    parseEmbeddedData();

    // Scan DOM for visible comments
    scanDOMForComments();

    // Watch for dynamically loaded comments
    observeComments();
}

async function fetchCommentsFromAPI(): Promise<void> {
    const match = window.location.pathname.match(/\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) return;

    const [, owner, repo, prNumber] = match;

    try {
        // Fetch issue comments (main PR comments)
        const commentsUrl = `/${owner}/${repo}/issues/${prNumber}/comments`;
        const response = await fetch(commentsUrl, {
            headers: { 'Accept': 'application/json' }
        });

        if (response.ok) {
            const html = await response.text();
            // Try to parse as JSON if GitHub returns it
            try {
                const data = JSON.parse(html);
                if (Array.isArray(data)) {
                    console.log(`[MD Review] Fetched ${data.length} comments from API`);
                    data.forEach((c: any) => {
                        if (c.body) parseAndAddComment(c.body, c.id?.toString() || '');
                    });
                }
            } catch {
                // HTML response, parse it
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                const bodies = doc.querySelectorAll('.comment-body, .js-comment-body, .markdown-body');
                console.log(`[MD Review] Parsed ${bodies.length} comments from HTML response`);
                bodies.forEach(body => {
                    if (body.textContent) parseAndAddComment(body.textContent, '');
                });
            }
        }

        // Also try the timeline endpoint
        const timelineUrl = `/${owner}/${repo}/pull/${prNumber}/timeline`;
        const timelineResp = await fetch(timelineUrl, {
            headers: { 'Accept': 'text/html' }
        });

        if (timelineResp.ok) {
            const html = await timelineResp.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const bodies = doc.querySelectorAll('.comment-body, .js-comment-body');
            console.log(`[MD Review] Found ${bodies.length} comments in timeline`);
            bodies.forEach(body => {
                if (body.textContent) {
                    console.log(`[MD Review] Timeline comment: "${body.textContent.slice(0, 50)}..."`);
                    parseAndAddComment(body.textContent, '');
                }
            });
        }
    } catch (e) {
        console.log('[MD Review] Could not fetch comments:', e);
    }

    if (comments.length > 0) {
        renderCommentsSidebar();
    }
}

function parseEmbeddedData(): void {
    // GitHub embeds data in script tags
    const scripts = document.querySelectorAll('script[type="application/json"], script[data-target]');

    scripts.forEach(script => {
        try {
            const text = script.textContent || '';
            if (text.includes('comment') || text.includes('review')) {
                const data = JSON.parse(text);
                extractCommentsFromData(data);
            }
        } catch (e) {
            // Not valid JSON, skip
        }
    });

    // Also check for data attributes on the page
    const prData = document.querySelector('[data-issue-and-pr-hovercards-url]');
    if (prData) {
        console.log('[MD Review] Found PR data element');
    }
}

function extractCommentsFromData(data: any, depth = 0): void {
    if (depth > 5 || !data) return;

    if (Array.isArray(data)) {
        data.forEach(item => extractCommentsFromData(item, depth + 1));
        return;
    }

    if (typeof data === 'object') {
        // Look for comment-like objects
        if (data.body && typeof data.body === 'string') {
            parseAndAddComment(data.body, data.id || data.databaseId || '');
        }
        if (data.bodyText && typeof data.bodyText === 'string') {
            parseAndAddComment(data.bodyText, data.id || '');
        }

        // Recurse into nested objects
        Object.values(data).forEach(v => extractCommentsFromData(v, depth + 1));
    }
}

function scanDOMForComments(): void {
    // Comprehensive list of comment container selectors
    const selectors = [
        // Standard comment containers
        '.js-timeline-item',
        '.js-comment',
        '.timeline-comment',
        '.review-comment',
        '.issue-comment',
        // Diff view comments
        '.inline-comments',
        '.review-thread',
        '.js-resolvable-thread-contents',
        '[data-line-comments]',
        // PR specific
        '.discussion-timeline-actions',
        '.js-discussion',
        // Generic
        '[data-gid]',
        '[data-url*="comment"]',
    ];

    const allContainers = new Set<Element>();
    selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => allContainers.add(el));
    });

    console.log(`[MD Review] Scanning ${allContainers.size} potential comment containers`);

    allContainers.forEach((container) => {
        // Find the comment body within
        const bodySelectors = ['.comment-body', '.js-comment-body', '.markdown-body', '.review-comment-contents'];
        for (const sel of bodySelectors) {
            const bodyEl = container.querySelector(sel);
            if (bodyEl && bodyEl.textContent && bodyEl.textContent.trim().length > 5) {
                const text = bodyEl.textContent;
                const id = container.getAttribute('data-gid') || container.id || '';
                console.log(`[MD Review] Found comment body: "${text.slice(0, 50).replace(/\n/g, ' ')}..."`);
                parseAndAddComment(text, id);
                break;
            }
        }
    });

    if (comments.length > 0) {
        console.log(`[MD Review] Loaded ${comments.length} comments`);
        renderCommentsSidebar();
    }
}

function observeComments(): void {
    // Watch for dynamically added comments
    const observer = new MutationObserver((mutations) => {
        let foundNew = false;
        mutations.forEach(m => {
            m.addedNodes.forEach(node => {
                if (node instanceof HTMLElement) {
                    const body = node.querySelector?.('.comment-body, .js-comment-body');
                    if (body?.textContent) {
                        parseAndAddComment(body.textContent, '');
                        foundNew = true;
                    }
                }
            });
        });
        if (foundNew) renderCommentsSidebar();
    });

    const timeline = document.querySelector('.js-discussion, .pull-discussion-timeline, main');
    if (timeline) {
        observer.observe(timeline, { childList: true, subtree: true });
    }
}

function parseAndAddComment(text: string, id: string): void {
    // Clean up the text
    const cleanText = text.trim().replace(/\s+/g, ' ').slice(0, 500);

    // Skip empty or very short comments
    if (cleanText.length < 5) return;

    // Skip template/boilerplate text
    if (cleanText.includes('What changed?') ||
        cleanText.includes('Nothing to preview') ||
        cleanText.includes('Fixes #')) {
        return;
    }

    // Check if already exists (by first 30 chars)
    if (comments.some(c => c.text.slice(0, 30) === cleanText.slice(0, 30))) {
        return;
    }

    // Check if this is our formatted comment (On "text":)
    const ourFormatMatch = text.match(/On\s+[""`]([^""`]+)[""`]:/);
    let selectedText = '';
    let commentText = cleanText;

    if (ourFormatMatch) {
        selectedText = ourFormatMatch[1];
        // Get text after the quote
        const afterMatch = text.slice(text.indexOf(ourFormatMatch[0]) + ourFormatMatch[0].length);
        const quoteMatch = afterMatch.match(/>\s*[""]([^""]+)[""]/);
        if (quoteMatch) {
            commentText = afterMatch.slice(afterMatch.indexOf(quoteMatch[0]) + quoteMatch[0].length).trim();
        } else {
            commentText = afterMatch.trim();
        }
    }

    comments.push({
        id: id || `gh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        text: commentText.slice(0, 300),
        selectedText: selectedText.slice(0, 100),
        filePath: 'document.md',
        startOffset: 0,
        endOffset: 0,
        timestamp: Date.now(),
        postedToGitHub: true,
    });

    console.log(`[MD Review] Added comment: "${commentText.slice(0, 40)}..."`);
}

function loadComments(): void {
    const key = `md-review-${getPRKey()}`;
    try {
        const saved = localStorage.getItem(key);
        if (saved) {
            comments = JSON.parse(saved);
            console.log(`[MD Review] Loaded ${comments.length} comments from storage`);
        }
    } catch (e) {
        console.error('[MD Review] Failed to load comments:', e);
    }
}

function saveComments(): void {
    const key = `md-review-${getPRKey()}`;
    try {
        localStorage.setItem(key, JSON.stringify(comments));
        console.log(`[MD Review] Saved ${comments.length} comments`);
    } catch (e) {
        console.error('[MD Review] Failed to save:', e);
    }
}

function observeRichDiffViews(): void {
    let debounceTimer: number | null = null;

    const observer = new MutationObserver(() => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(() => {
            processExistingRichDiffs();
            if (comments.length > 0) renderCommentsSidebar();
        }, 300);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Listen for rich diff toggle clicks
    document.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const button = target.closest('button, [role="button"]');
        if (button?.textContent?.toLowerCase().includes('rich diff') ||
            button?.textContent?.toLowerCase().includes('display the source')) {
            setTimeout(processExistingRichDiffs, 500);
        }
    }, true);
}

function processExistingRichDiffs(): void {
    const selectors = ['.markdown-body', '.js-rendered-markdown', '.prose', '[data-paste-markdown-skip]'];
    let found = 0;

    for (const selector of selectors) {
        document.querySelectorAll(selector).forEach((el) => {
            if (el instanceof HTMLElement && !el.dataset.mdReviewEnabled) {
                if (el.offsetHeight < 50) return;
                el.dataset.mdReviewEnabled = 'true';
                el.classList.add('md-review-selectable');
                addLineHoverButtons(el);
                found++;
            }
        });
    }

    if (found > 0) {
        console.log(`[MD Review] Enabled commenting on ${found} elements`);
    }
}

function addLineHoverButtons(container: HTMLElement): void {
    const blocks = container.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, td');

    blocks.forEach((block, index) => {
        if (block instanceof HTMLElement && !block.dataset.mdReviewLine) {
            block.dataset.mdReviewLine = String(index);
            block.classList.add('md-review-block');

            const plusBtn = document.createElement('button');
            plusBtn.className = 'md-review-plus-btn';
            plusBtn.innerHTML = '+';
            plusBtn.title = 'Add comment on this line';

            plusBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const text = block.textContent?.trim().slice(0, 100) || '';
                const rect = block.getBoundingClientRect();
                showCommentBox({
                    text,
                    filePath: getFilePathForElement(container) || 'README.md',
                    startOffset: index * 1000,
                    endOffset: index * 1000 + text.length,
                    rect: new DOMRect(rect.left, rect.top, rect.width, rect.height),
                }, index);
            });

            block.style.position = 'relative';
            block.appendChild(plusBtn);

            // Check if there are comments for this line and show indicator
            showLineCommentIndicator(block, index, container);
        }
    });
}

function showLineCommentIndicator(block: HTMLElement, lineIndex: number, container: HTMLElement): void {
    const blockText = block.textContent?.trim().toLowerCase() || '';

    // Find comments that might be for this line
    const lineComments = comments.filter(c => {
        // Match by line index
        if (c.startOffset === lineIndex * 1000) return true;

        // Match by text content (fuzzy)
        if (c.selectedText && blockText.includes(c.selectedText.toLowerCase().slice(0, 20))) return true;

        // Match if comment text mentions this line's content
        const firstWords = blockText.split(' ').slice(0, 3).join(' ');
        if (firstWords.length > 5 && c.text.toLowerCase().includes(firstWords)) return true;

        return false;
    });

    if (lineComments.length > 0) {
        // Remove existing indicator
        block.querySelector('.md-review-line-indicator')?.remove();

        const indicator = document.createElement('span');
        indicator.className = 'md-review-line-indicator';
        indicator.innerHTML = `💬 ${lineComments.length}`;
        indicator.title = lineComments.map(c => c.text.slice(0, 50)).join('\n---\n');

        indicator.addEventListener('click', (e) => {
            e.stopPropagation();
            showLineCommentsPopup(block, lineComments);
        });

        block.appendChild(indicator);
    }
}

function showLineCommentsPopup(block: HTMLElement, lineComments: Comment[]): void {
    // Remove existing popup
    document.querySelectorAll('.md-review-line-popup').forEach(el => el.remove());

    const popup = document.createElement('div');
    popup.className = 'md-review-line-popup';

    let html = '<div class="md-review-popup-header">Comments on this line</div>';
    lineComments.forEach(c => {
        html += `
      <div class="md-review-popup-comment">
        ${c.selectedText ? `<div class="md-review-popup-quote">"${escapeHtml(c.selectedText.slice(0, 60))}"</div>` : ''}
        <div class="md-review-popup-text">${escapeHtml(c.text.slice(0, 200))}</div>
      </div>
    `;
    });

    popup.innerHTML = html;

    // Position near the block
    const rect = block.getBoundingClientRect();
    popup.style.top = `${rect.bottom + window.scrollY + 5}px`;
    popup.style.left = `${rect.left + window.scrollX}px`;

    // Close on click outside
    const closeHandler = (e: MouseEvent) => {
        if (!popup.contains(e.target as Node)) {
            popup.remove();
            document.removeEventListener('click', closeHandler);
        }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 10);

    document.body.appendChild(popup);
}

function renderCommentsSidebar(): void {
    // Remove existing sidebar
    document.querySelectorAll('.md-review-comments-sidebar').forEach(el => el.remove());

    if (comments.length === 0) return;

    const sidebar = document.createElement('div');
    sidebar.className = 'md-review-comments-sidebar';
    sidebar.innerHTML = `
    <div class="md-review-sidebar-header">
      <span>💬 Comments (${comments.length})</span>
      <button class="md-review-sidebar-toggle" data-action="toggle">−</button>
    </div>
    <div class="md-review-sidebar-content"></div>
  `;

    const content = sidebar.querySelector('.md-review-sidebar-content')!;

    comments.forEach((comment) => {
        const item = document.createElement('div');
        item.className = 'md-review-sidebar-comment';
        item.innerHTML = `
      <div class="md-review-comment-file">${escapeHtml(comment.filePath)}</div>
      <div class="md-review-comment-quote">"${escapeHtml(comment.selectedText.slice(0, 60))}${comment.selectedText.length > 60 ? '...' : ''}"</div>
      <div class="md-review-comment-text">${escapeHtml(comment.text)}</div>
      <div class="md-review-comment-actions">
        <button class="md-review-btn-small" data-action="copy" data-id="${comment.id}">Copy to PR</button>
        <button class="md-review-btn-small md-review-btn-danger" data-action="delete" data-id="${comment.id}">Delete</button>
      </div>
      ${!comment.postedToGitHub ? '<div class="md-review-comment-status">⚠️ Not yet posted to GitHub</div>' : ''}
    `;
        content.appendChild(item);
    });

    sidebar.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const action = target.dataset.action;
        const id = target.dataset.id;

        if (action === 'toggle') {
            sidebar.classList.toggle('md-review-sidebar-collapsed');
            target.textContent = sidebar.classList.contains('md-review-sidebar-collapsed') ? '+' : '−';
        } else if (action === 'delete' && id) {
            deleteComment(id);
        } else if (action === 'copy' && id) {
            copyCommentToClipboard(id);
        }
    });

    document.body.appendChild(sidebar);
}

function deleteComment(id: string): void {
    comments = comments.filter(c => c.id !== id);
    saveComments();
    renderCommentsSidebar();
    showNotification('Comment deleted');
}

function copyCommentToClipboard(id: string): void {
    const comment = comments.find(c => c.id === id);
    if (!comment) return;

    const text = formatCommentForGitHub(comment);
    navigator.clipboard.writeText(text).then(() => {
        showNotification('Copied! Paste in PR comment box.');
    });
}

function formatCommentForGitHub(comment: Comment): string {
    return `**On \`${comment.filePath}\`:**\n\n> "${comment.selectedText.slice(0, 100)}${comment.selectedText.length > 100 ? '...' : ''}"\n\n${comment.text}`;
}

function handleTextSelection(event: MouseEvent): void {
    // Don't close if clicking inside the comment box
    if (activeCommentBox && activeCommentBox.contains(event.target as Node)) {
        return;
    }

    // Close existing comment box if clicking elsewhere
    if (activeCommentBox) {
        closeCommentBox();
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    const markdownBody = findMarkdownBody(range.commonAncestorContainer);
    if (!markdownBody) return;

    const selectedText = selection.toString().trim();
    if (!selectedText || selectedText.length < 2) return;

    const filePath = getFilePathForElement(markdownBody);
    if (!filePath) return;

    showCommentBox({
        text: selectedText,
        filePath,
        startOffset: getTextOffset(markdownBody, range.startContainer, range.startOffset),
        endOffset: getTextOffset(markdownBody, range.endContainer, range.endOffset),
        rect: range.getBoundingClientRect(),
    });
}

function findMarkdownBody(node: Node): HTMLElement | null {
    let current: Node | null = node;
    while (current) {
        if (current instanceof HTMLElement && current.dataset.mdReviewEnabled) {
            return current;
        }
        current = current.parentNode;
    }
    return null;
}

function getFilePathForElement(element: HTMLElement): string {
    let current: HTMLElement | null = element;

    while (current) {
        // Look for file path in various places
        const pathEl = current.querySelector('[data-path]');
        if (pathEl instanceof HTMLElement && pathEl.dataset.path) {
            return cleanPath(pathEl.dataset.path);
        }

        // Look for links with file titles
        const links = current.querySelectorAll('a[title]');
        for (const link of links) {
            const title = link.getAttribute('title');
            if (title && (title.endsWith('.md') || title.endsWith('.txt'))) {
                return cleanPath(title);
            }
        }

        // Look in the diff header
        const diffHeader = current.querySelector('.file-header, .Diff-module__header, [data-file-header]');
        if (diffHeader) {
            const text = diffHeader.textContent;
            const match = text?.match(/([^\s]+\.md)/);
            if (match) return cleanPath(match[1]);
        }

        current = current.parentElement;
    }

    // Fallback: look for any .md file mentioned in nearby context
    const pageText = document.querySelector('.file-info, .file-header')?.textContent || '';
    const mdMatch = pageText.match(/([^\s]+\.md)/);
    if (mdMatch) return cleanPath(mdMatch[1]);

    return 'document.md';
}

function cleanPath(path: string): string {
    return path.replace(/[\u200B-\u200D\u200E\u200F\uFEFF]/g, '').trim();
}

function getTextOffset(container: HTMLElement, node: Node, offset: number): number {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let totalOffset = 0;
    let currentNode: Node | null;

    while ((currentNode = walker.nextNode())) {
        if (currentNode === node) return totalOffset + offset;
        totalOffset += currentNode.textContent?.length || 0;
    }
    return offset;
}

function showCommentBox(selection: SelectionInfo, lineIndex?: number): void {
    closeCommentBox();

    const box = document.createElement('div');
    box.className = 'md-review-comment-box';
    box.innerHTML = `
    <div class="md-review-comment-header">
      <span class="md-review-selected-text" title="${escapeHtml(selection.text)}">
        "${selection.text.length > 40 ? selection.text.slice(0, 40) + '...' : selection.text}"
      </span>
      <button class="md-review-close-btn" data-action="close">×</button>
    </div>
    <textarea class="md-review-textarea" placeholder="Add your comment..." rows="3"></textarea>
    <div class="md-review-comment-footer">
      <span class="md-review-hint">${selection.filePath}</span>
      <div class="md-review-actions">
        <button class="md-review-btn md-review-btn-secondary" data-action="cancel">Cancel</button>
        <button class="md-review-btn md-review-btn-primary" data-action="submit">Add Comment</button>
      </div>
    </div>
  `;

    // Position the box
    const top = selection.rect.bottom + window.scrollY + 8;
    const left = Math.max(10, Math.min(selection.rect.left + window.scrollX, window.innerWidth - 360));
    box.style.top = `${top}px`;
    box.style.left = `${left}px`;

    box.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = (e.target as HTMLElement).dataset.action;
        if (action === 'close' || action === 'cancel') {
            closeCommentBox();
            window.getSelection()?.removeAllRanges();
        } else if (action === 'submit') {
            const textarea = box.querySelector('.md-review-textarea') as HTMLTextAreaElement;
            const text = textarea.value.trim();
            if (text) {
                addComment(selection, text);
                closeCommentBox();
                window.getSelection()?.removeAllRanges();
            }
        }
    });

    const textarea = box.querySelector('.md-review-textarea') as HTMLTextAreaElement;
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            const text = textarea.value.trim();
            if (text) {
                addComment(selection, text);
                closeCommentBox();
                window.getSelection()?.removeAllRanges();
            }
        } else if (e.key === 'Escape') {
            closeCommentBox();
        }
    });

    // Prevent mouseup from triggering new selection handler
    box.addEventListener('mouseup', (e) => e.stopPropagation());

    document.body.appendChild(box);
    activeCommentBox = box;
    setTimeout(() => textarea.focus(), 10);
}

function addComment(selection: SelectionInfo, text: string): void {
    const comment: Comment = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text,
        selectedText: selection.text,
        filePath: selection.filePath,
        startOffset: selection.startOffset,
        endOffset: selection.endOffset,
        timestamp: Date.now(),
        postedToGitHub: false,
    };

    comments.push(comment);
    saveComments();
    renderCommentsSidebar();

    // Try to post to GitHub
    postToGitHub(comment);
}

function postToGitHub(comment: Comment): void {
    const formattedComment = formatCommentForGitHub(comment);

    // Find GitHub's comment form - try multiple selectors
    const formSelectors = [
        'form.js-new-comment-form',
        'form[action*="comments"]',
        '#new_comment_form',
        '.timeline-comment-wrapper form',
    ];

    let form: HTMLFormElement | null = null;
    let textarea: HTMLTextAreaElement | null = null;

    for (const selector of formSelectors) {
        form = document.querySelector(selector) as HTMLFormElement;
        if (form) {
            textarea = form.querySelector('textarea') as HTMLTextAreaElement;
            if (textarea && textarea.offsetParent !== null) break;
            form = null;
        }
    }

    // Also try finding textarea directly
    if (!textarea) {
        const textareaSelectors = [
            '#new_comment_field',
            'textarea[name="comment[body]"]',
            'textarea.comment-form-textarea',
        ];
        for (const sel of textareaSelectors) {
            textarea = document.querySelector(sel) as HTMLTextAreaElement;
            if (textarea && textarea.offsetParent !== null) {
                form = textarea.closest('form');
                break;
            }
        }
    }

    if (!textarea) {
        // Fallback: copy to clipboard
        navigator.clipboard.writeText(formattedComment).then(() => {
            showNotification('Copied! Scroll down and paste in comment box.');
        });
        return;
    }

    // Fill the textarea
    textarea.value = formattedComment;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));

    // Find and click the submit button
    const submitBtn = form?.querySelector('button[type="submit"]:not([disabled])') as HTMLButtonElement ||
        form?.querySelector('.btn-primary:not([disabled])') as HTMLButtonElement;

    if (submitBtn) {
        // Scroll to form first
        textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });

        setTimeout(() => {
            submitBtn.click();
            comment.postedToGitHub = true;
            saveComments();

            setTimeout(() => {
                renderCommentsSidebar();
                showNotification('Comment posted to GitHub!');
                // Reload comments from page
                setTimeout(loadExistingGitHubComments, 2000);
            }, 1000);
        }, 500);
    } else {
        textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
        textarea.focus();
        showNotification('Comment filled. Click "Comment" button to post.');
    }
}

function closeCommentBox(): void {
    activeCommentBox?.remove();
    activeCommentBox = null;
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showNotification(message: string, type: 'success' | 'error' = 'success'): void {
    document.querySelectorAll('.md-review-notification').forEach(el => el.remove());

    const notification = document.createElement('div');
    notification.className = `md-review-notification md-review-notification-${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
        notification.classList.add('md-review-notification-hide');
        setTimeout(() => notification.remove(), 300);
    }, 4000);
}

// Initialize
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
} else {
    document.addEventListener('DOMContentLoaded', init);
}
