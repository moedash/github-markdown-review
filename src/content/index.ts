// Content script - adds inline commenting to GitHub's rich diff view
// No local storage - all comments go directly to GitHub
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
    author?: string;
}

let activeCommentBox: HTMLElement | null = null;
let comments: Comment[] = [];

function init(): void {
    console.log('[MD Review] Initializing...');

    // Load comments from GitHub
    loadCommentsFromGitHub();

    // Add selection listener
    document.addEventListener('mouseup', handleTextSelection);

    // Watch for rich diff views
    observeRichDiffViews();

    // Process existing rich diffs
    processExistingRichDiffs();
}

async function loadCommentsFromGitHub(): Promise<void> {
    comments = []; // Reset

    const match = window.location.pathname.match(/\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) return;

    const [, owner, repo, prNumber] = match;

    try {
        // Fetch timeline (contains all PR comments)
        const timelineUrl = `/${owner}/${repo}/pull/${prNumber}/timeline`;
        const resp = await fetch(timelineUrl, { headers: { 'Accept': 'text/html' } });

        if (resp.ok) {
            const html = await resp.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            // Find all comments
            const commentContainers = doc.querySelectorAll('.timeline-comment, .review-comment, .js-comment');
            console.log(`[MD Review] Found ${commentContainers.length} comment containers in timeline`);

            commentContainers.forEach((container) => {
                const bodyEl = container.querySelector('.comment-body, .js-comment-body');
                const authorEl = container.querySelector('.author, [data-hovercard-type="user"]');

                if (bodyEl?.textContent) {
                    const text = bodyEl.textContent.trim();
                    const author = authorEl?.textContent?.trim() || '';

                    // Skip template text
                    if (text.includes('What changed?') || text.includes('Nothing to preview')) return;
                    if (text.length < 5) return;

                    // Check for our format: On "text":
                    const onMatch = text.match(/On\s+["`]([^"`]+)["`]:/);
                    const quoteMatch = text.match(/>\s*"([^"]+)"/);

                    let selectedText = '';
                    let commentText = text;

                    if (onMatch || quoteMatch) {
                        selectedText = onMatch?.[1] || quoteMatch?.[1] || '';
                        // Get the comment after the quote
                        const quoteIdx = text.indexOf('>');
                        if (quoteIdx > -1) {
                            const afterQuote = text.slice(quoteIdx);
                            const endQuote = afterQuote.indexOf('"', afterQuote.indexOf('"') + 1);
                            if (endQuote > -1) {
                                commentText = afterQuote.slice(endQuote + 1).trim();
                            }
                        }
                    }

                    // Check for duplicates
                    if (comments.some(c => c.text.slice(0, 30) === commentText.slice(0, 30))) return;

                    comments.push({
                        id: `gh-${comments.length}`,
                        text: commentText.slice(0, 300),
                        selectedText: selectedText.slice(0, 100),
                        filePath: onMatch?.[1]?.includes('.') ? onMatch[1] : 'document.md',
                        author,
                    });

                    console.log(`[MD Review] Loaded comment: "${commentText.slice(0, 40)}..."`);
                }
            });
        }
    } catch (e) {
        console.log('[MD Review] Error loading comments:', e);
    }

    if (comments.length > 0) {
        console.log(`[MD Review] Total: ${comments.length} comments`);
        renderCommentsSidebar();
        updateLineIndicators();
    }
}

function updateLineIndicators(): void {
    document.querySelectorAll('[data-md-review-enabled]').forEach(container => {
        if (container instanceof HTMLElement) {
            container.querySelectorAll('[data-md-review-line]').forEach((block, index) => {
                if (block instanceof HTMLElement) {
                    showLineCommentIndicator(block, index);
                }
            });
        }
    });
}

