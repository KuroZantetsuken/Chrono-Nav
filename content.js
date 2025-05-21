// content.js - Injects "Next" (chronologically newer) and "Previous" (chronologically older)
// video links from the same channel into the YouTube watch page's recommended videos sidebar.

// --- Constants ---

const CHRONO_NAV_CLASS_PREFIX = 'chrono-nav-item';
const CHRONO_NAV_NEWER_CLASS = `${CHRONO_NAV_CLASS_PREFIX}-newer`;
const CHRONO_NAV_OLDER_CLASS = `${CHRONO_NAV_CLASS_PREFIX}-older`;
const CHRONO_NAV_CUSTOM_LABEL_CLASS = 'chrono-nav-custom-label';

const DEBOUNCE_DELAY_MS = 500;
const WATCH_PAGE_READY_TIMEOUT_MS = 10000;
const DOM_OBSERVER_TIMEOUT_MS = 3000;

const LOG_PREFIX_CONTENT = 'ChronoNav Content:';

const SELECTORS = {
  recommendedListContainer: '#secondary-inner #related #contents',
  compactVideoRenderer: 'ytd-compact-video-renderer',
  watchPageCoreElement: '#movie_player',
  relative: {
    allAnchors: 'a',
    thumbnailLink: 'a#thumbnail',
    thumbnailImage: 'a#thumbnail img',
    thumbnailYtImage: 'yt-image',
    durationOverlayContainer: '#overlays ytd-thumbnail-overlay-time-status-renderer',
    durationOverlayText: '#overlays ytd-thumbnail-overlay-time-status-renderer div.badge-shape-wiz__text',
    watchProgressBar: '#progress',
    titleText: '#video-title',
    metadataContainer: '#metadata',
    channelNameContainer: '#metadata #byline-container, #metadata #channel-name',
    metadataLine: '#metadata-line.ytd-video-meta-block',
    anyBadgeRendererOnClone: 'ytd-badge-supported-renderer',
    dismissibleNode: 'yt-dismissible-variant',
    menuIcon: 'ytd-menu-renderer #button > yt-icon',
    menuRenderer: 'ytd-menu-renderer',
  },
};

const SVG_NEXT_ICON_STRING = `<svg height="100%" viewBox="0 0 36 36" width="100%"><path d="M 12,24 20.5,18 12,12 V 24 z M 22,12 v 12 h 2 V 12 h -2 z" fill="var(--yt-spec-icon-inactive)"></path></svg>`;
const SVG_PREVIOUS_ICON_STRING = `<svg height="100%" viewBox="0 0 36 36" width="100%"><path d="m 12,12 h 2 v 12 h -2 z m 3.5,6 8.5,6 V 12 z" fill="var(--yt-spec-icon-inactive)"></path></svg>`;

// --- Global State ---

let isMainLogicExecuting = false;
let mainLogicDebounceTimer = null;
let navigationAttemptId = 0; // Tracks the current navigation attempt generation

// --- Logging Utilities ---

/**
 * Logs messages to the console with a standard prefix.
 * @param {...any} args - Arguments to log.
 */
function log(...args) {
  console.log(LOG_PREFIX_CONTENT, ...args);
}

/**
 * Logs error messages to the console with a standard prefix and "ERROR:" label.
 * @param {...any} args - Arguments to log as an error.
 */
function errorLog(...args) {
  console.error(LOG_PREFIX_CONTENT, 'ERROR:', ...args);
}

// --- Page Data Extraction ---

/**
 * Extracts the YouTube video ID from the current URL's query parameters.
 * @returns {string|null} The video ID, or null if not found or an error occurs.
 */
function getVideoIdFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('v');
  } catch (e) {
    errorLog('Failed to parse video ID from URL:', e.message);
    return null;
  }
}

/**
 * Attempts to find the channel ID from yt-navigate-finish event details.
 * @param {Object} navEventDetail - The `detail` object from a `yt-navigate-finish` event.
 * @returns {string|null} The channel ID, or null if not found.
 */
function getChannelIdFromNavEvent(navEventDetail) {
  if (navEventDetail?.response?.playerResponse?.videoDetails?.channelId) {
    const id = navEventDetail.response.playerResponse.videoDetails.channelId;
    log('Channel ID from yt-navigate-finish event (playerResponse):', id);
    return id;
  }
  if (navEventDetail?.response?.pageData?.contents?.twoColumnWatchNextResults?.results?.results?.contents) {
    const secondaryInfoNode = navEventDetail.response.pageData.contents.twoColumnWatchNextResults.results.results.contents
      .find(c => c.videoSecondaryInfoRenderer?.owner?.videoOwnerRenderer);
    if (secondaryInfoNode) {
      const id = secondaryInfoNode.videoSecondaryInfoRenderer.owner.videoOwnerRenderer
        ?.navigationEndpoint?.browseEndpoint?.browseId;
      if (id) {
        log('Channel ID from yt-navigate-finish event (pageData):', id);
        return id;
      }
    }
  }
  return null;
}

