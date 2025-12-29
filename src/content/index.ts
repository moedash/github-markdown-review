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

function loadExistingGitHubComments(): void {
    // Inject script to access GitHub's internal state
    const script = document.createElement('script');
    script.textContent = `
    (function() {
      // Try to find GitHub's comment data
      let commentsData = [];
      
      // Method 1: Check for embedded JSON data
      const scripts = document.querySelectorAll('script[type="application/json"]');
      scripts.forEach(s => {
        try {
          const data = JSON.parse(s.textContent);
          if (data.comments) commentsData = commentsData.concat(data.comments);
          if (data.issueComments) commentsData = commentsData.concat(data.issueComments);
        } catch(e) {}
      });
      
      // Method 2: Look for React fiber/state
      const reactRoot = document.querySelector('[data-turbo-body]') || document.getElementById('repo-content-turbo-frame');
      if (reactRoot && reactRoot._reactRootContainer) {
        console.log('[MD Review] Found React root');
      }
      
      // Method 3: Find timeline items with comment data
      const timelineItems = document.querySelectorAll('.js-timeline-item, [data-gid]');
      timelineItems.forEach(item => {
        const bodyEl = item.querySelector('.comment-body, .js-comment-body');
        if (bodyEl) {
          const gid = item.getAttribute('data-gid') || item.id;
          commentsData.push({
            id: gid,
            body: bodyEl.innerHTML,
            text: bodyEl.textContent
          });
        }
      });
      
      // Send back to content script
      window.postMessage({ type: 'MD_REVIEW_COMMENTS', comments: commentsData }, '*');
    })();
  `;
    document.head.appendChild(script);
    script.remove();

    // Listen for response
    window.addEventListener('message', handleGitHubComments);

    // Also scan DOM directly as fallback
    scanDOMForComments();
}

function handleGitHubComments(event: MessageEvent): void {
    if (event.data.type !== 'MD_REVIEW_COMMENTS') return;

    const ghComments = event.data.comments || [];
    console.log(`[MD Review] Received ${ghComments.length} comments from page context`);

    ghComments.forEach((c: any) => {
        if (c.text) {
            parseAndAddComment(c.text, c.id);
        }
    });

    if (comments.length > 0) {
        renderCommentsSidebar();
    }
}

function scanDOMForComments(): void {
    // Scan all elements that might contain comments
    const containers = document.querySelectorAll(
        '.js-discussion, .js-timeline-item, .review-comment, .timeline-comment, ' +
        '[data-gid], .js-comment, .comment, .issue-comment'
    );

    console.log(`[MD Review] Scanning ${containers.length} potential comment containers`);

    containers.forEach((container) => {
        const bodyEl = container.querySelector('.comment-body, .js-comment-body, .markdown-body');
        if (bodyEl) {
            const text = bodyEl.textContent || '';
            const id = container.getAttribute('data-gid') || container.id || '';
            parseAndAddComment(text, id);
        }
    });

    // Also check for inline review comments in diff view
    const reviewComments = document.querySelectorAll('.review-comment-contents, .inline-comment-form-container');
    reviewComments.forEach((rc) => {
        const text = rc.textContent || '';
        parseAndAddComment(text, '');
    });

    if (comments.length > 0) {
        console.log(`[MD Review] Total comments loaded: ${comments.length}`);
        renderCommentsSidebar();
    }
}

function parseAndAddComment(text: string, id: string): void {
    // Look for our comment format: On "selected text": or quoted text
    const patterns = [
        /On\s+[""`]([^""`]+)[""`]:/,
        /On\s+`([^`]+)`:/,
        />\s*[""]([^""]+)[""]/,
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
            const selectedText = match[1];

            // Check if already exists
            if (comments.some(c => c.selectedText.slice(0, 20) === selectedText.slice(0, 20))) {
                return;
            }

            // Extract the actual comment (text after the match)
            const afterMatch = text.slice(text.indexOf(match[0]) + match[0].length).trim();
            if (afterMatch.length < 3) return;

            comments.push({
                id: id || `gh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                text: afterMatch.slice(0, 300),
                selectedText: selectedText.slice(0, 100),
                filePath: 'document.md',
                startOffset: 0,
                endOffset: 0,
                timestamp: Date.now(),
                postedToGitHub: true,
            });

            console.log(`[MD Review] Parsed comment on "${selectedText.slice(0, 30)}..."`);
            return;
        }
    }
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
            plusBtn.title = 'Add comment on this section';

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
        }
    });
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