function observeRichDiffViews(): void {
    let debounceTimer: number | null = null;

    const observer = new MutationObserver(() => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(() => {
            processExistingRichDiffs();
            updateLineIndicators();
        }, 300);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Listen for rich diff toggle clicks
    document.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const button = target.closest('button, [role="button"]');
        if (button?.textContent?.toLowerCase().includes('rich diff') ||
            button?.textContent?.toLowerCase().includes('display the source')) {
            setTimeout(() => {
                processExistingRichDiffs();
                updateLineIndicators();
            }, 500);
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
                });
            });

            block.style.position = 'relative';
            block.appendChild(plusBtn);

            // Show existing comment indicators
            showLineCommentIndicator(block, index);
        }
    });
}

function showLineCommentIndicator(block: HTMLElement, lineIndex: number): void {
    const blockText = block.textContent?.trim().toLowerCase() || '';

    // Find comments that might be for this line
    const lineComments = comments.filter(c => {
        // Match by selected text
        if (c.selectedText && blockText.includes(c.selectedText.toLowerCase().slice(0, 20))) return true;

        // Match if comment mentions this line's content
        const firstWords = blockText.split(' ').slice(0, 3).join(' ');
        if (firstWords.length > 5 && c.text.toLowerCase().includes(firstWords)) return true;

        return false;
    });

    // Remove existing indicator
    block.querySelector('.md-review-line-indicator')?.remove();

    if (lineComments.length > 0) {
        const indicator = document.createElement('span');
        indicator.className = 'md-review-line-indicator';
        indicator.innerHTML = `💬 ${lineComments.length}`;
        indicator.title = lineComments.map(c => `${c.author ? c.author + ': ' : ''}${c.text.slice(0, 50)}`).join('\n---\n');

        indicator.addEventListener('click', (e) => {
            e.stopPropagation();
            showLineCommentsPopup(block, lineComments);
        });

        block.appendChild(indicator);
    }
}

function showLineCommentsPopup(block: HTMLElement, lineComments: Comment[]): void {
    document.querySelectorAll('.md-review-line-popup').forEach(el => el.remove());

    const popup = document.createElement('div');
    popup.className = 'md-review-line-popup';

    let html = '<div class="md-review-popup-header">Comments on this line</div>';
    lineComments.forEach(c => {
        html += `
      <div class="md-review-popup-comment">
        ${c.author ? `<div class="md-review-popup-author">${escapeHtml(c.author)}</div>` : ''}
        ${c.selectedText ? `<div class="md-review-popup-quote">"${escapeHtml(c.selectedText.slice(0, 60))}"</div>` : ''}
        <div class="md-review-popup-text">${escapeHtml(c.text.slice(0, 200))}</div>
      </div>
    `;
    });

    popup.innerHTML = html;

    const rect = block.getBoundingClientRect();
    popup.style.top = `${rect.bottom + window.scrollY + 5}px`;
    popup.style.left = `${rect.left + window.scrollX}px`;

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
    document.querySelectorAll('.md-review-comments-sidebar').forEach(el => el.remove());

    if (comments.length === 0) return;

    const sidebar = document.createElement('div');
    sidebar.className = 'md-review-comments-sidebar';
    sidebar.innerHTML = `
    <div class="md-review-sidebar-header">
      <span>💬 PR Comments (${comments.length})</span>
      <button class="md-review-sidebar-toggle" data-action="toggle">−</button>
    </div>
    <div class="md-review-sidebar-content"></div>
  `;

    const content = sidebar.querySelector('.md-review-sidebar-content')!;

    comments.forEach((comment) => {
        const item = document.createElement('div');
        item.className = 'md-review-sidebar-comment';
        item.innerHTML = `
      ${comment.author ? `<div class="md-review-comment-author">${escapeHtml(comment.author)}</div>` : ''}
      ${comment.selectedText ? `<div class="md-review-comment-quote">"${escapeHtml(comment.selectedText.slice(0, 60))}"</div>` : ''}
      <div class="md-review-comment-text">${escapeHtml(comment.text)}</div>
    `;
        content.appendChild(item);
    });

    sidebar.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.dataset.action === 'toggle') {
            sidebar.classList.toggle('md-review-sidebar-collapsed');
            target.textContent = sidebar.classList.contains('md-review-sidebar-collapsed') ? '+' : '−';
        }
    });

    document.body.appendChild(sidebar);
}