/**
 * Attempts to find the channel ID from global JavaScript objects.
 * @returns {string|null} The channel ID, or null if not found.
 */
function getChannelIdFromGlobalJs() {
  try {
    if (window.ytInitialPlayerResponse?.videoDetails?.channelId) {
      const id = window.ytInitialPlayerResponse.videoDetails.channelId;
      log('Channel ID from window.ytInitialPlayerResponse:', id);
      return id;
    }
    const initialDataOwner = window.ytInitialData?.contents?.twoColumnWatchNextResults
      ?.results?.results?.contents
      ?.find(c => c.videoSecondaryInfoRenderer?.owner?.videoOwnerRenderer)
      ?.videoSecondaryInfoRenderer?.owner?.videoOwnerRenderer;
    if (initialDataOwner?.navigationEndpoint?.browseEndpoint?.browseId) {
      const id = initialDataOwner.navigationEndpoint.browseEndpoint.browseId;
      log('Channel ID from window.ytInitialData:', id);
      return id;
    }
  } catch (e) {
    errorLog('Error accessing global JS objects for channel ID:', e.message);
  }
  return null;
}

/**
 * Attempts to find the channel ID by searching script tags.
 * @returns {string|null} The channel ID, or null if not found.
 */
function getChannelIdFromScripts() {
  try {
    const scripts = Array.from(document.querySelectorAll('script'));
    for (const script of scripts) {
      const scriptContent = script.textContent;
      if (scriptContent) {
        const regex = /"channelId":"(UC[\w-]{22})"/g;
        if (scriptContent.includes('videoDetails') || scriptContent.includes('watchNextResults')) {
          const match = regex.exec(scriptContent);
          if (match && match[1]) {
            log('Channel ID from script regex (potential):', match[1]);
            return match[1];
          }
        }
      }
    }
  } catch (e) {
    errorLog('Error searching scripts for channel ID:', e.message);
  }
  return null;
}

/**
 * Determines the current YouTube channel ID using various methods.
 * Attempts to find the channel ID from:
 * 1. `yt-navigate-finish` event details.
 * 2. Standard `meta[itemprop="channelId"]` tag.
 * 3. Global JavaScript objects (`ytInitialPlayerResponse`, `ytInitialData`).
 * 4. Regex search in script tags (as a fallback).
 * @param {Object} navEventDetail - The `detail` object from a `yt-navigate-finish` event, if available.
 * @returns {Promise<string|null>} A promise that resolves with the channel ID, or null if not found.
 */
async function determineCurrentChannelId(navEventDetail) {
  let channelId = null;

  // Attempt 1: From yt-navigate-finish event details
  if (navEventDetail) {
    channelId = getChannelIdFromNavEvent(navEventDetail);
    if (channelId) return channelId;
  }

  // Attempt 2: Standard meta tag
  const metaChannelIdTag = document.querySelector('meta[itemprop="channelId"]');
  if (metaChannelIdTag?.content) {
    channelId = metaChannelIdTag.content;
    log("Channel ID from meta[itemprop='channelId']:", channelId);
    return channelId;
  }

  // Attempt 3: Global JavaScript objects (wait briefly for them to potentially populate)
  await new Promise(resolve => setTimeout(resolve, 100)); // Small delay
  channelId = getChannelIdFromGlobalJs();
  if (channelId) return channelId;

  // Attempt 4: Regex search in script tags
  channelId = getChannelIdFromScripts();
  if (channelId) return channelId;

  errorLog('Could not determine channel ID using any method.');
  return null;
}


// --- DOM Manipulation Utilities ---

/**
 * Removes any existing Chrono Nav elements from the page.
 */
function removeExistingChronoNavElements() {
  const existingElements = document.querySelectorAll(
    `.${CHRONO_NAV_NEWER_CLASS}, .${CHRONO_NAV_OLDER_CLASS}`
  );
  if (existingElements.length > 0) {
    log(`Removing ${existingElements.length} existing Chrono Nav element(s).`);
    existingElements.forEach(el => el.remove());
  }
}

/**
 * Waits for a specific DOM element to be present.
 * @param {string} selector - The CSS selector for the element.
 * @param {number} [timeoutMs=DOM_OBSERVER_TIMEOUT_MS] - Maximum time to wait.
 * @param {Document|Element} [parentNode=document] - The parent node to search within.
 * @returns {Promise<Element|null>} A promise that resolves with the element, or null if not found within timeout.
 */
function waitForElement(selector, timeoutMs = DOM_OBSERVER_TIMEOUT_MS, parentNode = document) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const intervalId = setInterval(() => {
      const element = parentNode.querySelector(selector);
      if (element) {
        clearInterval(intervalId);
        resolve(element);
      } else if (Date.now() - startTime > timeoutMs) {
        clearInterval(intervalId);
        log(`Element "${selector}" NOT found after ${timeoutMs}ms.`);
        resolve(null);
      }
    }, 200); // Check every 200ms
  });
}

