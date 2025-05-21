// background.js - Service worker for Chrono Nav extension

const CACHE_KEY_CHANNELS_DATA = 'chronoNavChannelsData_v2';
const CACHE_KEY_API_KEY = 'apiKey';
const CACHE_KEY_LIFETIME_REQUESTS = 'apiLifetimeRequests_v1';
const CACHE_KEY_DAILY_TOKENS_USED = 'apiDailyTokensUsed_v1';
const CACHE_KEY_DAILY_TOKENS_LAST_RESET = 'apiDailyTokensLastReset_v1';

const RSS_FETCH_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes
const PLAYLIST_ITEMS_MAX_RESULTS = 50;
const API_VIDEOS_MAX_IDS = 50;
const MAX_VIDEOS_PER_CHANNEL = 1000;
const TOKEN_BUDGET_PER_RUN = 200; // Max tokens to use in one getNavigationVideos cycle

const LOG_PREFIX_BG = 'ChronoNav BG:';

/**
 * Logs messages to the console with a standard prefix.
 * @param {...any} args - Arguments to log.
 */
function log(...args) {
  console.log(LOG_PREFIX_BG, ...args);
}

/**
 * Logs error messages to the console with a standard prefix and "ERROR:" label.
 * @param {...any} args - Arguments to log as an error.
 */
function errorLog(...args) {
  console.error(LOG_PREFIX_BG, 'ERROR:', ...args);
}

/**
 * Logs warning messages specifically for RSS parsing issues.
 * @param {...any} args - Arguments to log as a warning.
 */
function warnLogRss(...args) {
  console.warn(LOG_PREFIX_BG, 'WARN (RSS PARSE):', ...args);
}

// --- Storage Utility Functions ---

/**
 * Retrieves the API key from local storage.
 * @async
 * @returns {Promise<string|null>} The API key, or null if not found or an error occurs.
 */
async function getApiKey() {
  try {
    const result = await browser.storage.local.get(CACHE_KEY_API_KEY);
    return result[CACHE_KEY_API_KEY] || null;
  } catch (e) {
    errorLog('Failed to get API key:', e.message);
    return null;
  }
}

/**
 * Retrieves cached data for a specific channel.
 * @async
 * @param {string} channelId - The ID of the channel.
 * @returns {Promise<Object>} The channel data object.
 *                           Includes videos, lastRssFetchTimestamp, lastPlaylistItemsPageToken, channelName, apiErrorState.
 */
async function getChannelData(channelId) {
  try {
    const result = await browser.storage.local.get(CACHE_KEY_CHANNELS_DATA);
    const allChannels = result[CACHE_KEY_CHANNELS_DATA] || {};
    return allChannels[channelId] || {
      videos: [],
      lastRssFetchTimestamp: 0,
      lastPlaylistItemsPageToken: null,
      channelName: '',
      apiErrorState: null, // Tracks persistent API errors e.g. 'QUOTA_EXCEEDED', 'API_KEY_INVALID'
    };
  } catch (e) {
    errorLog(`Failed to get channel data for ${channelId}:`, e.message);
    return { videos: [], lastRssFetchTimestamp: 0, lastPlaylistItemsPageToken: null, channelName: '', apiErrorState: null };
  }
}

/**
 * Saves data for a specific channel to local storage.
 * @async
 * @param {string} channelId - The ID of the channel.
 * @param {Object} data - The data to save for the channel.
 */
async function saveChannelData(channelId, data) {
  try {
    const result = await browser.storage.local.get(CACHE_KEY_CHANNELS_DATA);
    const allChannels = result[CACHE_KEY_CHANNELS_DATA] || {};
    allChannels[channelId] = data;
    await browser.storage.local.set({ [CACHE_KEY_CHANNELS_DATA]: allChannels });
    log(`Saved data for channel ${channelId}. Videos: ${data.videos?.length}, Next Playlist Page: ${data.lastPlaylistItemsPageToken}, Error State: ${data.apiErrorState}`);
  } catch (e) {
    errorLog(`Failed to save channel data for ${channelId}:`, e.message);
  }
}

// --- API Usage Tracking Utility Functions ---

/**
 * Retrieves API usage statistics, handling daily reset for token count.
 * @async
 * @returns {Promise<{lifetimeRequests: number, dailyTokensUsed: number, note: string|null, error: string|null}>}
 *          Object containing lifetimeRequests, dailyTokensUsed, an optional note, and an optional error message.
 */
async function getApiUsageStatsInternal() {
  try {
    const keys = [CACHE_KEY_LIFETIME_REQUESTS, CACHE_KEY_DAILY_TOKENS_USED, CACHE_KEY_DAILY_TOKENS_LAST_RESET];
    const result = await browser.storage.local.get(keys);

    let lifetimeRequests = result[CACHE_KEY_LIFETIME_REQUESTS] || 0;
    let dailyTokensUsed = result[CACHE_KEY_DAILY_TOKENS_USED] || 0;
    let lastResetDate = result[CACHE_KEY_DAILY_TOKENS_LAST_RESET] || ''; // Stored as YYYY-MM-DD

    const today = new Date().toISOString().split('T')[0];
    let note = null;

    if (lastResetDate !== today) {
      log(`Daily token count reset. Previous: ${dailyTokensUsed} on ${lastResetDate}. New day: ${today}`);
      dailyTokensUsed = 0;
      lastResetDate = today;
      await browser.storage.local.set({
        [CACHE_KEY_DAILY_TOKENS_USED]: dailyTokensUsed,
        [CACHE_KEY_DAILY_TOKENS_LAST_RESET]: lastResetDate,
      });
      note = 'Daily token count was reset for the new day.';
    }
    return { lifetimeRequests, dailyTokensUsed, note, error: null };
  } catch (e) {
    errorLog('Failed to get API usage stats:', e.message);
    return { lifetimeRequests: 0, dailyTokensUsed: 0, note: null, error: 'Failed to retrieve API usage stats from storage.' };
  }
}

