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

let activeCommentBox: HTMLElement | null = null;

function init(): void {
  console.log('[MD Review] Initializing...');
  
  // Add selection listener to rich diff views
  document.addEventListener('mouseup', handleTextSelection);
  
  // Watch for rich diff views being opened
  observeRichDiffViews();
  
  // Process any already-visible rich diffs
  processExistingRichDiffs();
}

function observeRichDiffViews(): void {
  let debounceTimer: number | null = null;
  
  const observer = new MutationObserver((mutations) => {
    // Debounce to avoid excessive processing
    if (debounceTimer) clearTimeout(debounceTimer);
    
    debounceTimer = window.setTimeout(() => {
      let shouldProcess = false;
      
      for (const mutation of mutations) {
        // Check added nodes
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) {
            // Check if rich diff content was added
            if (node.classList.contains('markdown-body') ||
                node.classList.contains('js-rendered-markdown') ||
                node.classList.contains('prose') ||
                node.querySelector('.markdown-body, .js-rendered-markdown, .prose')) {
              shouldProcess = true;
              break;
            }
          }
        }
        
        // Also check attribute changes (for toggles)
        if (mutation.type === 'attributes' && mutation.target instanceof HTMLElement) {
          const target = mutation.target;
          if (target.classList.contains('markdown-body') || 
              target.closest('.markdown-body')) {
            shouldProcess = true;
          }
        }
        
        if (shouldProcess) break;
      }
      
      if (shouldProcess) {
        console.log('[MD Review] Rich diff content change detected');
        processExistingRichDiffs();
      }
    }, 100);
  });

  observer.observe(document.body, { 
    childList: true, 
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'hidden', 'style']
  });
  
  // Also listen for clicks on the "Display the rich diff" button
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, [role="button"]')?.textContent?.includes('rich diff') ||
        target.closest('[data-testid="rich-diff-toggle"]') ||
        target.closest('.js-toggle-rich-diff')) {
      console.log('[MD Review] Rich diff toggle clicked');
      // Wait for the toggle to take effect
      setTimeout(processExistingRichDiffs, 300);
      setTimeout(processExistingRichDiffs, 600);
      setTimeout(processExistingRichDiffs, 1000);
    }
  }, true);
}

function processExistingRichDiffs(): void {
  // Find all rich diff / rendered markdown areas - try many selectors
  const selectors = [
    '.markdown-body',
    '.js-rendered-markdown', 
    '[data-view-component="true"].prose',
    '.prose',
    '.rendered-markdown',
    '[class*="RichDiff"]',
    '[class*="markdown"]',
    '.blob-wrapper .highlight',
  ];
  
  let found = 0;
  
  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    elements.forEach((el) => {
      if (el instanceof HTMLElement && !el.dataset.mdReviewEnabled) {
        // Skip if too small or likely not content
        if (el.offsetHeight < 50) return;
        
        el.dataset.mdReviewEnabled = 'true';
        el.classList.add('md-review-selectable');
        found++;
        console.log(`[MD Review] Enabled commenting on: ${selector}`, el.className.slice(0, 50));
      }
    });
  }
  
  if (found > 0) {
    console.log(`[MD Review] Enabled ${found} new markdown areas`);
  }
}

function handleTextSelection(event: MouseEvent): void {
  // Close existing comment box if clicking outside
  if (activeCommentBox && !activeCommentBox.contains(event.target as Node)) {
    closeCommentBox();
  }

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return;
  }

  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  
  // Check if selection is within a rich diff / markdown area
  const markdownBody = findMarkdownBody(container);
  if (!markdownBody) {
    return;
  }

  const selectedText = selection.toString().trim();
  if (!selectedText || selectedText.length < 2) {
    return;
  }

  // Get file path
  const filePath = getFilePathForElement(markdownBody);
  if (!filePath) {
    console.log('[MD Review] Could not determine file path');
    return;
  }

  const rect = range.getBoundingClientRect();
  
  const selectionInfo: SelectionInfo = {
    text: selectedText,
    filePath,
    startOffset: getTextOffset(markdownBody, range.startContainer, range.startOffset),
    endOffset: getTextOffset(markdownBody, range.endContainer, range.endOffset),
    rect,
  };

  console.log('[MD Review] Selection:', selectionInfo);
  showCommentBox(selectionInfo);
}

function findMarkdownBody(node: Node): HTMLElement | null {
  let current: Node | null = node;
  while (current) {
    if (current instanceof HTMLElement) {
      if (current.classList.contains('markdown-body') || 
          current.classList.contains('js-rendered-markdown') ||
          current.classList.contains('prose') ||
          current.dataset.mdReviewEnabled) {
        return current;
      }
    }
    current = current.parentNode;
  }
  return null;
}