/**
 * Waits for the recommended videos container and then finds the first
 * "ready" `ytd-compact-video-renderer` to use as a template.
 * A "ready" renderer is one that is visible and has its thumbnail image loaded.
 * @returns {Promise<Element|null>} A promise that resolves with a CLONE of the template element, or null if not found.
 */
async function getReadyRecommendedVideoClone() {
  log('Attempting to find a ready recommended video template.');
  const recommendedListContainerEl = await waitForElement(
    SELECTORS.recommendedListContainer,
    WATCH_PAGE_READY_TIMEOUT_MS
  );
  if (!recommendedListContainerEl) {
    errorLog('Recommended videos container not found for template cloning.');
    return null;
  }

  const readyThumbnailImgSelector = `${SELECTORS.compactVideoRenderer}:not([hidden]) ${SELECTORS.relative.thumbnailImage}[src]:not([src=""]):not([src^="data:"])`;
  const readyThumbnailImg = await waitForElement(
    readyThumbnailImgSelector,
    WATCH_PAGE_READY_TIMEOUT_MS,
    recommendedListContainerEl
  );

  if (readyThumbnailImg) {
    const templateElement = readyThumbnailImg.closest(SELECTORS.compactVideoRenderer);
    if (templateElement) {
      log('Found a ready recommended video item to use as template:', templateElement);
      return templateElement.cloneNode(true);
    }
    errorLog(`Could not find parent ${SELECTORS.compactVideoRenderer} from ready thumbnail:`, readyThumbnailImg);
    return null;
  }
  errorLog(`No 'ready' ${SELECTORS.compactVideoRenderer} found in recommended list to use as template.`);
  return null;
}


// --- Element Creation Sub-functions ---

/**
 * Sets basic properties and classes for the Chrono Nav element.
 * @param {Element} element - The element to modify.
 * @param {Object} videoData - Video data.
 * @param {boolean} isNewerVideo - True if this is the "Next" video.
 */
function _setupElementBasics(element, videoData, isNewerVideo) {
  element.id = `chrono-nav-item-${videoData.videoId}-${isNewerVideo ? 'newer' : 'older'}`;
  element.classList.add(isNewerVideo ? CHRONO_NAV_NEWER_CLASS : CHRONO_NAV_OLDER_CLASS);
  element.classList.remove('yt-visibility-stamp');
  element.removeAttribute('hidden');
  element.style.opacity = '1';
}

/**
 * Removes unneeded parts from the cloned template element.
 * @param {Element} element - The element to modify.
 */
function _cleanupTemplateParts(element) {
  element.querySelector(SELECTORS.relative.watchProgressBar)?.remove();
  element.querySelectorAll(SELECTORS.relative.anyBadgeRendererOnClone).forEach(badge => badge.remove());

  const overlaysContainer = element.querySelector('#overlays');
  if (overlaysContainer) {
    Array.from(overlaysContainer.children).forEach(child => {
      if (!child.matches('ytd-thumbnail-overlay-time-status-renderer')) {
        child.remove();
      }
    });
  }
}

/**
 * Updates anchor tags to point to the new video.
 * @param {Element} element - The element to modify.
 * @param {Object} videoData - Video data.
 */
function _updateElementLinks(element, videoData) {
  const videoUrl = videoData.url || `https://www.youtube.com/watch?v=${videoData.videoId}`;
  element.querySelectorAll(SELECTORS.relative.allAnchors).forEach(anchor => {
    if (!anchor.closest('ytd-channel-name') && anchor.id !== 'avatar-link') {
      anchor.href = videoUrl;
      anchor.removeAttribute('ping');
      anchor.removeAttribute('command');

      const newAnchor = anchor.cloneNode(true);
      anchor.parentNode.replaceChild(newAnchor, anchor);
    }
  });
}

/**
 * Updates the thumbnail image.
 * @param {Element} element - The element to modify.
 * @param {Object} videoData - Video data.
 */
function _updateElementThumbnail(element, videoData) {
  const thumbnailImg = element.querySelector(SELECTORS.relative.thumbnailImage);
  const ytImageWrapper = element.querySelector(SELECTORS.relative.thumbnailYtImage);
  if (thumbnailImg) {
    if (videoData.thumbnailUrl) {
      thumbnailImg.src = videoData.thumbnailUrl;
      thumbnailImg.removeAttribute('srcset');
      thumbnailImg.style.backgroundImage = '';
      thumbnailImg.removeAttribute('hidden');
      thumbnailImg.style.opacity = '1';
      if (ytImageWrapper) {
        ytImageWrapper.removeAttribute('hidden');
        ytImageWrapper.classList.add('style-scope', 'yt-image', 'loaded');
        ytImageWrapper.classList.remove('loading');
      }
    } else {
      thumbnailImg.src = 'data:image/gif;base64,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'; // Default transparent pixel
    }
  }
}

/**
 * Updates the video duration overlay.
 * @param {Element} element - The element to modify.
 * @param {Object} videoData - Video data.
 */