/**
 * Increments API usage statistics (lifetime requests and daily tokens used).
 * @async
 * @param {number} tokensIncrement - The number of tokens this API call cost.
 */
async function incrementApiStats(tokensIncrement) {
  if (typeof tokensIncrement !== 'number' || tokensIncrement <= 0) {
    errorLog('Invalid token increment value for API stats:', tokensIncrement);
    return;
  }
  try {
    const currentStats = await getApiUsageStatsInternal();
    if (currentStats.error) {
      errorLog('Cannot increment API stats due to error retrieving current stats:', currentStats.error);
      return;
    }

    const newLifetimeRequests = (currentStats.lifetimeRequests || 0) + 1;
    const newDailyTokensUsed = (currentStats.dailyTokensUsed || 0) + tokensIncrement;

    await browser.storage.local.set({
      [CACHE_KEY_LIFETIME_REQUESTS]: newLifetimeRequests,
      [CACHE_KEY_DAILY_TOKENS_USED]: newDailyTokensUsed,
      // CACHE_KEY_DAILY_TOKENS_LAST_RESET is handled by getApiUsageStatsInternal if it was a new day
    });
    log(`API stats incremented. Tokens: +${tokensIncrement}. New Daily Tokens: ${newDailyTokensUsed}, New Lifetime Requests: ${newLifetimeRequests}`);
  } catch (e) {
    errorLog('Failed to increment API stats:', e.message);
  }
}

// --- Video Data Utility Functions ---

/**
 * Merges new video data into existing video data, prioritizing newer non-null values.
 * @param {Object} existingVideo - The existing video object in the cache.
 * @param {Object} newVideoData - The new video data (e.g., from RSS or API).
 * @returns {Object} The merged video object.
 */
function _mergeVideoProperties(existingVideo, newVideoData) {
    const mergedVideo = { ...existingVideo };
    const fieldsToMerge = ['title', 'thumbnailUrl', 'publishedAt', 'duration', 'viewCountText', 'channelName'];

    fieldsToMerge.forEach(field => {
        if (newVideoData[field] && newVideoData[field] !== existingVideo[field]) {
            mergedVideo[field] = newVideoData[field];
        } else if (!existingVideo[field] && newVideoData[field]) {
            mergedVideo[field] = newVideoData[field];
        }
    });

    // Special handling for publishedAt to also update publishedTimeText
    if (newVideoData.publishedAt && newVideoData.publishedAt !== existingVideo.publishedAt) {
        mergedVideo.publishedAt = newVideoData.publishedAt;
        mergedVideo.publishedTimeText = newVideoData.publishedTimeText || formatRelativeDate(newVideoData.publishedAt);
    } else if (!existingVideo.publishedAt && newVideoData.publishedAt) {
        mergedVideo.publishedAt = newVideoData.publishedAt;
        mergedVideo.publishedTimeText = newVideoData.publishedTimeText || formatRelativeDate(newVideoData.publishedAt);
    }
    return mergedVideo;
}


/**
 * Sorts an array of video objects by published date (newest first) and removes duplicates by videoId.
 * If duplicates are found, properties are merged, prioritizing new non-null data.
 * @param {Array<Object>} videos - An array of video objects.
 * @returns {Array<Object>} A sorted array of unique video objects.
 */
function sortAndUniqueVideos(videos) {
  if (!Array.isArray(videos)) return [];

  const uniqueVideosMap = new Map();
  videos.forEach(video => {
    if (video && video.videoId) {
      const existingVideo = uniqueVideosMap.get(video.videoId);
      if (!existingVideo) {
        uniqueVideosMap.set(video.videoId, { ...video });
      } else {
        // Merge properties, preferring newer non-null values from `video`
        const mergedVideo = _mergeVideoProperties(existingVideo, video);
        uniqueVideosMap.set(video.videoId, mergedVideo);
      }
    }
  });

  const uniqueVideos = Array.from(uniqueVideosMap.values());
  uniqueVideos.sort((a, b) => {
    const dateA = new Date(a.publishedAt || 0).getTime();
    const dateB = new Date(b.publishedAt || 0).getTime();
    return dateB - dateA; // Newest first
  });
  return uniqueVideos;
}


/**
 * Formats a number of views into a simple string (e.g., "1.2M views").
 * Used primarily for RSS view counts which might be less precise.
 * @param {number} views - The number of views.
 * @returns {string|null} The formatted view count string, or null if views is NaN.
 */
function formatViewCountSimpleRss(views) {
  if (isNaN(views)) return null;
  if (views >= 1000000000) return `${(views / 1000000000).toFixed(1).replace(/\.0$/, '')}B views`;
  if (views >= 1000000) return `${(views / 1000000).toFixed(1).replace(/\.0$/, '')}M views`;
  if (views >= 1000) return `${Math.round(views / 1000)}K views`;
  return `${views.toLocaleString()} views`;
}

/**
 * Parses an RSS XML string and extracts video information.
 * @param {string} xmlText - The XML content of the RSS feed.
 * @returns {Array<Object>} An array of video objects extracted from the RSS feed.
 * @throws {Error} If XML parsing fails.
 */
