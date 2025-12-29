// Content script - adds inline commenting to GitHub's rich diff view
// Posts comments directly to GitHub PR

import './styles.css';

console.log('[MD Review] Content script loaded');

interface SelectionInfo {
    text: string;
    filePath: string;
    startOffset: number;
    endOffset: number;
    rect: DOMRect;
    element?: HTMLElement;
}

interface ParsedComment {
    id: string;
    body: string;
    author: string;
    createdAt: string;
    metadata: {
        file: string;
        start: number;
        end: number;
        text: string;
    } | null;
}

let activeCommentBox: HTMLElement | null = null;

function init(): void {
    console.log('[MD Review] Initializing...');

    // Add selection listener
    document.addEventListener('mouseup', handleTextSelection);

    // Watch for rich diff views
    observeRichDiffViews();

    // Process existing rich diffs
    processExistingRichDiffs();

    // Load and display existing comments
    setTimeout(loadAndDisplayComments, 500);
}

function observeRichDiffViews(): void {
    let debounceTimer: number | null = null;

    const observer = new MutationObserver(() => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(() => {
            processExistingRichDiffs();
        }, 200);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Listen for rich diff toggle clicks
    document.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const button = target.closest('button, [role="button"]');
        if (button?.textContent?.toLowerCase().includes('rich diff') ||
            button?.textContent?.toLowerCase().includes('display the source')) {
            setTimeout(processExistingRichDiffs, 300);
            setTimeout(() => loadAndDisplayComments(), 500);
        }
    }, true);
}

function processExistingRichDiffs(): void {
    const selectors = ['.markdown-body', '.js-rendered-markdown', '.prose'];

    for (const selector of selectors) {
        document.querySelectorAll(selector).forEach((el) => {
            if (el instanceof HTMLElement && !el.dataset.mdReviewEnabled) {
                if (el.offsetHeight < 50) return;
                el.dataset.mdReviewEnabled = 'true';
                el.classList.add('md-review-selectable');
                addLineHoverButtons(el);
            }
        });
    }
}

function addLineHoverButtons(container: HTMLElement): void {
    const blocks = container.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre');

    blocks.forEach((block, index) => {
        if (block instanceof HTMLElement && !block.dataset.mdReviewLine) {
            block.dataset.mdReviewLine = String(index);
            block.classList.add('md-review-block');

            const plusBtn = document.createElement('button');
            plusBtn.className = 'md-review-plus-btn';
            plusBtn.innerHTML = '+';
            plusBtn.title = 'Add comment on this section';

            plusBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const text = block.textContent?.trim().slice(0, 100) || '';
                const rect = block.getBoundingClientRect();
                showCommentBox({
                    text,
                    filePath: getFilePathForElement(container) || 'unknown',
                    startOffset: index * 1000,
                    endOffset: index * 1000 + text.length,
                    rect: new DOMRect(rect.left, rect.top, rect.width, rect.height),
                    element: block,
                });
            });

            block.style.position = 'relative';
            block.appendChild(plusBtn);
        }
    });
}

function loadAndDisplayComments(): void {
    const comments = parseExistingComments();
    console.log(`[MD Review] Found ${comments.length} MD Review comments on this PR`);

    if (comments.length > 0) {
        renderCommentsSidebar(comments);
    }
}