function _updateElementDurationOverlay(element, videoData) {
  const durationContainerEl = element.querySelector(SELECTORS.relative.durationOverlayContainer);
  if (durationContainerEl) {
    const durationTextEl = durationContainerEl.querySelector(SELECTORS.relative.durationOverlayText);
    if (videoData.duration && durationTextEl) {
      durationTextEl.textContent = videoData.duration.trim();
      const badgeShapeElement = durationTextEl.closest('badge-shape');
      if (badgeShapeElement) {
        badgeShapeElement.removeAttribute('hidden');
        const wrapper = badgeShapeElement.parentElement;
        if (wrapper && (wrapper.matches('.ytd-thumbnail-overlay-time-status-renderer') || wrapper.classList.contains('thumbnail-overlay-badge-shape'))) {
          wrapper.removeAttribute('hidden');
          wrapper.style.display = '';
        }
      }
      durationContainerEl.removeAttribute('hidden');
      durationContainerEl.style.removeProperty('display');
    } else {
      durationContainerEl.setAttribute('hidden', '');
      durationContainerEl.style.display = 'none';
      if (!durationTextEl) log(`Duration text element not found for ${videoData.videoId}, hiding overlay.`);
    }
  } else {
    log(`Duration container (${SELECTORS.relative.durationOverlayContainer}) not found for ${videoData.videoId}.`);
  }
}

/**
 * Updates the video title.
 * @param {Element} element - The element to modify.
 * @param {Object} videoData - Video data.
 */
function _updateElementTitle(element, videoData) {
  const titleEl = element.querySelector(SELECTORS.relative.titleText);
  if (titleEl) {
    titleEl.textContent = videoData.title || 'Untitled Video';
    titleEl.setAttribute('title', videoData.title || '');
  }
}

/**
 * Creates and styles the custom label (Next/Previous) and double chevron.
 * @param {Element} channelNameEl - The container for the custom label.
 * @param {string} labelText - Text for the label (e.g., "Next", "Previous").
 * @param {boolean} isNewerVideo - True if this is the "Next" video.
 */
function _createCustomLabel(channelNameEl, labelText, isNewerVideo) {
  channelNameEl.innerHTML = ''; // Clear existing content

  const bgColor = 'var(--yt-spec-badge-chip-background, rgba(0,0,0,0.05))';
  const textColor = 'var(--yt-spec-text-secondary, #606060)';
  const fontSize = '1.2rem';
  const lineHeight = '1.8rem';
  const borderRadius = '2px';
  const spaceBetweenChevronAndLabel = '-4px';
  const mainLabelPointWidthPx = 6;
  const mainLabelTextPaddingPx = 6;
  const chevronProngWidthPx = 6;
  const chevronProngOverlapPx = 2;
  const doubleChevronTotalWidthPx = (2 * chevronProngWidthPx) - chevronProngOverlapPx;

  const doubleChevronEl = document.createElement('span');
  Object.assign(doubleChevronEl.style, {
    display: 'inline-block',
    width: `${doubleChevronTotalWidthPx}px`,
    height: lineHeight,
    background: bgColor,
    verticalAlign: 'middle',
    clipPath: isNewerVideo ?
      `polygon(0px 0%, ${chevronProngWidthPx}px 50%, 0px 100%, ${chevronProngWidthPx - chevronProngOverlapPx}px 100%, ${doubleChevronTotalWidthPx}px 50%, ${chevronProngWidthPx - chevronProngOverlapPx}px 0%)` :
      `polygon(0% 50%, ${chevronProngWidthPx}px 0%, ${doubleChevronTotalWidthPx}px 0%, ${chevronProngWidthPx - chevronProngOverlapPx}px 50%, ${doubleChevronTotalWidthPx}px 100%, ${chevronProngWidthPx}px 100%)`,
  });

  const labelSpan = document.createElement('span');
  labelSpan.className = CHRONO_NAV_CUSTOM_LABEL_CLASS;
  labelSpan.textContent = labelText;
  labelSpan.title = labelText;
  Object.assign(labelSpan.style, {
    background: bgColor,
    color: textColor,
    fontSize: fontSize,
    lineHeight: lineHeight,
    fontWeight: '500',
    display: 'inline-block',
    verticalAlign: 'middle',
    padding: isNewerVideo ?
      `0px ${mainLabelPointWidthPx + mainLabelTextPaddingPx}px 0px ${mainLabelTextPaddingPx}px` :
      `0px ${mainLabelTextPaddingPx}px 0px ${mainLabelPointWidthPx + mainLabelTextPaddingPx}px`,
    borderRadius: isNewerVideo ? `${borderRadius} 0px 0px ${borderRadius}` : `0px ${borderRadius} ${borderRadius} 0px`,
    clipPath: isNewerVideo ?
      `polygon(0% 0%, calc(100% - ${mainLabelPointWidthPx}px) 0%, 100% 50%, calc(100% - ${mainLabelPointWidthPx}px) 100%, 0% 100%)` :
      `polygon(0% 50%, ${mainLabelPointWidthPx}px 0%, 100% 0%, 100% 100%, ${mainLabelPointWidthPx}px 100%)`,
  });

  if (isNewerVideo) {
    labelSpan.style.marginRight = spaceBetweenChevronAndLabel;
    channelNameEl.appendChild(labelSpan);
    channelNameEl.appendChild(doubleChevronEl);
  } else {
    labelSpan.style.marginLeft = spaceBetweenChevronAndLabel;
    channelNameEl.appendChild(doubleChevronEl);
    channelNameEl.appendChild(labelSpan);
  }
  channelNameEl.closest('ytd-video-meta-block')?.style.removeProperty('display');
}