function getFilePathForElement(element: HTMLElement): string | null {
  // Walk up to find the file container and extract path
  let current: HTMLElement | null = element;
  
  while (current) {
    // Look for file path indicators
    const pathEl = current.querySelector('[data-path], [data-tagsearch-path], a[title][href*="blob"]');
    if (pathEl instanceof HTMLElement) {
      const path = pathEl.dataset.path || pathEl.dataset.tagsearchPath || pathEl.getAttribute('title');
      if (path) return cleanPath(path);
    }
    
    // Check for link with file name
    const links = current.querySelectorAll('a');
    for (const link of links) {
      const title = link.getAttribute('title');
      if (title && (title.endsWith('.md') || title.endsWith('.markdown'))) {
        return cleanPath(title);
      }
    }
    
    // Check if this is a diff container with ID
    if (current.id && current.id.startsWith('diff-')) {
      const fileLink = current.querySelector('a[title]');
      if (fileLink) {
        const title = fileLink.getAttribute('title');
        if (title) return cleanPath(title);
      }
    }
    
    current = current.parentElement;
  }
  
  // Fallback: try to find any visible file path on the page for single-file PRs
  const breadcrumb = document.querySelector('.js-path-segment, [data-pjax="#repo-content-pjax-container"]');
  if (breadcrumb?.textContent?.includes('.md')) {
    return cleanPath(breadcrumb.textContent);
  }
  
  return 'README.md'; // Default fallback
}

function cleanPath(path: string): string {
  return path.replace(/[\u200B-\u200D\u200E\u200F\uFEFF]/g, '').trim();
}

function getTextOffset(container: HTMLElement, node: Node, offset: number): number {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let totalOffset = 0;
  let currentNode: Node | null;
  
  while ((currentNode = walker.nextNode())) {
    if (currentNode === node) {
      return totalOffset + offset;
    }
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
      <span class="md-review-hint">Comment will include selection reference</span>
      <div class="md-review-actions">
        <button class="md-review-btn md-review-btn-secondary" data-action="cancel">Cancel</button>
        <button class="md-review-btn md-review-btn-primary" data-action="submit">Add Comment</button>
      </div>
    </div>
  `;
  
  // Position the box
  const top = selection.rect.bottom + window.scrollY + 8;
  const left = Math.min(selection.rect.left + window.scrollX, window.innerWidth - 340);
  box.style.top = `${top}px`;
  box.style.left = `${left}px`;
  
  // Event handlers
  box.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const action = target.dataset.action;
    
    if (action === 'close' || action === 'cancel') {
      closeCommentBox();
      window.getSelection()?.removeAllRanges();
    } else if (action === 'submit') {
      const textarea = box.querySelector('.md-review-textarea') as HTMLTextAreaElement;
      const comment = textarea.value.trim();
      if (comment) {
        submitComment(selection, comment);
        closeCommentBox();
        window.getSelection()?.removeAllRanges();
      }
    }
  });
  
  // Handle keyboard shortcuts
  const textarea = box.querySelector('.md-review-textarea') as HTMLTextAreaElement;
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const comment = textarea.value.trim();
      if (comment) {
        submitComment(selection, comment);
        closeCommentBox();
        window.getSelection()?.removeAllRanges();
      }
    } else if (e.key === 'Escape') {
      closeCommentBox();
      window.getSelection()?.removeAllRanges();
    }
  });
  
  document.body.appendChild(box);
  activeCommentBox = box;
  
  // Focus textarea
  setTimeout(() => textarea.focus(), 10);
}

function closeCommentBox(): void {
  if (activeCommentBox) {
    activeCommentBox.remove();
    activeCommentBox = null;
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function submitComment(selection: SelectionInfo, comment: string): void {
  // Create the encoded comment body
  const metadata = {
    file: selection.filePath,
    start: selection.startOffset,
    end: selection.endOffset,
    text: selection.text.slice(0, 100), // Truncate for metadata
  };
  
  const encodedMetadata = `[//]: # (md-review:${JSON.stringify(metadata)})`;
  const fullComment = `${encodedMetadata}\n\n**On "${selection.text.length > 50 ? selection.text.slice(0, 50) + '...' : selection.text}":**\n\n${comment}`;
  
  // Find GitHub's comment form and fill it
  const commentForm = findGitHubCommentForm();
  
  if (commentForm) {
    commentForm.value = fullComment;
    commentForm.dispatchEvent(new Event('input', { bubbles: true }));
    commentForm.focus();
    commentForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
    
    // Show success indicator
    showNotification('Comment prepared! Review and submit using GitHub\'s form below.');
  } else {
    // Fallback: copy to clipboard
    navigator.clipboard.writeText(fullComment).then(() => {
      showNotification('Comment copied to clipboard! Paste it in the PR comment box.');
    }).catch(() => {
      showNotification('Could not find comment form. Please copy manually.', 'error');
      console.log('Comment to post:', fullComment);
    });
  }
}

function findGitHubCommentForm(): HTMLTextAreaElement | null {
  // Try various GitHub comment form selectors
  const selectors = [
    '#new_comment_field',
    '.js-new-comment-form textarea',
    '#pull_request_review_body',
    'textarea[name="comment[body]"]',
    'textarea[name="pull_request_review[body]"]',
    '.CommentBox-input textarea',
    'text-expander textarea',
  ];
  
  for (const selector of selectors) {
    const textarea = document.querySelector(selector) as HTMLTextAreaElement;
    if (textarea) {
      return textarea;
    }
  }
  
  return null;
}

function showNotification(message: string, type: 'success' | 'error' = 'success'): void {
  const notification = document.createElement('div');
  notification.className = `md-review-notification md-review-notification-${type}`;
  notification.textContent = message;
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.classList.add('md-review-notification-hide');
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// Initialize when DOM is ready
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  init();
} else {
  document.addEventListener('DOMContentLoaded', init);
}