function handleTextSelection(event: MouseEvent): void {
    if (activeCommentBox && activeCommentBox.contains(event.target as Node)) return;
    if (activeCommentBox) closeCommentBox();

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
        startOffset: 0,
        endOffset: 0,
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
        const pathEl = current.querySelector('[data-path]');
        if (pathEl instanceof HTMLElement && pathEl.dataset.path) {
            return cleanPath(pathEl.dataset.path);
        }

        const links = current.querySelectorAll('a[title]');
        for (const link of links) {
            const title = link.getAttribute('title');
            if (title && title.endsWith('.md')) return cleanPath(title);
        }

        const diffHeader = current.querySelector('.file-header, [data-file-header]');
        if (diffHeader) {
            const match = diffHeader.textContent?.match(/([^\s]+\.md)/);
            if (match) return cleanPath(match[1]);
        }

        current = current.parentElement;
    }

    const pageText = document.querySelector('.file-info, .file-header')?.textContent || '';
    const mdMatch = pageText.match(/([^\s]+\.md)/);
    if (mdMatch) return cleanPath(mdMatch[1]);

    return 'document.md';
}

function cleanPath(path: string): string {
    return path.replace(/[\u200B-\u200D\u200E\u200F\uFEFF]/g, '').trim();
}

function showCommentBox(selection: SelectionInfo): void {
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
        <button class="md-review-btn md-review-btn-primary" data-action="submit">Post to GitHub</button>
      </div>
    </div>
  `;

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
                postCommentToGitHub(selection, text);
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
                postCommentToGitHub(selection, text);
                closeCommentBox();
                window.getSelection()?.removeAllRanges();
            }
        } else if (e.key === 'Escape') {
            closeCommentBox();
        }
    });

    box.addEventListener('mouseup', (e) => e.stopPropagation());

    document.body.appendChild(box);
    activeCommentBox = box;
    setTimeout(() => textarea.focus(), 10);
}

function postCommentToGitHub(selection: SelectionInfo, commentText: string): void {
    // Format the comment with our metadata
    const formattedComment = `**On \`${selection.filePath}\`:**\n\n> "${selection.text.slice(0, 100)}${selection.text.length > 100 ? '...' : ''}"\n\n${commentText}`;

    // Find GitHub's comment form
    const textarea = findGitHubCommentTextarea();

    if (!textarea) {
        // Fallback: copy to clipboard
        navigator.clipboard.writeText(formattedComment).then(() => {
            showNotification('Copied! Scroll down and paste in the comment box.');
        });
        return;
    }

    // Fill the form
    textarea.value = formattedComment;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));

    // Find submit button
    const form = textarea.closest('form');
    const submitBtn = form?.querySelector('button[type="submit"]:not([disabled]), .btn-primary:not([disabled])') as HTMLButtonElement;

    if (submitBtn) {
        textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });

        setTimeout(() => {
            submitBtn.click();
            showNotification('Posting comment...');

            // Reload comments after posting
            setTimeout(() => {
                loadCommentsFromGitHub();
                showNotification('Comment posted!');
            }, 2000);
        }, 300);
    } else {
        textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
        textarea.focus();
        showNotification('Comment filled. Click "Comment" to post.');
    }
}

function findGitHubCommentTextarea(): HTMLTextAreaElement | null {
    const selectors = [
        '#new_comment_field',
        'textarea[name="comment[body]"]',
        'textarea.comment-form-textarea',
        '.js-new-comment-form textarea',
    ];

    for (const sel of selectors) {
        const textarea = document.querySelector(sel) as HTMLTextAreaElement;
        if (textarea && textarea.offsetParent !== null) {
            return textarea;
        }
    }
    return null;
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

function showNotification(message: string): void {
    document.querySelectorAll('.md-review-notification').forEach(el => el.remove());

    const notification = document.createElement('div');
    notification.className = 'md-review-notification';
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
        notification.classList.add('md-review-notification-hide');
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// Initialize
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
} else {
    document.addEventListener('DOMContentLoaded', init);
}