/**
 * Updates the metadata area (channel name replaced by custom label).
 * @param {Element} element - The element to modify.
 * @param {string} labelText - Text for the custom label.
 * @param {boolean} isNewerVideo - True if this is the "Next" video.
 */
function _updateElementMetadataArea(element, labelText, isNewerVideo) {
  const channelNameEl = element.querySelector(SELECTORS.relative.channelNameContainer);
  if (channelNameEl) {
    _createCustomLabel(channelNameEl, labelText, isNewerVideo);
  }
}

/**
 * Updates the views and published time metadata line.
 * @param {Element} element - The element to modify.
 * @param {Object} videoData - Video data.
 */
function _updateElementViewsAndPublishedTime(element, videoData) {
  const metadataLineEl = element.querySelector(SELECTORS.relative.metadataLine);
  if (metadataLineEl) {
    const spans = Array.from(metadataLineEl.querySelectorAll(':scope > span'));
    spans.forEach(span => span.textContent = '');

    const metaParts = [];
    if (videoData.viewCountText) metaParts.push(videoData.viewCountText);
    if (videoData.publishedTimeText) metaParts.push(videoData.publishedTimeText);

    if (metaParts.length > 0) {
      if (spans.length > 0) spans[0].textContent = metaParts[0];
      if (metaParts.length > 1 && spans.length > 1) {
        spans[1].textContent = metaParts[1];
      } else if (metaParts.length === 1 && spans.length > 1) {
        spans[1].textContent = '';
      }
      metadataLineEl.style.removeProperty('display');
    } else {
      metadataLineEl.style.display = 'none';
    }
  }
}

/**
 * Re-orders custom label and metadata line if they share a parent.
 * @param {Element} element - The main Chrono Nav element.
 */
function _reorderMetadataElements(element) {
  const channelNameEl = element.querySelector(SELECTORS.relative.channelNameContainer); // This is our custom label
  const metadataLineEl = element.querySelector(SELECTORS.relative.metadataLine); // This is views/date

  if (channelNameEl && metadataLineEl && channelNameEl.parentNode === metadataLineEl.parentNode) {
    const parent = channelNameEl.parentNode;
    // Ensure custom label (in channelNameEl) appears AFTER metadataLineEl
    parent.insertBefore(channelNameEl, metadataLineEl.nextSibling);
  }
}


/**
 * Updates the menu icon (replaces 3-dot with arrow SVG).
 * @param {Element} element - The element to modify.
 * @param {Object} videoData - Video data.
 * @param {boolean} isNewerVideo - True if this is the "Next" video.
 */
function _updateElementMenuIcon(element, videoData, isNewerVideo) {
  const menuIconYtElement = element.querySelector(SELECTORS.relative.menuIcon);
  if (menuIconYtElement) {
    const svgString = isNewerVideo ? SVG_NEXT_ICON_STRING : SVG_PREVIOUS_ICON_STRING;
    const tempContainer = document.createElement('div');
    tempContainer.innerHTML = svgString;
    const newSvgElement = tempContainer.firstElementChild;

    if (newSvgElement && menuIconYtElement.parentNode) {
      menuIconYtElement.parentNode.replaceChild(newSvgElement, menuIconYtElement);
      log(`Replaced menu icon with ${isNewerVideo ? 'Next Arrow' : 'Previous Arrow'} SVG for ${videoData.videoId}`);

      const buttonElement = newSvgElement.closest('button');
      if (buttonElement) {
        buttonElement.style.display = '';
        const iconButtonWrapper = buttonElement.closest('yt-icon-button');
        if (iconButtonWrapper) iconButtonWrapper.style.display = 'inline-flex';
        const menuRendererWrapper = buttonElement.closest(SELECTORS.relative.menuRenderer);
        if (menuRendererWrapper) menuRendererWrapper.style.display = '';
      }
    } else {
      errorLog(`Failed to create SVG or replace menu icon for ${videoData.videoId}. Removing menu renderer.`);
      element.querySelector(SELECTORS.relative.menuRenderer)?.remove();
    }
  } else {
    log(`Menu icon (${SELECTORS.relative.menuIcon}) not found. Removing ytd-menu-renderer for ${videoData.videoId}.`);
    element.querySelector(SELECTORS.relative.menuRenderer)?.remove();
  }
}

/**
 * Adds visual feedback on click.
 * @param {Element} element - The element to add feedback to.
 * @param {Object} videoData - Video data (for logging).
 */
