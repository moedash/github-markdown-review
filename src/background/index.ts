// Background service worker for GitHub MD Review extension
// Simplified - no API calls needed, everything works via DOM

// Initialize extension state
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.sync.set({ extensionEnabled: true });
});

// Listen for messages (minimal - most work is done in content script)
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.type === 'GET_ENABLED_STATE') {
        chrome.storage.sync.get(['extensionEnabled'], (result) => {
            sendResponse({ enabled: result.extensionEnabled !== false });
        });
        return true;
    }

    sendResponse({ success: true });
    return true;
});