function parseExistingComments(): ParsedComment[] {
    const comments: ParsedComment[] = [];

    // Find all comment bodies on the page
    const commentBodies = document.querySelectorAll('.comment-body, .js-comment-body, .markdown-body.comment-body');

    commentBodies.forEach((el, index) => {
        const text = el.textContent || '';

        // Check for our metadata marker
        const metadataMatch = text.match(/\[\/\/\]: # \(md-review:(.*?)\)/);
        if (metadataMatch) {
            try {
                const metadata = JSON.parse(metadataMatch[1]);
                const commentContainer = el.closest('.timeline-comment, .review-comment');
                const authorEl = commentContainer?.querySelector('.author');
                const timeEl = commentContainer?.querySelector('relative-time');

                // Extract the actual comment (after the metadata and "On..." line)
                const bodyMatch = text.match(/\*\*On ".*?":\*\*\s*([\s\S]*)/);
                const cleanBody = bodyMatch ? bodyMatch[1].trim() : text.replace(/\[\/\/\]: # \(md-review:.*?\)/, '').trim();

                comments.push({
                    id: `gh-${index}`,
                    body: cleanBody,
                    author: authorEl?.textContent?.trim() || 'unknown',
                    createdAt: timeEl?.getAttribute('datetime') || '',
                    metadata,
                });
            } catch (e) {
                // Invalid JSON, skip
            }
        }
    });

    return comments;
}

function renderCommentsSidebar(comments: ParsedComment[]): void {
    // Remove existing sidebar
    document.querySelectorAll('.md-review-comments-sidebar').forEach(el => el.remove());

    const sidebar = document.createElement('div');
    sidebar.className = 'md-review-comments-sidebar';
    sidebar.innerHTML = `
    <div class="md-review-sidebar-header">
      <span>💬 MD Review Comments (${comments.length})</span>
      <button class="md-review-sidebar-toggle" data-action="toggle">−</button>
    </div>
    <div class="md-review-sidebar-content"></div>
  `;

    const content = sidebar.querySelector('.md-review-sidebar-content')!;

    comments.forEach((comment) => {
        const item = document.createElement('div');
        item.className = 'md-review-sidebar-comment';
        item.innerHTML = `
      <div class="md-review-comment-meta">
        <strong>${escapeHtml(comment.author)}</strong>
        ${comment.createdAt ? `<span class="md-review-comment-time">${formatDate(comment.createdAt)}</span>` : ''}
      </div>
      ${comment.metadata ? `<div class="md-review-comment-quote">"${escapeHtml(comment.metadata.text.slice(0, 60))}${comment.metadata.text.length > 60 ? '...' : ''}"</div>` : ''}
      <div class="md-review-comment-text">${escapeHtml(comment.body)}</div>
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

function formatDate(isoString: string): string {
    try {
        const date = new Date(isoString);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch {
        return '';
    }
}

function handleTextSelection(event: MouseEvent): void {
    if (activeCommentBox && !activeCommentBox.contains(event.target as Node)) {
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
        if (current instanceof HTMLElement &&
            (current.classList.contains('markdown-body') ||
                current.classList.contains('prose') ||
                current.dataset.mdReviewEnabled)) {
            return current;
        }
        current = current.parentNode;
    }
    return null;
}

function getFilePathForElement(element: HTMLElement): string | null {
    let current: HTMLElement | null = element;

    while (current) {
        const pathEl = current.querySelector('[data-path], a[title][href*="blob"]');
        if (pathEl instanceof HTMLElement) {
            const path = pathEl.dataset.path || pathEl.getAttribute('title');
            if (path) return cleanPath(path);
        }

        for (const link of current.querySelectorAll('a')) {
            const title = link.getAttribute('title');
            if (title?.endsWith('.md')) return cleanPath(title);
        }

        current = current.parentElement;
    }
    return 'README.md';
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
      <span class="md-review-hint">Posts to GitHub PR</span>
      <div class="md-review-actions">
        <button class="md-review-btn md-review-btn-secondary" data-action="cancel">Cancel</button>
        <button class="md-review-btn md-review-btn-primary" data-action="submit">Post Comment</button>
      </div>
    </div>
  `;

    box.style.top = `${selection.rect.bottom + window.scrollY + 8}px`;
    box.style.left = `${Math.min(selection.rect.left + window.scrollX, window.innerWidth - 360)}px`;

    box.addEventListener('click', (e) => {
        const action = (e.target as HTMLElement).dataset.action;
        if (action === 'close' || action === 'cancel') {
            closeCommentBox();
            window.getSelection()?.removeAllRanges();
        } else if (action === 'submit') {
            const textarea = box.querySelector('.md-review-textarea') as HTMLTextAreaElement;
            if (textarea.value.trim()) {
                postCommentToGitHub(selection, textarea.value.trim());
                closeCommentBox();
                window.getSelection()?.removeAllRanges();
            }
        }
    });

    const textarea = box.querySelector('.md-review-textarea') as HTMLTextAreaElement;
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (textarea.value.trim()) {
                postCommentToGitHub(selection, textarea.value.trim());
                closeCommentBox();
                window.getSelection()?.removeAllRanges();
            }
        } else if (e.key === 'Escape') {
            closeCommentBox();
        }
    });

    document.body.appendChild(box);
    activeCommentBox = box;
    setTimeout(() => textarea.focus(), 10);
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

function postCommentToGitHub(selection: SelectionInfo, comment: string): void {
    // Build the comment with metadata
    const metadata = {
        file: selection.filePath,
        start: selection.startOffset,
        end: selection.endOffset,
        text: selection.text.slice(0, 100),
    };

    const fullComment = `[//]: # (md-review:${JSON.stringify(metadata)})\n\n**On "${selection.text.length > 50 ? selection.text.slice(0, 50) + '...' : selection.text}":**\n\n${comment}`;

    // Find GitHub's comment form
    const form = findGitHubCommentForm();

    if (form) {
        // Fill the form
        form.textarea.value = fullComment;
        form.textarea.dispatchEvent(new Event('input', { bubbles: true }));
        form.textarea.focus();

        // Try to auto-submit
        if (form.submitButton) {
            showNotification('Submitting comment to GitHub...');
            setTimeout(() => {
                form.submitButton?.click();
                setTimeout(() => {
                    showNotification('Comment posted! Refresh to see it in the sidebar.');
                    loadAndDisplayComments();
                }, 1000);
            }, 100);
        } else {
            form.textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
            showNotification('Comment filled in form below. Click "Comment" to submit.');
        }
    } else {
        // Fallback: copy to clipboard
        navigator.clipboard.writeText(fullComment).then(() => {
            showNotification('Comment copied! Paste in the PR comment box and submit.');
        });
    }
}

interface GitHubForm {
    textarea: HTMLTextAreaElement;
    submitButton: HTMLButtonElement | null;
}

function findGitHubCommentForm(): GitHubForm | null {
    // Try various GitHub comment form selectors
    const textareaSelectors = [
        '#new_comment_field',
        'textarea[name="comment[body]"]',
        '.js-new-comment-form textarea',
        '#pull_request_review_body',
        'textarea.comment-form-textarea',
    ];

    for (const selector of textareaSelectors) {
        const textarea = document.querySelector(selector) as HTMLTextAreaElement;
        if (textarea && textarea.offsetParent !== null) {
            // Find the submit button near this textarea
            const form = textarea.closest('form');
            const submitButton = form?.querySelector('button[type="submit"]:not([disabled]), button.btn-primary:not([disabled])') as HTMLButtonElement | null;

            return { textarea, submitButton };
        }
    }

    return null;
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
    }, 3000);
}

// Initialize
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
} else {
    document.addEventListener('DOMContentLoaded', init);
}