function _addElementClickFeedback(element, videoData) {
  const interactionElement = element.querySelector('ytd-compact-video-renderer > yt-interaction');
  let strokeDiv = null;
  let fillDiv = null;

  if (interactionElement) {
    strokeDiv = interactionElement.querySelector('div.stroke.style-scope.yt-interaction');
    fillDiv = interactionElement.querySelector('div.fill.style-scope.yt-interaction');
  }

  if (strokeDiv && fillDiv) {
    const initialSetup = (el) => {
      el.style.transition = 'none';
      el.style.opacity = '0';
    };
    initialSetup(strokeDiv);
    initialSetup(fillDiv);

    let isPressed = false;

    element.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      isPressed = true;
      fillDiv.style.transition = 'none';
      fillDiv.style.opacity = '0.1';
      strokeDiv.style.transition = 'none';
      strokeDiv.style.opacity = '0';
    });

    const releaseEffect = () => {
      if (!isPressed) return;
      isPressed = false;
      strokeDiv.style.transition = 'none';
      strokeDiv.style.opacity = '0.2';
      setTimeout(() => {
        strokeDiv.style.transition = 'opacity 0.4s ease-out';
        fillDiv.style.transition = 'opacity 0.4s ease-out';
        strokeDiv.style.opacity = '0';
        fillDiv.style.opacity = '0';
      }, 0);
    };

    element.addEventListener('mouseup', (e) => {
      if (e.button !== 0) return;
      releaseEffect();
    });

    element.addEventListener('mouseleave', () => {
      if (isPressed) {
        releaseEffect();
      }
    });
  } else {
    const videoIdForLog = videoData?.videoId || 'unknown video';
    log(`Could not find stroke/fill divs for click effect on ${videoIdForLog}`);
  }
}

/**
 * Creates a video element for Chrono Nav based on a template and video data.
 * This function takes a CLONED template and modifies IT.
 * @param {Object} videoData - Data for the video.
 * @param {string} labelText - Text for the custom label (e.g., "Next", "Previous").
 * @param {boolean} isNewerVideo - True if this is the "newer" video link (labeled "Next").
 * @param {Element} clonedTemplateElement - A CLONED ytd-compact-video-renderer to modify.
 * @returns {Element|null} The modified DOM element ready for insertion, or null on failure.
 */
function createVideoElement(videoData, labelText, isNewerVideo, clonedTemplateElement) {
  if (!clonedTemplateElement) {
    errorLog('No cloned template element provided for creating Chrono Nav item.');
    return null;
  }
  if (!videoData || !videoData.videoId) {
    errorLog('Invalid videoData provided for creating Chrono Nav item.');
    return null;
  }

  log(`Creating Chrono Nav element for "${labelText}" (ID: ${videoData.videoId})`);
  const element = clonedTemplateElement; // Modifying the passed clone directly.

  _setupElementBasics(element, videoData, isNewerVideo);
  _cleanupTemplateParts(element);
  _updateElementLinks(element, videoData);
  _updateElementThumbnail(element, videoData);
  _updateElementDurationOverlay(element, videoData);
  _updateElementTitle(element, videoData);
  _updateElementMetadataArea(element, labelText, isNewerVideo);
  _updateElementViewsAndPublishedTime(element, videoData);
  _reorderMetadataElements(element); // Important: Call after metadata and views/date are populated
  _updateElementMenuIcon(element, videoData, isNewerVideo);
  _addElementClickFeedback(element, videoData);

  return element;
}


// --- Main Logic Orchestration ---

/**
 * Core function to inject Chrono Nav elements.
 * It handles fetching necessary data, finding a template, creating elements, and inserting them.
 * @param {Object} [navEventDetail] - The `detail` object from a `yt-navigate-finish` event, if available.
 * @param {number} scheduledAttemptId - The navigation attempt ID this execution was scheduled for.
 */
