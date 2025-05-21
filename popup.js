// popup.js - Handles logic for the extension's popup UI.

document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('apiKey');
  const saveApiKeyButton = document.getElementById('saveApiKey');
  const clearCacheButton = document.getElementById('clearCache');
  const cacheStatusEl = document.getElementById('cacheStatus');
  const cachedChannelsCountEl = document.getElementById('cachedChannelsCount');
  const cachedVideosCountEl = document.getElementById('cachedVideosCount');
  const lifetimeRequestsEl = document.getElementById('lifetimeRequests');
  const dailyTokensUsedEl = document.getElementById('dailyTokensUsed');
  const apiStatusEl = document.getElementById('apiStatus'); // Used for API key status and API usage notes/errors

  const LOG_PREFIX_POPUP = 'ChronoNav Popup:';

  /**
   * Logs messages to the console with a standard prefix.
   * @param {...any} args - Arguments to log.
   */
  function log(...args) {
    console.log(LOG_PREFIX_POPUP, ...args);
  }

  /**
   * Logs error messages to the console with a standard prefix.
   * @param {...any} args - Arguments to log as an error.
   */
  function errorLog(...args) {
    console.error(LOG_PREFIX_POPUP, 'ERROR:', ...args);
  }

  /**
   * Displays a status message to the user in a specified element.
   * @param {HTMLElement} element - The HTML element to display the message in.
   * @param {string} message - The message text.
   * @param {'success' | 'error' | ''} [type=''] - The type of message, influencing styling.
   * @param {number} [durationMs=3000] - How long to display the message (0 for indefinite).
   */
  function showStatus(element, message, type = '', durationMs = 3000) {
    if (!element) {
      errorLog('showStatus called with null element. Message:', message);
      return;
    }
    element.textContent = message;
    element.className = 'status-message'; // Reset classes
    if (type) {
      element.classList.add(type);
    }

    if (durationMs > 0) {
      setTimeout(() => {
        // Clear only if the message hasn't been changed by a subsequent call
        if (element.textContent === message) {
          element.textContent = '';
          element.className = 'status-message';
        }
      }, durationMs);
    }
  }

  /**
   * Loads the saved API key from storage and populates the input field.
   */
  async function loadApiKey() {
    try {
      const result = await browser.storage.local.get('apiKey');
      if (result.apiKey) {
        apiKeyInput.value = result.apiKey;
      }
    } catch (e) {
      errorLog('Error loading API key:', e.message);
      showStatus(apiStatusEl, 'Error loading API key.', 'error');
    }
  }

  /**
   * Saves the API key to storage.
   */
  async function saveApiKey() {
    const key = apiKeyInput.value.trim();
    try {
      await browser.storage.local.set({ apiKey: key });
      showStatus(apiStatusEl, 'API Key saved!', 'success');
    } catch (e) {
      errorLog('Error saving API key:', e.message);
      showStatus(apiStatusEl, `Error saving key: ${e.message}`, 'error');
    }
  }

  /**
   * Sends a message to the background script to clear the cache.
   * Updates the UI based on the response.
   */
  function clearAllCache() {
    if (!confirm('Are you sure you want to clear all cached channel data? This action cannot be undone.')) {
      return;
    }
    showStatus(cacheStatusEl, 'Clearing cache...', '', 0); // Indefinite until response
    browser.runtime.sendMessage({ type: 'CLEAR_CACHE' }, (response) => {
      if (browser.runtime.lastError) {
        errorLog('Error sending CLEAR_CACHE message:', browser.runtime.lastError.message);
        showStatus(cacheStatusEl, `Error: ${browser.runtime.lastError.message}`, 'error');
      } else if (response?.success) {
        showStatus(cacheStatusEl, 'Cache cleared successfully!', 'success');
        updateCacheStats(); // Refresh stats after clearing
      } else {
        const errorMsg = response?.error || 'An unknown error occurred.';
        errorLog('Failed to clear cache:', errorMsg);
        showStatus(cacheStatusEl, `Failed to clear: ${errorMsg}`, 'error');
      }
    });
  }

  /**
   * Fetches and updates the cache statistics (channel and video counts) in the UI.
   */
  function updateCacheStats() {
    cachedChannelsCountEl.textContent = 'Loading...';
    cachedVideosCountEl.textContent = 'Loading...';
    showStatus(cacheStatusEl, '', '', 0); // Clear previous general cache status

    browser.runtime.sendMessage({ type: 'GET_CACHE_STATS' }, (response) => {
      if (browser.runtime.lastError) {
        errorLog('Error sending GET_CACHE_STATS message:', browser.runtime.lastError.message);
        cachedChannelsCountEl.textContent = 'Error';
        cachedVideosCountEl.textContent = 'Error';
        showStatus(cacheStatusEl, `Error fetching stats: ${browser.runtime.lastError.message}`, 'error', 0);
      } else if (response && typeof response.channelCount !== 'undefined' && typeof response.videoCount !== 'undefined') {
        cachedChannelsCountEl.textContent = response.channelCount.toString();
        cachedVideosCountEl.textContent = response.videoCount.toString();
        if (response.error) { // Partial success with an error message
          showStatus(cacheStatusEl, `Note: ${response.error}`, 'error', 5000);
        }
      } else {
        errorLog('Failed to get cache stats (invalid response):', response);
        cachedChannelsCountEl.textContent = 'N/A';
        cachedVideosCountEl.textContent = 'N/A';
        showStatus(cacheStatusEl, 'Failed to retrieve cache statistics.', 'error', 0);
      }
    });
  }

  /**
   * Fetches and updates the API usage statistics (lifetime requests, daily tokens) in the UI.
   */
  function updateApiUsageStats() {
    if (!lifetimeRequestsEl || !dailyTokensUsedEl) {
      errorLog('API usage stat elements not found in the DOM.');
      return;
    }
    lifetimeRequestsEl.textContent = 'Loading...';
    dailyTokensUsedEl.textContent = 'Loading...';
    showStatus(apiStatusEl, '', '', 0); // Clear previous API status/notes

    browser.runtime.sendMessage({ type: 'GET_API_USAGE_STATS' }, (response) => {
      if (browser.runtime.lastError) {
        errorLog('Error sending GET_API_USAGE_STATS message:', browser.runtime.lastError.message);
        lifetimeRequestsEl.textContent = 'Error';
        dailyTokensUsedEl.textContent = 'Error';
        showStatus(apiStatusEl, `Error fetching API stats: ${browser.runtime.lastError.message}`, 'error', 0);
      } else if (response && typeof response.lifetimeRequests !== 'undefined' && typeof response.dailyTokensUsed !== 'undefined') {
        lifetimeRequestsEl.textContent = response.lifetimeRequests.toLocaleString();
        dailyTokensUsedEl.textContent = response.dailyTokensUsed.toLocaleString();
        if (response.note) {
          showStatus(apiStatusEl, `Note: ${response.note}`, '', 5000); // Default style for notes
        } else if (response.error) { // Error specifically from stats retrieval logic
          showStatus(apiStatusEl, `Error: ${response.error}`, 'error', 5000);
        }
      } else {
        errorLog('Failed to get API usage stats (invalid response):', response);
        lifetimeRequestsEl.textContent = 'N/A';
        dailyTokensUsedEl.textContent = 'N/A';
        showStatus(apiStatusEl, 'Failed to retrieve API usage statistics.', 'error', 0);
      }
    });
  }

  // --- Event Listeners ---
  if (saveApiKeyButton) {
    saveApiKeyButton.addEventListener('click', saveApiKey);
  } else {
    errorLog('Save API Key button not found.');
  }

  if (clearCacheButton) {
    clearCacheButton.addEventListener('click', clearAllCache);
  } else {
    errorLog('Clear Cache button not found.');
  }

  // --- Initial Actions ---
  log('Popup script loaded. Initializing UI elements.');
  loadApiKey();
  updateCacheStats();
  updateApiUsageStats();
});