function parseRssXml(xmlText) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, 'application/xml');

  const parseError = xmlDoc.querySelector('parsererror');
  if (parseError) {
    const errorDetails = parseError.textContent.split('\n')[0] || 'Unknown XML parsing error';
    errorLog('XML Parsing Error (direct in background):', errorDetails);
    throw new Error(`XML Parsing Error: ${errorDetails}`);
  }

  const entries = xmlDoc.querySelectorAll('feed > entry');
  if (!entries || entries.length === 0) {
    warnLogRss('No <entry> elements found in RSS feed (direct in background).');
    return [];
  }

  const videos = [];
  entries.forEach(entry => {
    const videoId = entry.querySelector('videoId')?.textContent || entry.querySelector('yt\\:videoId')?.textContent;
    const title = entry.querySelector('title')?.textContent;
    const link = entry.querySelector("link[rel='alternate']")?.getAttribute('href');
    const publishedAt = entry.querySelector('published')?.textContent;

    let thumbnailUrl = entry.querySelector('group > thumbnail[url]')?.getAttribute('url') ||
                       entry.querySelector('media\\:group > media\\:thumbnail[url]')?.getAttribute('url');
    if (thumbnailUrl) {
      thumbnailUrl = thumbnailUrl.replace('/hqdefault.jpg', '/mqdefault.jpg'); // Prefer mqdefault for consistency
    } else if (videoId) {
      thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`; // Fallback
    }

    let viewCountText = null;
    const statisticsNode = entry.querySelector('community > statistics[views]') ||
                           entry.querySelector('media\\:community > media\\:statistics[views]');
    if (statisticsNode) {
      const views = parseInt(statisticsNode.getAttribute('views'), 10);
      if (!isNaN(views)) {
        viewCountText = formatViewCountSimpleRss(views);
      }
    }
    const channelTitleElement = xmlDoc.querySelector("feed > author > name");
    const channelName = channelTitleElement ? channelTitleElement.textContent : null;


    if (videoId && title && link && publishedAt) {
      videos.push({
        videoId,
        title,
        url: link,
        publishedAt,
        thumbnailUrl,
        duration: null, // RSS doesn't provide duration
        viewCountText,
        channelName, // Add channel name from feed author
      });
    } else {
      warnLogRss('Skipped RSS entry due to missing critical data (ID, title, link, or publishedDate).',
        { videoId, hasTitle: !!title, hasLink: !!link, hasDate: !!publishedAt });
    }
  });

  log(`Parsed ${videos.length} videos from RSS (direct in background).`);
  return videos;
}


/**
 * Formats an ISO date string into a human-readable relative time string (e.g., "2 hours ago").
 * @param {string} isoDateString - The ISO date string to format.
 * @returns {string} The formatted relative date string, or an empty string if input is invalid.
 */
function formatRelativeDate(isoDateString) {
  if (!isoDateString) return '';
  try {
    const date = new Date(isoDateString);
    const now = new Date();
    const seconds = Math.round((now.getTime() - date.getTime()) / 1000);

    if (seconds < 5) return 'Just now';
    if (seconds < 60) return `${seconds} seconds ago`;

    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;

    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;

    const days = Math.round(hours / 24);
    if (days < 7) return `${days} day${days > 1 ? 's' : ''} ago`;
    if (days < 30.44) return `${Math.round(days / 7)} week${Math.round(days / 7) > 1 ? 's' : ''} ago`; // Use 30.44 for average month days
    if (days < 365.25) return `${Math.round(days / 30.44)} month${Math.round(days / 30.44) > 1 ? 's' : ''} ago`;

    return `${Math.round(days / 365.25)} year${Math.round(days / 365.25) > 1 ? 's' : ''} ago`;
  } catch (e) {
    errorLog('Error formatting relative date:', isoDateString, e.message);
    return '';
  }
}

/**
 * Formats an ISO 8601 duration string (e.g., "PT1H2M3S") into "H:MM:SS" or "MM:SS".
 * @param {string} isoDuration - The ISO 8601 duration string.
 * @returns {string|null} The formatted duration string, or null if input is invalid.
 */
function formatDuration(isoDuration) {
  if (!isoDuration || typeof isoDuration !== 'string') return null;
  const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;

  const hours = parseInt(match[1] || 0, 10);
  const minutes = parseInt(match[2] || 0, 10);
  const seconds = parseInt(match[3] || 0, 10);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Formats a number of views into a human-readable string (e.g., "1.2M views", "123K views").
 * @param {number|string} views - The number of views (can be a string that parses to a number).
 * @returns {string} The formatted view count string.
 */
function formatViewCount(views) {
  const numViews = typeof views === 'string' ? parseInt(views, 10) : views;
  if (typeof numViews !== 'number' || isNaN(numViews)) return 'N/A views';

  if (numViews >= 1000000000) return `${(numViews / 1000000000).toFixed(1).replace(/\.0$/, '')}B views`;
  if (numViews >= 1000000) return `${(numViews / 1000000).toFixed(1).replace(/\.0$/, '')}M views`;
  if (numViews >= 10000) return `${(numViews / 1000).toFixed(0)}K views`; // e.g., 12K views
  if (numViews >= 1000) return `${(numViews / 1000).toFixed(1).replace(/\.0$/, '')}K views`; // e.g., 1.2K views
  return `${numViews.toLocaleString()} views`;
}


// --- Data Fetching Functions ---

/**
 * Fetches video data from a channel's RSS feed.
 * @async
 * @param {string} uploadsPlaylistId - The uploads playlist ID (used to construct the RSS URL).
 * @returns {Promise<Array<Object>>} A promise that resolves to an array of video objects from RSS.
 */
async function fetchChannelVideosViaRss(uploadsPlaylistId) {
  if (!uploadsPlaylistId) {
    errorLog('Cannot fetch RSS: uploadsPlaylistId is missing.');
    return [];
  }
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?playlist_id=${uploadsPlaylistId}`;
  log(`Fetching RSS for playlist ${uploadsPlaylistId}`);
  try {
    const response = await fetch(rssUrl, { cache: 'no-store' }); // Avoid browser caching for RSS
    if (!response.ok) {
      throw new Error(`RSS fetch failed with status ${response.status} for playlist ${uploadsPlaylistId}`);
    }
    const xmlText = await response.text();
    const parsedVideos = parseRssXml(xmlText); // Uses the local, refactored parseRssXml
    log(`Parsed ${parsedVideos.length} videos from RSS for ${uploadsPlaylistId}`);
    return parsedVideos.map(v => ({ ...v, publishedTimeText: formatRelativeDate(v.publishedAt) }));
  } catch (error) {
    errorLog(`Error fetching/parsing RSS for ${uploadsPlaylistId}:`, error.message);
    return [];
  }
}


/**
 * Fetches videos from a channel's uploads playlist using the YouTube Data API (playlistItems.list).
 * @async
 * @param {string} uploadsPlaylistId - The ID of the "uploads" playlist for the channel.
 * @param {string} apiKey - The YouTube Data API key.
 * @param {string|null} [pageToken=null] - The page token for pagination.
 * @returns {Promise<{videos: Array<Object>, nextPageToken: string|null, error: string|null}>}
 *          An object containing fetched videos, the next page token, and any error message.
 */
async function fetchChannelVideosViaPlaylistItems(uploadsPlaylistId, apiKey, pageToken = null) {
  if (!apiKey) return { videos: [], nextPageToken: null, error: 'API key missing.' };
  if (!uploadsPlaylistId) return { videos: [], nextPageToken: null, error: 'Uploads Playlist ID missing.' };

  let apiUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=${PLAYLIST_ITEMS_MAX_RESULTS}&key=${apiKey}`;
  if (pageToken) apiUrl += `&pageToken=${pageToken}`;

  log(`Fetching PlaylistItems for playlist ${uploadsPlaylistId}, page: ${pageToken || 'first'}`);
  await incrementApiStats(1); // Cost for playlistItems.list is 1 unit.
  try {
    const response = await fetch(apiUrl);
    const data = await response.json();

    if (data.error) {
      throw new Error(`API PlaylistItems Error (${data.error.code || 'Unknown'}): ${data.error.message || 'Unknown API error'}`);
    }
    if (!data.items) return { videos: [], nextPageToken: data.nextPageToken || null, error: null };

    const videos = data.items
      .filter(item =>
        item.snippet?.resourceId?.videoId &&
        item.snippet.title !== 'Private video' && // Exclude known unavailable videos
        item.snippet.title !== 'Deleted video'
      )
      .map(item => ({
        videoId: item.snippet.resourceId.videoId,
        title: item.snippet.title,
        url: `https://www.youtube.com/watch?v=${item.snippet.resourceId.videoId}`,
        publishedAt: item.snippet.publishedAt,
        thumbnailUrl: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
        channelName: item.snippet.channelTitle,
        duration: null, // To be fetched later by videos.list if needed
        viewCountText: null, // To be fetched later by videos.list if needed
        publishedTimeText: formatRelativeDate(item.snippet.publishedAt),
      }));
    log(`Fetched ${videos.length} videos via PlaylistItems for playlist ${uploadsPlaylistId}. Next page: ${data.nextPageToken || 'END'}`);
    return { videos, nextPageToken: data.nextPageToken || null, error: null };
  } catch (error) {
    errorLog(`Error in fetchChannelVideosViaPlaylistItems for playlist ${uploadsPlaylistId}:`, error.message);
    return { videos: [], nextPageToken: pageToken, error: error.message }; // Return original pageToken for potential retry
  }
}