async function executeMainLogic(navEventDetail, scheduledAttemptId) {
  // Check 1: If a newer navigation has started since this was scheduled, abort.
  if (scheduledAttemptId !== navigationAttemptId) {
    log(`Skipping execution: scheduledAttemptId (${scheduledAttemptId}) != current global navigationAttemptId (${navigationAttemptId}). A newer navigation has started.`);
    return; // This instance is obsolete, don't touch isMainLogicExecuting
  }

  if (isMainLogicExecuting) {
    log(`Main logic execution already in progress for attemptId ${scheduledAttemptId}. Skipping.`);
    return;
  }
  isMainLogicExecuting = true;
  log(`Starting Chrono Nav main logic execution for attemptId: ${scheduledAttemptId}...`);

  try {
    removeExistingChronoNavElements(); // Clean slate for this attempt

    const playerElement = await waitForElement(SELECTORS.watchPageCoreElement, WATCH_PAGE_READY_TIMEOUT_MS);
    if (!playerElement) {
      errorLog(`Watch page core element (player) not found for attemptId ${scheduledAttemptId}. Aborting Chrono Nav.`);
      isMainLogicExecuting = false; // Release lock as this attempt cannot proceed
      return;
    }

    // Check 2: Re-validate attemptId after initial async operation, before more critical logic.
    if (scheduledAttemptId !== navigationAttemptId) {
      log(`Aborting mid-execution: scheduledAttemptId (${scheduledAttemptId}) != current global navigationAttemptId (${navigationAttemptId}) after playerElement wait. For attemptId: ${scheduledAttemptId}`);
      isMainLogicExecuting = false; // Release lock as this attempt is now obsolete
      return;
    }

    const currentVideoId = getVideoIdFromUrl();
    if (!currentVideoId) {
      errorLog(`No video ID found in URL for attemptId ${scheduledAttemptId}. Aborting Chrono Nav.`);
      isMainLogicExecuting = false;
      return;
    }

    const currentChannelId = await determineCurrentChannelId(navEventDetail);
    if (!currentChannelId) {
      errorLog(`Could not determine current channel ID for attemptId ${scheduledAttemptId}. Aborting Chrono Nav.`);
      isMainLogicExecuting = false;
      return;
    }
    log(`Current Video ID: ${currentVideoId}, Channel ID: ${currentChannelId} (AttemptId: ${scheduledAttemptId})`);

    const clonedTemplateElement = await getReadyRecommendedVideoClone();
    if (!clonedTemplateElement) {
      errorLog(`Suitable template video element CLONE not obtained for attemptId ${scheduledAttemptId}. Aborting Chrono Nav.`);
      isMainLogicExecuting = false;
      return;
    }

    const recommendedListContainerEl = document.querySelector(SELECTORS.recommendedListContainer);
    if (!recommendedListContainerEl) {
      errorLog(`Recommended videos container disappeared for attemptId ${scheduledAttemptId}. Aborting.`);
      isMainLogicExecuting = false;
      return;
    }

    const insertionAnchor = recommendedListContainerEl.querySelector(
      `:scope > ${SELECTORS.compactVideoRenderer}, :scope > ${SELECTORS.relative.dismissibleNode}`
    );
    if (!insertionAnchor) {
      errorLog(`Could not find a valid insertion anchor for attemptId ${scheduledAttemptId}. Aborting.`);
      isMainLogicExecuting = false;
      return;
    }

    // Check 3: Final validation before message passing and DOM insertion
    if (scheduledAttemptId !== navigationAttemptId) {
      log(`Aborting before final insertion: scheduledAttemptId (${scheduledAttemptId}) != current global navigationAttemptId (${navigationAttemptId}). For attemptId: ${scheduledAttemptId}`);
      isMainLogicExecuting = false; // Release lock
      return;
    }

    log(`Fetching navigation videos from background script for attemptId: ${scheduledAttemptId}...`);
    const response = await new Promise((resolve, reject) => {
      // Inner check before async sendMessage, critical for Chrome's async message response handling
      if (scheduledAttemptId !== navigationAttemptId) {
        return reject(new Error(`Navigation attempt superseded before sendMessage (attemptId ${scheduledAttemptId} vs global ${navigationAttemptId})`));
      }
      if (!browser.runtime || !browser.runtime.sendMessage) {
        return reject(new Error('Chrome runtime or sendMessage is not available.'));
      }
      browser.runtime.sendMessage(
        { type: 'GET_NAV_VIDEOS', channelId: currentChannelId, currentVideoId },
        (msgResponse) => {
          // Check attemptId AGAIN after message response, before resolving
          if (scheduledAttemptId !== navigationAttemptId) {
            // Don't resolve/reject if superseded, just log and let the outer promise hang if needed,
            // or reject to ensure the catch block of the outer promise is hit.
            // Rejecting is cleaner for the await new Promise structure.
            return reject(new Error(`Navigation attempt superseded after sendMessage response (attemptId ${scheduledAttemptId} vs global ${navigationAttemptId})`));
          }
          if (browser.runtime.lastError) {
            return reject(new Error(browser.runtime.lastError.message));
          }
          if (!msgResponse) {
            return reject(new Error('No response from background for GET_NAV_VIDEOS.'));
          }
          if (msgResponse.error) {
            return reject(new Error(`Background error: ${msgResponse.error}`));
          }
          resolve(msgResponse);
        }
      );
    });

    // API returns `prevVideo` as chronologically newer, `nextVideo` as chronologically older.
    const { prevVideo: newerVideoData, nextVideo: olderVideoData } = response;
    log(`Received video data from background for attemptId ${scheduledAttemptId}:`, {
      newerVideo: newerVideoData ? newerVideoData.videoId : null,
      olderVideo: olderVideoData ? olderVideoData.videoId : null,
    });

    let newerElement = null;
    if (newerVideoData) {
      newerElement = createVideoElement(newerVideoData, 'Next', true, clonedTemplateElement.cloneNode(true));
    }
    let olderElement = null;
    if (olderVideoData) {
      olderElement = createVideoElement(olderVideoData, 'Previous', false, clonedTemplateElement.cloneNode(true));
    }

    // Insert "Previous" (older) first, then "Next" (newer) before the anchor.
    if (olderElement) {
      recommendedListContainerEl.insertBefore(olderElement, insertionAnchor);
      log(`Inserted 'Previous' (older) video element for attemptId: ${scheduledAttemptId}.`);
    }
    if (newerElement) {
      recommendedListContainerEl.insertBefore(newerElement, insertionAnchor);
      log(`Inserted 'Next' (newer) video element for attemptId: ${scheduledAttemptId}.`);
    }

    if (!newerElement && !olderElement) {
      log(`No newer or older videos found from the channel to insert for attemptId: ${scheduledAttemptId}.`);
    }

  } catch (error) {
    // If the error is due to superseding, it's a controlled abort, not a "critical" error.
    if (error.message.includes("Navigation attempt superseded")) {
        log(`Gracefully aborting executeMainLogic for superseded attempt ${scheduledAttemptId}: ${error.message}`);
        // isMainLogicExecuting should have been set to false by the check that threw, or will be by finally.
    } else {
        errorLog(`Critical error during main logic execution for attemptId ${scheduledAttemptId}:`, error.message, error.stack);
    }
  } finally {
    // Only the instance that set isMainLogicExecuting to true should set it to false.
    // This is implicitly handled because if an instance returns early due to attemptId mismatch before setting the flag,
    // it won't enter this finally block with the intention of clearing a flag it didn't set for this attempt.
    // Or, if it did set the flag and then got superseded, it should clear it.
    if (scheduledAttemptId === navigationAttemptId || isMainLogicExecuting) {
        // If this was the active logic for the current attempt, or if it somehow still thinks it is executing, release the lock.
        isMainLogicExecuting = false;
    }
    log(`Chrono Nav main logic execution finished for attemptId: ${scheduledAttemptId}.`);
  }
}

// --- Navigation Handling & Initialization ---

/**
 * Handles changes in YouTube navigation.
 * If the user navigates to a watch page, it schedules the main logic to run.
 * Otherwise, it cleans up.
 * @param {CustomEvent} [navEvent] - The navigation event (e.g., `yt-navigate-finish`).
 * @param {number} attemptIdForThisCall - The navigation attempt ID for this specific call.
 */
function handleNavigationChange(navEvent, attemptIdForThisCall) {
  log(`Navigation change detected. Current path: ${window.location.pathname}. Using attempt ID: ${attemptIdForThisCall}`);

  if (mainLogicDebounceTimer) {
    clearTimeout(mainLogicDebounceTimer);
    mainLogicDebounceTimer = null;
  }
  // `isMainLogicExecuting` and `removeExistingChronoNavElements` are primarily handled
  // by `yt-navigate-start` or within `executeMainLogic`.

  if (window.location.pathname === '/watch') {
    log(`On a watch page. Scheduling main logic execution for attempt ID: ${attemptIdForThisCall}.`);
    mainLogicDebounceTimer = setTimeout(() => {
      // Pass the attemptId that was current when this specific timeout was scheduled
      executeMainLogic(navEvent?.detail, attemptIdForThisCall);
    }, DEBOUNCE_DELAY_MS);
  } else {
    log('Not on a watch page. Chrono Nav logic will not run. Cleaning up.');
    removeExistingChronoNavElements(); // Clean up if navigating away from a watch page.
  }
}

// Listen for YouTube's custom navigation events.
document.addEventListener('yt-navigate-start', () => {
  navigationAttemptId++; // Increment for new navigation attempt
  log(`Event: yt-navigate-start. New attempt ID: ${navigationAttemptId}. Clearing debounce timer and resetting state.`);
  if (mainLogicDebounceTimer) {
    clearTimeout(mainLogicDebounceTimer);
    mainLogicDebounceTimer = null;
  }
  isMainLogicExecuting = false; // Reset lock, allowing the new attempt's logic to run.
  removeExistingChronoNavElements(); // Clean up any elements from a potentially aborted previous logic.
});

document.addEventListener('yt-navigate-finish', (event) => {
  const currentAttemptIdForEvent = navigationAttemptId; // Capture ID at the moment event fires
  log('Event: yt-navigate-finish.',
    `Captured attempt ID for this event: ${currentAttemptIdForEvent}. Page Type: ${event.detail?.pageType}, Video ID: ${event.detail?.endpoint?.watchEndpoint?.videoId || 'N/A'}`);
  handleNavigationChange(event, currentAttemptIdForEvent); // Pass the captured attempt ID
});

// --- Initial Load ---
log('ChronoNav content script loaded. Performing initial check for watch page...');
const initialEventDetail = window.ytplayer?.bootstrapPlayerResponse
  ? { response: { playerResponse: window.ytplayer.bootstrapPlayerResponse } }
  : null;
// For initial load, navigationAttemptId is 0.
// handleNavigationChange will be called with attemptId 0.
handleNavigationChange({ detail: initialEventDetail }, navigationAttemptId);