/**
 * Fetches detailed video information (duration, view count, etc.) using the YouTube Data API (videos.list).
 * @async
 * @param {Array<string>} videoIds - An array of video IDs to fetch details for.
 * @param {string} apiKey - The YouTube Data API key.
 * @returns {Promise<{detailsMap: Object, error: string|null}>}
 *          An object containing a map of videoId to details, and any error message.
 */
async function fetchVideoDetailsViaApi(videoIds, apiKey) {
  if (!apiKey) return { detailsMap: {}, error: 'API key missing.' };
  if (!videoIds || videoIds.length === 0) return { detailsMap: {}, error: null };

  // Ensure not over API limit per request
  const idsToFetch = videoIds.slice(0, API_VIDEOS_MAX_IDS);

  const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics,snippet&id=${idsToFetch.join(',')}&key=${apiKey}`;
  log(`Fetching API Details for ${idsToFetch.length} videos: [${idsToFetch.slice(0, 2).join(', ')}...]`);
  await incrementApiStats(1); // Cost for videos.list is 1 unit.
  try {
    const response = await fetch(apiUrl);
    const data = await response.json();

    if (data.error) {
      throw new Error(`API Video Details Error (${data.error.code || 'Unknown'}): ${data.error.message || 'Unknown API error'}`);
    }
    if (!data.items) return { detailsMap: {}, error: null };

    const detailsMap = {};
    data.items.forEach(item => {
      if (!item.id) return;
      detailsMap[item.id] = {
        duration: formatDuration(item.contentDetails?.duration),
        viewCountText: item.statistics?.viewCount ? formatViewCount(item.statistics.viewCount) : 'N/A views',
        // snippet can also provide potentially more up-to-date title, thumbnail, publishedAt
        title: item.snippet?.title || undefined, // Keep undefined if not present to allow coalesce with existing
        thumbnailUrl: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || undefined,
        publishedAt: item.snippet?.publishedAt || undefined,
        publishedTimeText: item.snippet?.publishedAt ? formatRelativeDate(item.snippet.publishedAt) : undefined,
        channelName: item.snippet?.channelTitle || undefined,
      };
    });
    log(`Fetched details map via API for ${Object.keys(detailsMap).length} videos.`);
    return { detailsMap, error: null };
  } catch (error) {
    errorLog(`Error in fetchVideoDetailsViaApi for IDs [${idsToFetch.join(', ')}]:`, error.message);
    return { detailsMap: {}, error: error.message };
  }
}

// --- Core Logic: Get Navigation Videos ---

/**
 * Checks if a video object has the minimum required details fetched from RSS or playlistItems.
 * @param {Object} video - The video object.
 * @returns {boolean} True if basic details are present.
 */
function hasSufficientBaseDetails(video) {
  return video && video.videoId && video.title && video.publishedAt && video.thumbnailUrl;
}

/**
 * Checks if a video object has all details required for display (including those from videos.list API).
 * @param {Object} video - The video object.
 * @returns {boolean} True if all display details are present.
 */
function hasRequiredDisplayDetails(video) {
  return hasSufficientBaseDetails(video) &&
         typeof video.duration === 'string' && video.duration.includes(':') && // Check for valid formatted duration
         video.viewCountText;
}

/**
 * Identifies the type of API error based on the error message.
 * @param {string} errorMessage - The error message from an API response.
 * @returns {string|null} The error type ('QUOTA_EXCEEDED', 'API_KEY_INVALID', 'PLAYLIST_NOT_FOUND', 'OTHER_API_ERROR') or null.
 */
function identifyApiErrorType(errorMessage) {
  if (!errorMessage) return null;
  if (errorMessage.includes('quotaExceeded') || errorMessage.includes('servingLimitExceeded')) return 'QUOTA_EXCEEDED';
  if (errorMessage.includes('keyInvalid') || errorMessage.includes('forbidden') || errorMessage.includes('accessNotConfigured')) return 'API_KEY_INVALID';
  if (errorMessage.includes('playlistNotFound')) return 'PLAYLIST_NOT_FOUND'; // For playlistItems specifically
  // Add more specific error checks if needed
  return 'OTHER_API_ERROR';
}

/**
 * Retrieves the chronologically previous and next videos for a given video on a channel.
 * Manages caching, RSS fetching, and API calls for video data.
 * @async
 * @param {string} channelId - The ID of the YouTube channel.
 * @param {string} currentVideoId - The ID of the currently viewed video.
 * @returns {Promise<{prevVideo: Object|null, nextVideo: Object|null, error?: string}>}
 *          An object containing the previous and next video objects, or an error message.
 */
async function getNavigationVideos(channelId, currentVideoId) {
  log(`Requesting nav videos for channel ${channelId}, current: ${currentVideoId}. Token budget: ${TOKEN_BUDGET_PER_RUN}`);
  let channelData = await getChannelData(channelId);
  const apiKey = await getApiKey();
  let cacheWasModified = false; // Tracks if channelData object itself was changed (e.g. pageToken, timestamp, errorState)
  let fetchedNewVideoObjects = false; // Tracks if any network fetch (RSS or API) added new video *objects* or significantly updated existing ones
  let tokensUsedThisRun = 0;

  const initialVideoCacheStateSignature = JSON.stringify(
    channelData.videos.map(v => `${v.videoId}:${v.title}:${v.publishedAt}:${v.duration}:${v.viewCountText}`)
  );


  // --- Step 0: Pre-computation and Initial Checks ---
  let derivedUploadsPlaylistId = null;
  if (channelId && channelId.startsWith('UC')) {
    derivedUploadsPlaylistId = 'UULF' + channelId.substring(2); // For "Uploads" excluding shorts/live streams
  } else {
    errorLog(`Invalid channelId format: ${channelId}. Cannot derive uploads playlist ID for API calls.`);
    // Fallback to 'UU' + channelId.substring(2) for RSS which uses the broader uploads playlist
    if (channelId && channelId.startsWith('UC')) {
        derivedUploadsPlaylistId = 'UU' + channelId.substring(2);
        log(`Using broad uploads playlist ID ${derivedUploadsPlaylistId} for RSS due to UULF derivation issue or preference.`);
    } else {
        // If still no valid playlist ID, API calls for playlist items will be skipped. RSS might also fail.
        // This path largely relies on the channel ID itself if no playlist can be derived.
    }
  }


  if (!apiKey) {
    log('No API key available. API fetches will be skipped.');
  } else if (channelData.apiErrorState === 'QUOTA_EXCEEDED' || channelData.apiErrorState === 'API_KEY_INVALID') {
    log(`Skipping API calls for channel ${channelId} due to persistent error state: ${channelData.apiErrorState}`);
  }

  // --- Step 1: Initial Cache Check & Candidate Prep ---
  let currentIndex = channelData.videos.findIndex(v => v.videoId === currentVideoId);
  let prevVideoCandidate = (currentIndex > 0) ? channelData.videos[currentIndex - 1] : null;
  let nextVideoCandidate = (currentIndex !== -1 && currentIndex < channelData.videos.length - 1) ? channelData.videos[currentIndex + 1] : null;


  // --- Step 2: RSS Fetch ---
  // Conditions: Stale RSS, current video not found, or current video near newest edge of cache, or prev video candidate lacks base details.
  const now = Date.now();
  const isRssStale = now - channelData.lastRssFetchTimestamp > RSS_FETCH_DEBOUNCE_MS;
  const needsNewerFromRss = currentIndex === -1 || currentIndex < 2 || (prevVideoCandidate && !hasSufficientBaseDetails(prevVideoCandidate));

  if ((isRssStale || needsNewerFromRss) && derivedUploadsPlaylistId) { // RSS needs a playlist ID
    log(`Fetching RSS (stale: ${isRssStale}, needs newer/details: ${needsNewerFromRss}) for playlist ${derivedUploadsPlaylistId}`);
    const rssVideos = await fetchChannelVideosViaRss(derivedUploadsPlaylistId); // No token cost
    if (rssVideos.length > 0) {
      const originalVideoCount = channelData.videos.length;
      const oldVideosSignature = JSON.stringify(channelData.videos.map(v => `${v.videoId}:${v.title}:${v.publishedAt}`));

      channelData.videos = sortAndUniqueVideos([...rssVideos, ...channelData.videos]);

      const newVideosSignature = JSON.stringify(channelData.videos.map(v => `${v.videoId}:${v.title}:${v.publishedAt}`));

      if (channelData.videos.length > originalVideoCount || oldVideosSignature !== newVideosSignature) {
        fetchedNewVideoObjects = true;
      }
      log(`RSS fetch processed. Total videos now: ${channelData.videos.length}`);
      if (!channelData.channelName && rssVideos[0]?.channelName) {
        channelData.channelName = rssVideos[0].channelName;
        cacheWasModified = true;
      }
    }
    channelData.lastRssFetchTimestamp = now; // Update timestamp even if fetch fails/empty
    cacheWasModified = true;

    // Re-evaluate after potential RSS additions
    currentIndex = channelData.videos.findIndex(v => v.videoId === currentVideoId);
    prevVideoCandidate = (currentIndex > 0) ? channelData.videos[currentIndex - 1] : null;
    nextVideoCandidate = (currentIndex !== -1 && currentIndex < channelData.videos.length - 1) ? channelData.videos[currentIndex + 1] : null;
  }


  // --- Step 3: API-based Fetching (PlaylistItems) ---
  const canAttemptApiPlaylistFetch = apiKey && derivedUploadsPlaylistId &&
                                     channelData.apiErrorState !== 'QUOTA_EXCEEDED' &&
                                     channelData.apiErrorState !== 'API_KEY_INVALID' &&
                                     channelData.apiErrorState !== 'PLAYLIST_NOT_FOUND' && // If previously marked as not found
                                     channelData.lastPlaylistItemsPageToken !== 'END';

  if (canAttemptApiPlaylistFetch) {
    let needsMoreFromPlaylistApi = false;
    if (currentIndex === -1) { // Current video not in cache
      needsMoreFromPlaylistApi = true;
      log(`Current video ${currentVideoId} not found. Will try PlaylistItems API for ${derivedUploadsPlaylistId}.`);
    } else if (currentIndex >= channelData.videos.length - 2) { // Near the oldest end of cache, or next video candidate missing/incomplete
      needsMoreFromPlaylistApi = true;
      log(`Needs older video than ${currentVideoId} (index ${currentIndex}, total ${channelData.videos.length}) or next video incomplete. Will try PlaylistItems API.`);
    }


    while (needsMoreFromPlaylistApi && channelData.lastPlaylistItemsPageToken !== 'END' && tokensUsedThisRun < TOKEN_BUDGET_PER_RUN) {
      log(`Fetching page from PlaylistItems for ${derivedUploadsPlaylistId}. PageToken: ${channelData.lastPlaylistItemsPageToken || 'first'}. Tokens remaining: ${TOKEN_BUDGET_PER_RUN - tokensUsedThisRun}.`);
      const apiResult = await fetchChannelVideosViaPlaylistItems(derivedUploadsPlaylistId, apiKey, channelData.lastPlaylistItemsPageToken);
      tokensUsedThisRun++; // Increment internal budget counter
      cacheWasModified = true; // Page token will change, or error state

      if (apiResult.error) {
        errorLog(`PlaylistItems API for ${derivedUploadsPlaylistId} returned error: ${apiResult.error}`);
        const errorType = identifyApiErrorType(apiResult.error);
        if (errorType === 'QUOTA_EXCEEDED' || errorType === 'API_KEY_INVALID' || errorType === 'PLAYLIST_NOT_FOUND') {
          channelData.apiErrorState = errorType;
          log(`Setting persistent API error for ${channelId} to ${errorType}. Further PlaylistItems fetches this run disabled.`);
        }
        // For other errors, we might retry next time with the same page token.
        break; // Stop trying PlaylistItems in this cycle on any error.
      }

      if (apiResult.videos.length > 0) {
        if (!channelData.channelName && apiResult.videos[0]?.channelName) {
          channelData.channelName = apiResult.videos[0].channelName;
        }
        const originalVideoCount = channelData.videos.length;
        channelData.videos = sortAndUniqueVideos([...channelData.videos, ...apiResult.videos]);
        if (channelData.videos.length > originalVideoCount) fetchedNewVideoObjects = true;
        log(`PlaylistItems API added ${channelData.videos.length - originalVideoCount} new unique videos to ${channelId}.`);
      }

      channelData.lastPlaylistItemsPageToken = apiResult.nextPageToken || 'END';
      if (channelData.lastPlaylistItemsPageToken === 'END') log(`PlaylistItems API reached end for ${derivedUploadsPlaylistId}.`);

      // Re-evaluate current index and candidates
      currentIndex = channelData.videos.findIndex(v => v.videoId === currentVideoId);
      prevVideoCandidate = (currentIndex > 0) ? channelData.videos[currentIndex - 1] : null;
      nextVideoCandidate = (currentIndex !== -1 && currentIndex < channelData.videos.length - 1) ? channelData.videos[currentIndex + 1] : null;

      if (currentIndex !== -1) {
        // Check if we still need more older videos
        needsMoreFromPlaylistApi = (currentIndex >= channelData.videos.length - 2);
        if (!needsMoreFromPlaylistApi) log(`Current video ${currentVideoId} found and older neighbor potentially available or at cache end. Halting playlist fetches.`);
      } else {
        log(`Current video ${currentVideoId} still not found after PlaylistItems fetch.`);
        needsMoreFromPlaylistApi = true; // Continue if budget allows
      }
    }
  }


  // --- Step 3b: Trim Cache ---
  if (fetchedNewVideoObjects && channelData.videos.length > MAX_VIDEOS_PER_CHANNEL) {
    channelData.videos = channelData.videos.slice(0, MAX_VIDEOS_PER_CHANNEL); // Keep newest
    log(`Trimmed channel ${channelId} cache to ${MAX_VIDEOS_PER_CHANNEL} videos.`);
    cacheWasModified = true; // Videos array changed
    // Re-evaluate index after trimming, though less critical at this stage for nav
    currentIndex = channelData.videos.findIndex(v => v.videoId === currentVideoId);
    prevVideoCandidate = (currentIndex > 0) ? channelData.videos[currentIndex - 1] : null;
    nextVideoCandidate = (currentIndex !== -1 && currentIndex < channelData.videos.length - 1) ? channelData.videos[currentIndex + 1] : null;
  }


  // --- Step 4: Identify Final Navigation Videos (from potentially updated cache) ---
  let prevVideo = null, nextVideo = null;
  if (currentIndex !== -1) {
    if (currentIndex > 0) prevVideo = { ...channelData.videos[currentIndex - 1] }; // Return copies
    if (currentIndex < channelData.videos.length - 1) nextVideo = { ...channelData.videos[currentIndex + 1] };
    log(`Nav video candidates for ${currentVideoId}: Prev: ${prevVideo?.videoId || 'N/A'}, Next: ${nextVideo?.videoId || 'N/A'}`);
  } else {
    log(`Current video ${currentVideoId} not found in cache of ${channelData.videos.length} for channel ${channelId}. No navigation possible.`);
  }


  // --- Step 5: Fetch API Details for Nav Videos (if needed and budget allows) ---
  const videosToDetailIds = [];
  if (prevVideo && !hasRequiredDisplayDetails(prevVideo)) videosToDetailIds.push(prevVideo.videoId);
  if (nextVideo && !hasRequiredDisplayDetails(nextVideo)) videosToDetailIds.push(nextVideo.videoId);

  const uniqueVideoIdsToDetail = [...new Set(videosToDetailIds)];

  const canAttemptApiDetailsFetch = apiKey && uniqueVideoIdsToDetail.length > 0 &&
                                  channelData.apiErrorState !== 'QUOTA_EXCEEDED' &&
                                  channelData.apiErrorState !== 'API_KEY_INVALID' &&
                                  tokensUsedThisRun < TOKEN_BUDGET_PER_RUN;

  if (canAttemptApiDetailsFetch) {
    log(`Fetching API details for ${uniqueVideoIdsToDetail.length} nav videos for ${channelId}: [${uniqueVideoIdsToDetail.join(', ')}]. Tokens remaining: ${TOKEN_BUDGET_PER_RUN - tokensUsedThisRun}`);
    const { detailsMap, error: detailsError } = await fetchVideoDetailsViaApi(uniqueVideoIdsToDetail, apiKey);
    tokensUsedThisRun++; // Increment internal budget counter
    cacheWasModified = true; // Potential error state change

    if (detailsError) {
      errorLog(`Error fetching video details for ${channelId}: ${detailsError}`);
      const errorType = identifyApiErrorType(detailsError);
      if (errorType === 'QUOTA_EXCEEDED' || errorType === 'API_KEY_INVALID') {
        channelData.apiErrorState = errorType;
        log(`Setting persistent API error for ${channelId} to ${errorType} due to video details fetch failure.`);
      }
    } else {
      const applyDetails = (targetVideoObj, fetchedDetails) => {
        if (targetVideoObj && fetchedDetails) {
          let videoModifiedByDetails = false;
          // Apply details, preferring new API data if it's different or fills a gap
          ['title', 'thumbnailUrl', 'publishedAt', 'duration', 'viewCountText', 'channelName'].forEach(key => {
            if (fetchedDetails[key] !== undefined && targetVideoObj[key] !== fetchedDetails[key]) {
              targetVideoObj[key] = fetchedDetails[key];
              videoModifiedByDetails = true;
              if (key === 'publishedAt') { // Also update relative time text
                targetVideoObj.publishedTimeText = formatRelativeDate(fetchedDetails.publishedAt);
              }
            }
          });

          if (videoModifiedByDetails) {
            const cachedIdx = channelData.videos.findIndex(v => v.videoId === targetVideoObj.videoId);
            if (cachedIdx !== -1) {
              channelData.videos[cachedIdx] = { ...channelData.videos[cachedIdx], ...targetVideoObj }; // Update main cache
              // fetchedNewVideoObjects = true; // Set if details significantly alter the video object state for saving purposes
            }
            log(`Applied API details to ${targetVideoObj.videoId}. Duration: ${targetVideoObj.duration}, Views: ${targetVideoObj.viewCountText}`);
          }
        }
      };
      if (prevVideo && detailsMap[prevVideo.videoId]) applyDetails(prevVideo, detailsMap[prevVideo.videoId]);
      if (nextVideo && detailsMap[nextVideo.videoId]) applyDetails(nextVideo, detailsMap[nextVideo.videoId]);
    }
  }


  // --- Step 6: Final Formatting for Nav Videos ---
  [prevVideo, nextVideo].forEach(v => {
    if (v) {
      if (v.publishedAt && !v.publishedTimeText) v.publishedTimeText = formatRelativeDate(v.publishedAt);
      if (!v.title) v.title = 'Video Title Unavailable';
      if (!v.thumbnailUrl) v.thumbnailUrl = ''; // Placeholder or empty string
      // Ensure duration and viewCountText are at least null if not properly fetched
      if (v.duration === undefined) v.duration = null;
      if (v.viewCountText === undefined) v.viewCountText = null;
    }
  });


  // --- Step 7: Save Channel Data ---
  const finalVideoCacheStateSignature = JSON.stringify(
    channelData.videos.map(v => `${v.videoId}:${v.title}:${v.publishedAt}:${v.duration}:${v.viewCountText}`)
  );

  // Save if cache structure changed (timestamp, pageToken, errorState),
  // or new video objects were added/significantly updated,
  // or specific details of existing videos in cache were modified by API.
  if (cacheWasModified || fetchedNewVideoObjects || initialVideoCacheStateSignature !== finalVideoCacheStateSignature) {
    log(`Saving channel data for ${channelId} due to modifications. Tokens used this run: ${tokensUsedThisRun}`);
    await saveChannelData(channelId, channelData);
  } else {
    log(`No significant modifications to channel ${channelId} data that require saving. Tokens used this run: ${tokensUsedThisRun}`);
  }

  log(`Final nav response for ${currentVideoId} on channel ${channelId}: Prev: ${prevVideo?.videoId || 'N/A'}, Next: ${nextVideo?.videoId || 'N/A'}`);
  return { prevVideo, nextVideo }; // Return copies, not direct cache references
}


// --- Event Listeners ---
browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
  log(`Message received: ${request.type} from ${sender.tab ? 'Tab ' + sender.tab.id : 'Extension'}`);
  switch (request.type) {
    case 'GET_NAV_VIDEOS':
      if (!request.channelId || !request.currentVideoId) {
        errorLog('GET_NAV_VIDEOS missing channelId or currentVideoId.');
        sendResponse({ error: 'Missing channelId or currentVideoId.' });
        return false; // Synchronous response for this specific validation error
      }
      getNavigationVideos(request.channelId, request.currentVideoId)
        .then(response => sendResponse(response))
        .catch(e => {
          errorLog('Error in getNavigationVideos promise chain:', e.message, e.stack);
          sendResponse({ error: e.message || 'Unknown error in getNavigationVideos.' });
        });
      return true; // Indicate async response

    case 'CLEAR_CACHE':
      browser.storage.local.remove(CACHE_KEY_CHANNELS_DATA)
        .then(() => {
          log('Cache cleared successfully.');
          sendResponse({ success: true });
        })
        .catch(e => {
          errorLog('Error clearing cache:', e.message);
          sendResponse({ success: false, error: e.message });
        });
      return true; // Indicate async response

    case 'GET_CACHE_STATS':
      browser.storage.local.get(CACHE_KEY_CHANNELS_DATA)
        .then(result => {
          const channels = result[CACHE_KEY_CHANNELS_DATA] || {};
          let videoCount = 0;
          Object.values(channels).forEach(data => videoCount += data.videos?.length || 0);
          log(`Cache stats: ${Object.keys(channels).length} channels, ${videoCount} videos.`);
          sendResponse({ channelCount: Object.keys(channels).length, videoCount });
        })
        .catch(e => {
          errorLog('Error getting cache stats:', e.message);
          sendResponse({ channelCount: 0, videoCount: 0, error: e.message });
        });
      return true; // Indicate async response

    case 'GET_API_USAGE_STATS':
      getApiUsageStatsInternal()
        .then(stats => {
          if (stats.error) {
            sendResponse({ lifetimeRequests: 'N/A', dailyTokensUsed: 'N/A', error: stats.error, note: stats.note });
          } else {
            log(`Sending API Usage Stats: Lifetime ${stats.lifetimeRequests}, Daily ${stats.dailyTokensUsed}, Note: ${stats.note}`);
            sendResponse({
              lifetimeRequests: stats.lifetimeRequests,
              dailyTokensUsed: stats.dailyTokensUsed,
              note: stats.note, // Pass along any notes (like reset info)
              error: null
            });
          }
        })
        .catch(e => {
          errorLog('Error processing GET_API_USAGE_STATS:', e.message);
          sendResponse({ lifetimeRequests: 'N/A', dailyTokensUsed: 'N/A', error: e.message, note: null });
        });
      return true; // Indicate async response

    default:
      log(`Unhandled message type: ${request.type}`);
      // sendResponse({ error: `Unhandled message type: ${request.type}` }); // Optional: respond for unhandled
      return false; // No async response for unhandled types
  }
});


/**
 * Initializes or updates extension settings on installation or update.
 * @param {Object} details - Details about the installation or update event.
 */
function handleInstallOrUpdate(details) {
  log(`Extension ${details.reason}. Version: ${browser.runtime.getManifest().version}`);
  if (details.reason === 'install') {
    log('Extension installed. Performing first-time setup.');
    const today = new Date().toISOString().split('T')[0];
    browser.storage.local.set({
      [CACHE_KEY_LIFETIME_REQUESTS]: 0,
      [CACHE_KEY_DAILY_TOKENS_USED]: 0,
      [CACHE_KEY_DAILY_TOKENS_LAST_RESET]: today,
    }).then(() => {
      log('Initialized API usage stats on install.');
    }).catch(e => errorLog("Error initializing API stats on install:", e.message));
  } else if (details.reason === 'update') {
    log('Extension updated. Performing migration logic if any.');
    // Ensure API stats keys exist if updating from a version that didn't have them
    getApiUsageStatsInternal().then(stats => {
      log('Checked API stats on update. Current daily tokens:', stats.dailyTokensUsed);
      // If stats were just created (e.g. all zeros and a new date), it means they were missing.
      if (stats.lifetimeRequests === 0 && stats.dailyTokensUsed === 0 &&
          stats.lastResetDate === new Date().toISOString().split('T')[0] && !stats.note?.includes("reset")) {
         log("API usage stats keys seem to have been newly initialized on update.");
      }
    }).catch(e => errorLog("Error checking API stats on update:", e.message));

    // Remove very old cache key if present (example migration)
    const oldCacheKey = 'chronoNavChannelsData_v1';
    browser.storage.local.get(oldCacheKey)
      .then(items => {
        if (items[oldCacheKey]) {
          log(`Old cache key '${oldCacheKey}' found. Removing for compatibility.`);
          return browser.storage.local.remove(oldCacheKey);
        }
      })
      .then(removed => {
        if (removed !== undefined) log(`Successfully removed old cache key '${oldCacheKey}'.`);
      })
      .catch(e => errorLog(`Error during cleanup of old cache key '${oldCacheKey}':`, e.message));
  }
}

browser.runtime.onInstalled.addListener(handleInstallOrUpdate);

log('Service worker started. Event listeners attached.');