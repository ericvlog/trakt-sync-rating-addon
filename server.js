import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import axios from 'axios';
import crypto from 'crypto';

// ============================================
// Vercel-specific fixes
// ============================================

const isVercel = process.env.VERCEL || process.env.VERCEL_URL;

// Disable token refresh on Vercel
if (isVercel) {
  console.log('🚀 Running on Vercel - token refresh disabled');
  
  // Store the original function
  const originalRefreshTraktTokens = refreshTraktTokens;
  
  // Override the refresh function
  refreshTraktTokens = async function(userConfig) {
    console.log('[TOKEN REFRESH] Skipping refresh on Vercel due to network restrictions');
    return null; // Don't attempt refresh
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 7000;

// Determine SERVER_URL for different environments
let SERVER_URL = process.env.SERVER_URL;

if (!SERVER_URL) {
  if (process.env.VERCEL_URL) {
    SERVER_URL = `https://${process.env.VERCEL_URL}`;
  } else if (process.env.RENDER_EXTERNAL_URL) {
    SERVER_URL = process.env.RENDER_EXTERNAL_URL;
  } else if (process.env.NODE_ENV === 'production') {
    SERVER_URL = `https://stremio-trakt.pls3333.duckdns.org`;
  } else {
    SERVER_URL = `http://localhost:${PORT}`;
  }
}

// ============================================
// CDN Configuration
// ============================================
const CDN_BASE = "https://cdn.jsdelivr.net/gh/ericvlog/trakt-sync-rating-addon@main/public";
const LOGO_URL = `${CDN_BASE}/logo.png`;
const BACKGROUND_URL = `${CDN_BASE}/background.png`;
const ICON_URL = `${CDN_BASE}/icon.png`;

// ============================================
// CORS Middleware
// ============================================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

app.options('*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.sendStatus(200);
});

app.use(express.json());
app.use(express.static('public'));

// Store OAuth states and pending requests
const oauthStates = new Map();
const pendingRequests = new Map();

// Cache for TMDB and Trakt data
const tmdbCache = new Map();
const traktStatsCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// Cache for Upstash tokens
const upstashTokenCache = new Map();
const UPSTASH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ============================================
// Upstash Redis Helper Functions
// ============================================

// Generate unique ID for each configuration
function generateConfigId() {
  return crypto.randomBytes(16).toString('hex');
}

// HTTP-based Upstash functions with timeout and retry
async function upstashSet(upstashUrl, upstashToken, key, value, ttlSeconds = 90 * 24 * 60 * 60) {
  try {
    const encodedValue = encodeURIComponent(value);
    const response = await axios.get(
      `${upstashUrl}/set/${key}/${encodedValue}${ttlSeconds ? `?ex=${ttlSeconds}` : ''}`,
      {
        headers: {
          'Authorization': `Bearer ${upstashToken}`,
          'Accept': 'application/json'
        },
        timeout: 10000 // Increased timeout for reliability
      }
    );
    return response.data;
  } catch (error) {
    console.error('Upstash set error:', error.message);
    throw error;
  }
}

async function upstashGet(upstashUrl, upstashToken, key) {
  try {
    const response = await axios.get(`${upstashUrl}/get/${key}`, {
      headers: {
        'Authorization': `Bearer ${upstashToken}`,
        'Accept': 'application/json'
      },
      timeout: 10000 // Increased timeout for reliability
    });
    return response.data.result;
  } catch (error) {
    console.error('Upstash get error:', error.message);
    throw error;
  }
}

// Test Upstash connection
async function testUpstashConnection(upstashUrl, upstashToken) {
  try {
    const testKey = `test:${Date.now()}`;
    await upstashSet(upstashUrl, upstashToken, testKey, 'test_value', 60);
    const testValue = await upstashGet(upstashUrl, upstashToken, testKey);
    return testValue === 'test_value';
  } catch (error) {
    console.error('Upstash test error:', error.message);
    return false;
  }
}

// ============================================
// Helper Functions
// ============================================

// Base64 helpers
function encodeConfig(config) {
  try {
    const jsonStr = JSON.stringify(config);
    return Buffer.from(jsonStr).toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  } catch (error) {
    console.error('Error encoding config:', error);
    return null;
  }
}

function decodeConfig(configString) {
  try {
    let base64 = configString.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0) {
      base64 += '=';
    }
    const jsonStr = Buffer.from(base64, 'base64').toString('utf8');
    return JSON.parse(jsonStr);
  } catch (error) {
    console.error('Error decoding config:', error);
    return null;
  }
}

// Parse Stremio ID
function parseStremioId(id, type) {
  if (type === 'movie' && id.startsWith('tt')) {
    return { imdbId: id };
  }

  if (type === 'series') {
    if (id.includes(':')) {
      const parts = id.split(':');
      if (parts.length === 3) {
        return {
          imdbId: parts[0],
          season: parseInt(parts[1]),
          episode: parseInt(parts[2])
        };
      }
    } else if (id.startsWith('tt')) {
      return { imdbId: id };
    }
  }

  return null;
}

// Get media emoji
function getMediaEmoji(type, title = '') {
  if (type === 'movie') {
    return '🎬';
  } else if (type === 'series') {
    const lowerTitle = title.toLowerCase();
    const animeKeywords = ['attack on titan', 'demon slayer', 'naruto', 'one piece',
                          'dragon ball', 'my hero academia', 'bleach', 'hunter x hunter'];
    const animationKeywords = ['rick and morty', 'south park', 'family guy', 'simpsons'];
    const docKeywords = ['planet earth', 'cosmos', 'blue planet', 'documentary'];

    if (animeKeywords.some(keyword => lowerTitle.includes(keyword))) return '🐉';
    else if (animationKeywords.some(keyword => lowerTitle.includes(keyword))) return '🎨';
    else if (docKeywords.some(keyword => lowerTitle.includes(keyword))) return '📽️';
    else return '📺';
  }
  return '🎬';
}

// ============================================
// Number Formatting Helper
// ============================================

function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  }
  return num.toString();
}

// ============================================
// Stat Emoji Mapping
// ============================================

function getStatEmoji(stat) {
  const emojiMap = {
    'watchers': '👁️',
    'plays': '▶️',
    'comments': '💬',
    'lists': '📋',
    'collectors': '⭐',
    'votes': '👍',
    'rating': '⭐'
  };
  return emojiMap[stat] || '📊';
}

// ============================================
// Stat Display Name Mapping
// ============================================

function getStatDisplayName(stat, value) {
  const displayMap = {
    'watchers': value === 1 ? 'watcher' : 'watchers',
    'plays': value === 1 ? 'play' : 'plays',
    'comments': value === 1 ? 'comment' : 'comments',
    'lists': value === 1 ? 'list' : 'lists',
    'collectors': value === 1 ? 'collector' : 'collectors',
    'votes': value === 1 ? 'vote' : 'votes',
    'rating': 'rating'
  };
  return displayMap[stat] || stat;
}

// ============================================
// Trakt Stats Fetcher
// ============================================

async function fetchTraktStats(imdbId, type, clientId) {
  const cacheKey = `${imdbId}_${type}_stats`;
  const now = Date.now();

  // Check cache
  const cached = traktStatsCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < CACHE_TTL) {
    console.log(`[TRAKT STATS] Using cached stats for ${imdbId}`);
    return cached.stats;
  }

  try {
    console.log(`[TRAKT STATS] Fetching stats for ${imdbId} (${type})`);

    const mediaType = type === 'movie' ? 'movies' : 'shows';
    const url = `https://api.trakt.tv/${mediaType}/${imdbId}/stats`;

    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': clientId
      }
    });

    if (!response.ok) {
      console.log(`[TRAKT STATS] Failed: ${response.status}`);
      return null;
    }

    const stats = await response.json();

    // Cache the result
    traktStatsCache.set(cacheKey, {
      stats: stats,
      timestamp: now
    });

    console.log(`[TRAKT STATS] Found:`, stats);
    return stats;

  } catch (error) {
    console.error(`[TRAKT STATS] Error: ${error.message}`);
    return null;
  }
}

// ============================================
// Rating Visual Generator
// ============================================

function generateRatingVisual(style, rating) {
    let visual = '';
    const numRating = parseInt(rating);

    if (!style || style === 'stars') {
        // Classic Stars (default)
        for (let i = 1; i <= 10; i++) {
            visual += i <= numRating ? '★' : '☆';
        }
    } else if (style === 'hearts') {
        // Emoji Hearts
        for (let i = 1; i <= 10; i++) {
            visual += i <= numRating ? '❤️' : '🤍';
        }
    } else if (style === 'progress') {
        // Progress Bar
        for (let i = 1; i <= 10; i++) {
            visual += i <= numRating ? '▰' : '▱';
        }
    }

    return visual;
}

// ============================================
// Rating Title Formatter
// ============================================

async function formatRatingTitle(pattern, ratingStyle, rating, title, type, season = null, episode = null, year = null, userConfig = null, imdbId = null) {
    const ratingVisual = generateRatingVisual(ratingStyle, rating);

    // Default selected stats if not specified
    const selectedStats = userConfig?.selectedStats || ['watchers', 'plays', 'comments'];
    const statsFormat = userConfig?.statsFormat || 1;

    // Get stats line based on user's selected stats and format
    let statsLine = '';

    if (userConfig && userConfig.clientId && imdbId) {
        const stats = await fetchTraktStats(imdbId, type, userConfig.clientId);
        if (stats) {
            // Get values for selected stats
            const statValues = selectedStats.map(stat => stats[stat] || 0);

            // Format numbers and prepare display
            const formattedStats = selectedStats.map((stat, index) => {
                const value = statValues[index];
                const formattedValue = formatNumber(value);
                const emoji = getStatEmoji(stat);
                const displayName = getStatDisplayName(stat, value);

                return {
                    emoji,
                    value: formattedValue,
                    name: displayName,
                    rawValue: value
                };
            });

            // Apply selected stats format
            switch(statsFormat) {
                case 1: // Option 1: Compact Stats
                    statsLine = formattedStats.map(s => `${s.emoji} ${s.value} ${s.name}`).join(' - ');
                    break;
                case 2: // Option 2: Detailed Stats
                    statsLine = formattedStats.map(s => `${s.emoji} ${s.name}: ${s.value}`).join(' | ');
                    break;
                case 3: // Option 3: Minimal Stats
                    statsLine = formattedStats.map(s => `${s.emoji} ${s.value}`).join(' | ');
                    break;
                case 4: // Option 4: Vertical Stats (3 lines)
                    if (pattern === 6) {
                        statsLine = formattedStats.map(s => `${s.emoji} ${s.value} ${s.name}`).join('\n');
                    } else {
                        statsLine = formattedStats.map(s => `${s.emoji} ${s.value} ${s.name}`).join(' | ');
                    }
                    break;
                case 5: // Option 5: Balanced Stats
                    const customNames = {
                        'watchers': 'watching',
                        'plays': 'played',
                        'comments': 'commented',
                        'lists': 'listed',
                        'collectors': 'collected',
                        'votes': 'voted',
                        'rating': 'rated'
                    };
                    statsLine = formattedStats.map(s => {
                        const customName = customNames[s.name] || s.name;
                        return `${s.emoji} ${s.value} ${customName}`;
                    }).join(' | ');
                    break;
                default: // Fallback to Option 1
                    statsLine = formattedStats.map(s => `${s.emoji} ${s.value} ${s.name}`).join(' - ');
            }
        }
    }

    // If no stats available, use fallback with selected stats
    if (!statsLine) {
        const exampleValues = {
            'watchers': '3.1k',
            'plays': '5.8k',
            'comments': '6',
            'lists': '25',
            'collectors': '45',
            'votes': '180',
            'rating': '8.5'
        };

        const fallbackStats = selectedStats.map(stat => {
            const emoji = getStatEmoji(stat);
            const value = exampleValues[stat] || '0';
            const name = getStatDisplayName(stat, 2); // Use plural for fallback

            return { emoji, value, name };
        });

        switch(statsFormat) {
            case 1:
                statsLine = fallbackStats.map(s => `${s.emoji} ${s.value} ${s.name}`).join(' - ');
                break;
            case 2:
                statsLine = fallbackStats.map(s => `${s.emoji} ${s.name}: ${s.value}`).join(' | ');
                break;
            case 3:
                statsLine = fallbackStats.map(s => `${s.emoji} ${s.value}`).join(' | ');
                break;
            case 4:
                statsLine = fallbackStats.map(s => `${s.emoji} ${s.value} ${s.name}`).join('\n');
                break;
            case 5:
                statsLine = fallbackStats.map(s => `${s.emoji} ${s.value} ${s.name}`).join(' | ');
                break;
            default:
                statsLine = fallbackStats.map(s => `${s.emoji} ${s.value} ${s.name}`).join(' - ');
        }
    }

    // Special case for Pattern 0 - no stats line needed
    if (pattern === 0) {
        if (type === 'movie') {
            return `${ratingVisual}\n"${title}" ${rating}/10`;
        } else if (season && episode) {
            return `${ratingVisual}\nS${season}E${episode} "${title}" ${rating}/10`;
        } else {
            return `${ratingVisual}\n"${title}" Series ${rating}/10`;
        }
    }

    // Pattern 1: Emoji-First Vertical
    if (pattern === 1) {
        let displayTitle1 = title;
        if (type === 'series') {
            if (season && episode) {
                displayTitle1 = `${title} S${season}E${episode}`;
            } else {
                displayTitle1 = `${title} Series`;
            }
        } else {
            displayTitle1 = `${title}${year ? ` (${year})` : ' (Movie)'}`;
        }

        return `⭐ Rating: ${rating}/10\n🎬 ${displayTitle1}\n${ratingVisual}\n${statsLine}\n📊 ${rating} out of 10 stars`;
    }

    // Pattern 6: Cinematic Rating Card
    if (pattern === 6) {
        if (type === 'movie') {
            const movieTitle = year ? `🎬 ${title} (${year})` : `🎬 ${title}`;
            return `${movieTitle}\n⭐ ${ratingVisual}\n🎯 Rating ${rating}/10\n${statsLine}\n📊 ${rating} out of 10 stars`;
        } else if (type === 'series') {
            const mediaEmoji = getMediaEmoji(type, title);
            if (season && episode) {
                // Get episode type indicator
                let episodeIndicator = '';
                if (episode === 1) episodeIndicator = ' 🚀';
                if (episode >= 10) episodeIndicator = ' 🔚';

                return `${mediaEmoji} ${title} S${season}E${episode}${episodeIndicator}\n⭐ ${ratingVisual}\n🎯 Rating ${rating}/10\n${statsLine}\n📊 ${rating} out of 10 stars`;
            } else if (season) {
                return `${mediaEmoji} ${title} Season ${season}\n⭐ ${ratingVisual}\n🎯 Rating ${rating}/10\n${statsLine}\n📊 ${rating} out of 10 stars`;
            } else {
                return `${mediaEmoji} ${title} (Series)\n⭐ ${ratingVisual}\n🎯 Rating ${rating}/10\n${statsLine}\n📊 ${rating} out of 10 stars`;
            }
        }
    }

    // Fallback to original pattern
    if (type === 'movie') {
        return `${ratingVisual}\n"${title}" ${rating}/10`;
    } else if (season && episode) {
        return `${ratingVisual}\nS${season}E${episode} "${title}" ${rating}/10`;
    } else {
        return `${ratingVisual}\n"${title}" Series ${rating}/10`;
    }
}

// ============================================
// OAuth Routes with Upstash Support
// ============================================

app.get('/oauth/initiate', (req, res) => {
  const { clientId } = req.query;

  if (!clientId) {
    return res.status(400).send('Missing clientId');
  }

  const state = Math.random().toString(36).substring(7);
  oauthStates.set(state, {
    clientId,
    timestamp: Date.now()
  });

  const traktAuthUrl = `https://trakt.tv/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=urn:ietf:wg:oauth:2.0:oob&state=${state}`;
  res.redirect(traktAuthUrl);
});

// Updated OAuth exchange with Upstash support
app.post('/oauth/exchange', async (req, res) => {
  const { code, clientId, upstashUrl, upstashToken } = req.body;

  try {
    const response = await fetch('https://api.trakt.tv/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: clientId,
        client_secret: '',
        redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
        grant_type: 'authorization_code'
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Trakt API error: ${response.status} - ${errorText}`);
    }

    const tokens = await response.json();

    // Get user info
    const userResponse = await fetch('https://api.trakt.tv/users/settings', {
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`,
        'trakt-api-version': '2',
        'trakt-api-key': clientId
      }
    });

    let username = 'Trakt User';
    if (userResponse.ok) {
      const userData = await userResponse.json();
      username = userData.user?.username || username;
    }

    tokens.username = username;
    tokens.expires_at = Date.now() + (tokens.expires_in * 1000);

    let configId = null;
    let upstashSuccess = false;

    // If Upstash credentials are provided, store tokens in Upstash
    if (upstashUrl && upstashToken) {
      try {
        configId = generateConfigId();
        const tokensKey = `trakt_tokens:${configId}`;

        // Store tokens in Upstash with 90-day expiration
        await upstashSet(upstashUrl, upstashToken, tokensKey, JSON.stringify(tokens), 90 * 24 * 60 * 60);
        upstashSuccess = true;

        // Also cache tokens locally as fallback
        upstashTokenCache.set(configId, {
          tokens: tokens,
          timestamp: Date.now()
        });

      } catch (redisError) {
        console.error('Upstash storage failed:', redisError.message);
        // Continue with URL storage as fallback
      }
    }

    if (upstashSuccess) {
      // Return config ID for Upstash storage AND tokens for fallback
      res.json({
        success: true,
        configId,
        tokens: tokens, // Include tokens for fallback in config
        username: username,
        storage: 'upstash'
      });
    } else {
      // Return tokens for URL storage (fallback)
      res.json({
        success: true,
        tokens: tokens,
        username: username,
        storage: 'url'
      });
    }

  } catch (error) {
    console.error('OAuth exchange error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Token refresh endpoint
app.post('/oauth/refresh', async (req, res) => {
  try {
    const { refreshToken, clientId, upstashUrl, upstashToken, configId } = req.body;

    if (!refreshToken || !clientId) {
      return res.status(400).json({ error: 'Refresh token and Client ID are required' });
    }

    // Refresh tokens
    const response = await fetch('https://api.trakt.tv/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: '',
        redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
        grant_type: 'refresh_token'
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Trakt API error: ${response.status} - ${errorText}`);
    }

    const tokens = await response.json();
    tokens.expires_at = Date.now() + (tokens.expires_in * 1000);

    // Get user info to verify
    const userResponse = await fetch('https://api.trakt.tv/users/settings', {
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`,
        'trakt-api-version': '2',
        'trakt-api-key': clientId
      }
    });

    if (userResponse.ok) {
      const userData = await userResponse.json();
      tokens.username = userData.user?.username || 'Trakt User';
    }

    // Update Upstash if credentials provided
    if (upstashUrl && upstashToken && configId) {
      try {
        const tokensKey = `trakt_tokens:${configId}`;
        await upstashSet(upstashUrl, upstashToken, tokensKey, JSON.stringify(tokens), 90 * 24 * 60 * 60);

        // Update local cache
        upstashTokenCache.set(configId, {
          tokens: tokens,
          timestamp: Date.now()
        });
      } catch (redisError) {
        console.error('Redis update failed:', redisError.message);
      }
    }

    res.json({
      success: true,
      tokens,
      username: tokens.username
    });

  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get tokens from Upstash - KEPT FOR CONFIGURATION PAGE
app.post('/oauth/tokens', async (req, res) => {
  try {
    const { upstashUrl, upstashToken, configId } = req.body;

    if (!upstashUrl || !upstashToken || !configId) {
      return res.status(400).json({
        success: false,
        error: 'Upstash URL, Token, and Config ID are required'
      });
    }

    // First check local cache
    const cached = upstashTokenCache.get(configId);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < UPSTASH_CACHE_TTL) {
      console.log(`[UPSTASH] Using cached tokens for ${configId}`);
      return res.json({
        success: true,
        tokens: cached.tokens,
        source: 'cache'
      });
    }

    try {
      const tokensKey = `trakt_tokens:${configId}`;
      console.log(`[UPSTASH] Fetching from Upstash: ${upstashUrl}/get/${tokensKey}`);

      const tokensJson = await upstashGet(upstashUrl, upstashToken, tokensKey);

      if (!tokensJson) {
        return res.status(404).json({
          success: false,
          error: 'Tokens not found in Upstash'
        });
      }

      const tokens = JSON.parse(tokensJson);

      // Cache the tokens locally
      upstashTokenCache.set(configId, {
        tokens: tokens,
        timestamp: Date.now()
      });

      res.json({
        success: true,
        tokens,
        source: 'upstash'
      });

    } catch (upstashError) {
      console.error('Upstash get failed:', upstashError.message);

      // If Upstash fails, try the local cache even if expired
      if (cached) {
        console.log(`[UPSTASH] Using expired cache for ${configId} as fallback`);
        return res.json({
          success: true,
          tokens: cached.tokens,
          source: 'cache_fallback'
        });
      } else {
        return res.status(500).json({
          success: false,
          error: 'Failed to retrieve tokens from Upstash'
        });
      }
    }

  } catch (error) {
    console.error('Get tokens error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve tokens'
    });
  }
});

// Test Upstash connection endpoint
app.post('/upstash/test', async (req, res) => {
  try {
    const { upstashUrl, upstashToken } = req.body;

    if (!upstashUrl || !upstashToken) {
      return res.status(400).json({ error: 'Upstash URL and Token are required' });
    }

    const success = await testUpstashConnection(upstashUrl, upstashToken);

    if (success) {
      res.json({
        success: true,
        message: 'Upstash connection successful'
      });
    } else {
      res.json({
        success: false,
        message: 'Upstash test failed'
      });
    }

  } catch (error) {
    console.error('Upstash test error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to connect to Upstash. Check your URL and Token.'
    });
  }
});

// ============================================
// Token Refresh Helper
// ============================================

async function refreshTraktTokens(userConfig) {
  try {
    const { refresh_token, clientId, upstashUrl, upstashToken, configId } = userConfig;

    if (!refresh_token || !clientId) {
      console.log('[TOKEN REFRESH] Missing refresh token or clientId');
      return null;
    }

    console.log(`[TOKEN REFRESH] Refreshing tokens for configId: ${configId}`);

    // Add timeout and better error handling for Vercel
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout

    try {
      const response = await fetch('https://api.trakt.tv/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refresh_token: refresh_token,
          client_id: clientId,
          client_secret: '',
          redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
          grant_type: 'refresh_token'
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Token refresh failed: ${response.status} - ${errorText}`);
      }

      const newTokens = await response.json();
      newTokens.expires_at = Date.now() + (newTokens.expires_in * 1000);

      // Skip Upstash update on Vercel if network is problematic
      const isVercel = process.env.VERCEL || process.env.VERCEL_URL;
      
      if (!isVercel && upstashUrl && upstashToken && configId) {
        try {
          const tokensKey = `trakt_tokens:${configId}`;
          await upstashSet(upstashUrl, upstashToken, tokensKey, JSON.stringify(newTokens), 90 * 24 * 60 * 60);
          upstashTokenCache.set(configId, {
            tokens: newTokens,
            timestamp: Date.now()
          });
          console.log(`[TOKEN REFRESH] Updated tokens in Upstash for ${configId}`);
        } catch (upstashError) {
          console.error(`[TOKEN REFRESH] Failed to update Upstash: ${upstashError.message}`);
        }
      }

      return newTokens;

    } catch (fetchError) {
      if (fetchError.name === 'AbortError') {
        console.error('[TOKEN REFRESH] Request timeout');
        throw new Error('Token refresh timeout - please try again');
      }
      throw fetchError;
    }

  } catch (error) {
    console.error(`[TOKEN REFRESH] Error: ${error.message}`);
    // Don't throw the error, just return null so we can continue with existing token
    return null;
  }
}

// ============================================
// Helper: Get user config with tokens - WITH AUTO-REFRESH
// ============================================

async function getUserConfigWithTokens(config) {
  try {
    const userConfig = decodeConfig(config);
    if (!userConfig) {
      console.log('[CONFIG] Failed to decode config');
      return null;
    }

    console.log(`[CONFIG] Storage method: ${userConfig.storage || 'url'}`);

    // If using URL storage or no storage specified
    if (!userConfig.storage || userConfig.storage === 'url') {
      if (userConfig.access_token) {
        console.log(`[CONFIG] Using URL storage token`);

        // Check if token needs refresh (expiring in less than 7 days)
        const now = Date.now();
        if (!isVercel && userConfig.expires_at && (userConfig.expires_at - now) < 0) {
          console.log(`[CONFIG] URL storage token expiring soon, attempting refresh...`);
          try {
            const refreshedTokens = await refreshTraktTokens(userConfig);
            if (refreshedTokens) {
              Object.assign(userConfig, refreshedTokens);
              console.log(`[CONFIG] URL token refreshed successfully`);
            }
          } catch (refreshError) {
            console.log(`[CONFIG] URL token refresh failed: ${refreshError.message}`);
            // Continue with existing token
          }
        }

        return userConfig;
      } else {
        console.log(`[CONFIG] URL storage: No access token`);
        return null;
      }
    }

    // If using Upstash storage
    if (userConfig.storage === 'upstash') {
      if (!userConfig.upstashUrl || !userConfig.upstashToken || !userConfig.configId) {
        console.log(`[CONFIG] Upstash storage: Missing Upstash credentials`);
        return null;
      }

      console.log(`[CONFIG] Fetching tokens from Upstash for configId: ${userConfig.configId}`);

      try {
        // Check local cache first
        const cached = upstashTokenCache.get(userConfig.configId);
        const now = Date.now();

        if (cached && (now - cached.timestamp) < UPSTASH_CACHE_TTL) {
          console.log(`[CONFIG] Using cached tokens for ${userConfig.configId}`);
          // Merge tokens into userConfig
          Object.assign(userConfig, cached.tokens);

          // Check if token needs refresh (expiring in less than 7 days)
          if (userConfig.expires_at && (userConfig.expires_at - now) < (7 * 24 * 60 * 60 * 1000)) {
            console.log(`[CONFIG] Upstash token expiring soon, refreshing...`);
            try {
              const refreshedTokens = await refreshTraktTokens(userConfig);
              if (refreshedTokens) {
                Object.assign(userConfig, refreshedTokens);
                console.log(`[CONFIG] Upstash token refreshed successfully`);
              }
            } catch (refreshError) {
              console.log(`[CONFIG] Upstash token refresh failed: ${refreshError.message}`);
              // Continue with existing token
            }
          }

          return userConfig;
        }

        // DIRECT Upstash call (no HTTP to ourselves)
        const tokensKey = `trakt_tokens:${userConfig.configId}`;
        console.log(`[CONFIG] Direct Upstash call: ${userConfig.upstashUrl}/get/${tokensKey}`);

        const tokensJson = await upstashGet(userConfig.upstashUrl, userConfig.upstashToken, tokensKey);

        if (!tokensJson) {
          console.log(`[CONFIG] Tokens not found in Upstash`);
          // Fallback to tokens in config if available
          if (userConfig.access_token) {
            console.log(`[CONFIG] Falling back to config tokens`);
            return userConfig;
          }
          return null;
        }

        const tokens = JSON.parse(tokensJson);
        console.log(`[CONFIG] Successfully retrieved tokens from Upstash`);

        // Cache the tokens locally
        upstashTokenCache.set(userConfig.configId, {
          tokens: tokens,
          timestamp: Date.now()
        });

        // Merge tokens into userConfig
        Object.assign(userConfig, tokens);

        // Check if token needs refresh (expiring in less than 7 days)
        if (userConfig.expires_at && (userConfig.expires_at - now) < (7 * 24 * 60 * 60 * 1000)) {
          console.log(`[CONFIG] Upstash token expiring soon, refreshing...`);
          try {
            const refreshedTokens = await refreshTraktTokens(userConfig);
            if (refreshedTokens) {
              Object.assign(userConfig, refreshedTokens);
              console.log(`[CONFIG] Upstash token refreshed successfully`);
            }
          } catch (refreshError) {
            console.log(`[CONFIG] Upstash token refresh failed: ${refreshError.message}`);
            // Continue with existing token
          }
        }

        return userConfig;

      } catch (upstashError) {
        console.error(`[CONFIG] Error fetching from Upstash: ${upstashError.message}`);

        // Try the local cache even if expired
        const cached = upstashTokenCache.get(userConfig.configId);
        if (cached) {
          console.log(`[CONFIG] Using expired cache for ${userConfig.configId} as fallback`);
          Object.assign(userConfig, cached.tokens);

          // Still try to refresh if expiring
          const now = Date.now();
          if (userConfig.expires_at && (userConfig.expires_at - now) < (7 * 24 * 60 * 60 * 1000)) {
            console.log(`[CONFIG] Expired Upstash token, attempting refresh...`);
            try {
              const refreshedTokens = await refreshTraktTokens(userConfig);
              if (refreshedTokens) {
                Object.assign(userConfig, refreshedTokens);
                console.log(`[CONFIG] Expired Upstash token refreshed successfully`);
              }
            } catch (refreshError) {
              console.log(`[CONFIG] Expired Upstash token refresh failed: ${refreshError.message}`);
            }
          }

          return userConfig;
        }

        // Fallback to tokens in config if available
        if (userConfig.access_token) {
          console.log(`[CONFIG] Falling back to config tokens after Upstash error`);
          return userConfig;
        }

        console.log(`[CONFIG] No tokens available from any source`);
        return null;
      }
    }

    return null;

  } catch (error) {
    console.error(`[CONFIG] Error in getUserConfigWithTokens: ${error.message}`);
    return null;
  }
}

// ============================================
// Delete Older Watched States Function
// ============================================

async function deleteOlderWatchedStates(imdbId, type, accessToken, clientId, title, season = null, episode = null) {
  try {
    console.log(`[TRAKT CLEANUP] Checking for duplicates: ${imdbId} ${type}`);

    let deletedCount = 0;

    if (type === 'movie') {
      // For movies, we'll use a simpler approach due to API limitations
      // We'll remove all existing history for this movie and re-add it fresh
      // This ensures only one entry exists

      console.log(`[TRAKT CLEANUP] Removing all history for movie: ${title}`);

      // First, remove from history
      const removeResponse = await fetch('https://api.trakt.tv/sync/history/remove', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'trakt-api-version': '2',
          'trakt-api-key': clientId
        },
        body: JSON.stringify({
          movies: [{ ids: { imdb: imdbId } }]
        })
      });

      if (removeResponse.ok) {
        console.log(`[TRAKT CLEANUP] Removed existing history for movie`);
        deletedCount = 1; // We assume at least one was removed
      }

    } else if (type === 'series' && season && episode) {
      // For episodes, use the same approach
      console.log(`[TRAKT CLEANUP] Removing all history for episode: ${title} S${season}E${episode}`);

      const removeResponse = await fetch('https://api.trakt.tv/sync/history/remove', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'trakt-api-version': '2',
          'trakt-api-key': clientId
        },
        body: JSON.stringify({
          shows: [{
            ids: { imdb: imdbId },
            seasons: [{
              number: parseInt(season),
              episodes: [{
                number: parseInt(episode)
              }]
            }]
          }]
        })
      });

      if (removeResponse.ok) {
        console.log(`[TRAKT CLEANUP] Removed existing history for episode`);
        deletedCount = 1;
      }
    }

    return deletedCount;

  } catch (error) {
    console.error(`[TRAKT CLEANUP] Error: ${error.message}`);
    return 0; // Fail silently
  }
}


// ============================================
// Trakt API Function (UPDATED with Watchlist, Cleanup, and Rating Cleanup)
// ============================================

async function makeTraktRequest(action, type, imdbId, title, userConfig, rating = null, season = null, episode = null) {
  try {
    console.log(`[TRAKT] Making ${action} request for ${type}: ${imdbId} - "${title}"`);
    console.log(`[TRAKT] Season: ${season}, Episode: ${episode}, Rating: ${rating}`);

    const accessToken = userConfig.access_token;
    const clientId = userConfig.clientId;

    let message = '';
    let response;
    let cleanupDone = false;

    switch (action) {
      case 'mark_watched':
        // Check if cleanup is enabled
        const keepSingleState = userConfig.keepSingleWatchedState || false;

        if (keepSingleState) {
          console.log(`[TRAKT] Keep single state enabled, cleaning up duplicates first`);

          // First, clean up any existing watched states
          try {
            const deletedCount = await deleteOlderWatchedStates(imdbId, type, accessToken, clientId, title, season, episode);
            if (deletedCount > 0) {
              console.log(`[TRAKT] Cleaned ${deletedCount} duplicate watched states`);
              cleanupDone = true;
            }
          } catch (cleanupError) {
            console.log(`[TRAKT] Cleanup failed, continuing with normal watch: ${cleanupError.message}`);
            // Continue with normal marking
          }

          // Small delay to ensure cleanup completes
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        if (type === 'movie') {
          response = await fetch('https://api.trakt.tv/sync/history', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`,
              'trakt-api-version': '2',
              'trakt-api-key': clientId
            },
            body: JSON.stringify({
              movies: [{ ids: { imdb: imdbId } }]
            })
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Trakt API error: ${response.status} - ${errorText}`);
          }

          message = `Marked "${title}" as watched`;
          if (cleanupDone) {
            message += ` (cleaned duplicates)`;
          }
        } else if (type === 'series') {
          response = await fetch('https://api.trakt.tv/sync/history', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`,
              'trakt-api-version': '2',
              'trakt-api-key': clientId
            },
            body: JSON.stringify({
              shows: [{
                ids: { imdb: imdbId },
                seasons: [{
                  number: parseInt(season),
                  episodes: [{
                    number: parseInt(episode)
                  }]
                }]
              }]
            })
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Trakt API error: ${response.status} - ${errorText}`);
          }

          message = `Marked S${season}E${episode} of "${title}" as watched`;
          if (cleanupDone) {
            message += ` (cleaned duplicates)`;
          }
        }
        break;

      case 'mark_unwatched':
        if (type === 'movie') {
          response = await fetch('https://api.trakt.tv/sync/history/remove', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`,
              'trakt-api-version': '2',
              'trakt-api-key': clientId
            },
            body: JSON.stringify({
              movies: [{ ids: { imdb: imdbId } }]
            })
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Trakt API error: ${response.status} - ${errorText}`);
          }

          message = `Marked "${title}" as unwatched`;
        } else if (type === 'series' && season && episode) {
          response = await fetch('https://api.trakt.tv/sync/history/remove', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`,
              'trakt-api-version': '2',
              'trakt-api-key': clientId
            },
            body: JSON.stringify({
              shows: [{
                ids: { imdb: imdbId },
                seasons: [{
                  number: parseInt(season),
                  episodes: [{
                    number: parseInt(episode)
                  }]
                }]
              }]
            })
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Trakt API error: ${response.status} - ${errorText}`);
          }

          message = `Marked S${season}E${episode} of "${title}" as unwatched`;
        }
        break;

      case 'mark_season_watched':
        response = await fetch('https://api.trakt.tv/sync/history', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
            'trakt-api-version': '2',
            'trakt-api-key': clientId
          },
          body: JSON.stringify({
            shows: [{
              ids: { imdb: imdbId },
              seasons: [{
                number: parseInt(season)
              }]
            }]
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Trakt API error: ${response.status} - ${errorText}`);
        }

        message = `Marked Season ${season} of "${title}" as watched`;
        break;

      case 'mark_series_watched':
        response = await fetch('https://api.trakt.tv/sync/history', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
            'trakt-api-version': '2',
            'trakt-api-key': clientId
          },
          body: JSON.stringify({
            shows: [{ ids: { imdb: imdbId } }]
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Trakt API error: ${response.status} - ${errorText}`);
        }

        message = `Marked entire "${title}" series as watched`;
        break;

      case 'rate_only':
        // Check if cleanup is enabled for when markAsPlayedOnRate is true
        const keepSingleStateForRating = userConfig.keepSingleWatchedState || false;
        const markAsPlayedOnRate = userConfig.markAsPlayedOnRate || false;

        if (type === 'movie') {
          // If markAsPlayedOnRate AND keepSingleState are both enabled, clean up first
          if (markAsPlayedOnRate && keepSingleStateForRating) {
            console.log(`[TRAKT] Rating with markAsPlayedOnRate and keep single state enabled`);

            try {
              // Clean up any existing watched states before rating
              const deletedCount = await deleteOlderWatchedStates(imdbId, type, accessToken, clientId, title, season, episode);
              if (deletedCount > 0) {
                console.log(`[TRAKT] Cleaned ${deletedCount} duplicate watched states before rating`);
                cleanupDone = true;
              }

              // Small delay
              await new Promise(resolve => setTimeout(resolve, 500));

              // Now mark as watched
              const watchResponse = await fetch('https://api.trakt.tv/sync/history', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${accessToken}`,
                  'trakt-api-version': '2',
                  'trakt-api-key': clientId
                },
                body: JSON.stringify({
                  movies: [{ ids: { imdb: imdbId } }]
                })
              });

              if (!watchResponse.ok) {
                console.log(`[TRAKT] Failed to mark as watched before rating: ${watchResponse.status}`);
              } else {
                console.log(`[TRAKT] Marked as watched before rating`);
              }

            } catch (cleanupError) {
              console.log(`[TRAKT] Cleanup before rating failed: ${cleanupError.message}`);
            }
          }

          // Now do the rating
          response = await fetch('https://api.trakt.tv/sync/ratings', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`,
              'trakt-api-version': '2',
              'trakt-api-key': clientId
            },
            body: JSON.stringify({
              movies: [{
                ids: { imdb: imdbId },
                rating: parseInt(rating)
              }]
            })
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Trakt API error: ${response.status} - ${errorText}`);
          }

          message = `Rated "${title}" ${rating}/10`;
          if (markAsPlayedOnRate) {
            message += ` (marked as watched)`;
            if (cleanupDone) {
              message += ` and cleaned duplicates`;
            }
          }
        } else if (type === 'series') {
          if (season && episode) {
            // If markAsPlayedOnRate AND keepSingleState are both enabled, clean up first
            if (markAsPlayedOnRate && keepSingleStateForRating) {
              console.log(`[TRAKT] Rating episode with markAsPlayedOnRate and keep single state enabled`);

              try {
                // Clean up any existing watched states before rating
                const deletedCount = await deleteOlderWatchedStates(imdbId, type, accessToken, clientId, title, season, episode);
                if (deletedCount > 0) {
                  console.log(`[TRAKT] Cleaned ${deletedCount} duplicate watched states before rating`);
                  cleanupDone = true;
                }

                // Small delay
                await new Promise(resolve => setTimeout(resolve, 500));

                // Now mark as watched
                const watchResponse = await fetch('https://api.trakt.tv/sync/history', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`,
                    'trakt-api-version': '2',
                    'trakt-api-key': clientId
                  },
                  body: JSON.stringify({
                    shows: [{
                      ids: { imdb: imdbId },
                      seasons: [{
                        number: parseInt(season),
                        episodes: [{
                          number: parseInt(episode)
                        }]
                      }]
                    }]
                  })
                });

                if (!watchResponse.ok) {
                  console.log(`[TRAKT] Failed to mark as watched before rating: ${watchResponse.status}`);
                } else {
                  console.log(`[TRAKT] Marked as watched before rating`);
                }

              } catch (cleanupError) {
                console.log(`[TRAKT] Cleanup before rating failed: ${cleanupError.message}`);
              }
            }

            response = await fetch('https://api.trakt.tv/sync/ratings', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
                'trakt-api-version': '2',
                'trakt-api-key': clientId
              },
              body: JSON.stringify({
                shows: [{
                  ids: { imdb: imdbId },
                  seasons: [{
                    number: parseInt(season),
                    episodes: [{
                      number: parseInt(episode),
                      rating: parseInt(rating)
                    }]
                  }]
                }]
              })
            });

            if (!response.ok) {
              const errorText = await response.text();
              throw new Error(`Trakt API error: ${response.status} - ${errorText}`);
            }

            message = `Rated S${season}E${episode} of "${title}" ${rating}/10`;
            if (markAsPlayedOnRate) {
              message += ` (marked as watched)`;
              if (cleanupDone) {
                message += ` and cleaned duplicates`;
              }
            }
          } else {
            // For series rating (no specific episode)
            response = await fetch('https://api.trakt.tv/sync/ratings', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
                'trakt-api-version': '2',
                'trakt-api-key': clientId
              },
              body: JSON.stringify({
                shows: [{
                  ids: { imdb: imdbId },
                  rating: parseInt(rating)
                }]
              })
            });

            if (!response.ok) {
              const errorText = await response.text();
              throw new Error(`Trakt API error: ${response.status} - ${errorText}`);
            }

            message = `Rated series "${title}" ${rating}/10`;
            if (markAsPlayedOnRate) {
              message += ` (marked as watched)`;
            }
          }
        }
        break;

      // Watchlist actions (remain the same)
      case 'add_to_watchlist':
        if (type === 'movie') {
          response = await fetch('https://api.trakt.tv/sync/watchlist', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`,
              'trakt-api-version': '2',
              'trakt-api-key': clientId
            },
            body: JSON.stringify({
              movies: [{ ids: { imdb: imdbId } }]
            })
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Trakt API error: ${response.status} - ${errorText}`);
          }

          message = `Added "${title}" to watchlist`;
        } else if (type === 'series') {
          response = await fetch('https://api.trakt.tv/sync/watchlist', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`,
              'trakt-api-version': '2',
              'trakt-api-key': clientId
            },
            body: JSON.stringify({
              shows: [{ ids: { imdb: imdbId } }]
            })
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Trakt API error: ${response.status} - ${errorText}`);
          }

          message = `Added "${title}" series to watchlist`;
        }
        break;

      case 'remove_from_watchlist':
        if (type === 'movie') {
          response = await fetch('https://api.trakt.tv/sync/watchlist/remove', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`,
              'trakt-api-version': '2',
              'trakt-api-key': clientId
            },
            body: JSON.stringify({
              movies: [{ ids: { imdb: imdbId } }]
            })
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Trakt API error: ${response.status} - ${errorText}`);
          }

          message = `Removed "${title}" from watchlist`;
        } else if (type === 'series') {
          response = await fetch('https://api.trakt.tv/sync/watchlist/remove', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`,
              'trakt-api-version': '2',
              'trakt-api-key': clientId
            },
            body: JSON.stringify({
              shows: [{ ids: { imdb: imdbId } }]
            })
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Trakt API error: ${response.status} - ${errorText}`);
          }

          message = `Removed "${title}" series from watchlist`;
        }
        break;
    }

    console.log(`[TRAKT] ✅ SUCCESS: ${message}`);

    let responseData = {};
    try {
      responseData = await response.json();
      console.log(`[TRAKT] Response data:`, JSON.stringify(responseData, null, 2));
    } catch (e) {
      console.log(`[TRAKT] No JSON response body`);
    }

    return {
      success: true,
      message,
      response: responseData
    };

  } catch (error) {
    console.error(`[TRAKT] ❌ ERROR: ${error.message}`);
    return {
      success: false,
      error: error.message,
      details: error.stack
    };
  }
}

// ============================================
// Stream Object Creator (UPDATED with Keep Single State Display Option)
// ============================================

async function createStreamObject(title, action, type, imdbId, rating = null, season = null, episode = null, config = '', year = null, userConfig = null) {
  let streamTitle;
  let streamName = "Trakt";

  // Decode config to get user preferences
  let decodedConfig = userConfig;
  let ratingPattern = 0;
  let ratingStyle = 'stars';
  let statsFormat = 1;
  let selectedStats = ['watchers', 'plays', 'comments'];
  let keepSingleStateDisplay = 'inline'; // Control display of keep single state text
  let keepSingleStateEmoji = '🔄'; // Default emoji for keep single state

  if (!decodedConfig) {
    try {
      decodedConfig = decodeConfig(config);
    } catch (e) {
      console.log('[STREAM] Could not decode config, using defaults');
    }
  }

  if (decodedConfig) {
    ratingPattern = decodedConfig.ratingPattern || 0;
    ratingStyle = decodedConfig.ratingStyle || 'stars';
    statsFormat = decodedConfig.statsFormat || 1;
    selectedStats = decodedConfig.selectedStats || ['watchers', 'plays', 'comments'];
    keepSingleStateDisplay = decodedConfig.keepSingleStateDisplay || 'inline';
    keepSingleStateEmoji = decodedConfig.keepSingleStateEmoji || '🔄'; // Get emoji from config
  }

  const mediaEmoji = getMediaEmoji(type, title);
  const yearText = year ? `(${year})` : type === 'movie' ? '(Movie)' : '(Series)';
  const mediaType = type === 'movie' ? 'movie' : 'series';
  const keepSingleState = decodedConfig?.keepSingleWatchedState || false;

  if (action === 'mark_watched') {
    if (type === 'movie') {
      if (keepSingleState) {
        if (keepSingleStateDisplay === 'none') {
          streamTitle = `✅ Mark "${title}" as Watched`;
        } else if (keepSingleStateDisplay === 'newline') {
          streamTitle = `✅ Mark "${title}" as Watched\n${keepSingleStateEmoji} Keeps only latest watched state`;
        } else { // inline (default)
          streamTitle = `✅ Mark "${title}" as Watched ${keepSingleStateEmoji} Keeps only latest watched state`;
        }
      } else {
        streamTitle = `✅ Mark "${title}" as Watched`;
      }
    } else if (season && episode) {
      if (keepSingleState) {
        if (keepSingleStateDisplay === 'none') {
          streamTitle = `✅ Mark S${season}E${episode} as Watched`;
        } else if (keepSingleStateDisplay === 'newline') {
          streamTitle = `✅ Mark S${season}E${episode} as Watched\n${keepSingleStateEmoji} Keeps only latest watched state`;
        } else { // inline (default)
          streamTitle = `✅ Mark S${season}E${episode} as Watched ${keepSingleStateEmoji} Keeps only latest watched state`;
        }
      } else {
        streamTitle = `✅ Mark S${season}E${episode} as Watched`;
      }
    }
    streamName = "Trakt Marks";
  } else if (action === 'mark_unwatched') {
    if (type === 'movie') {
      streamTitle = `❌ Mark "${title}" as Unwatched`;
    } else if (season && episode) {
      streamTitle = `❌ Mark S${season}E${episode} as Unwatched`;
    }
    streamName = "Trakt Marks";
  } else if (action === 'mark_season_watched') {
    if (keepSingleState) {
      if (keepSingleStateDisplay === 'none') {
        streamTitle = `📅 Mark Season ${season} of "${title}" as Watched`;
      } else if (keepSingleStateDisplay === 'newline') {
        streamTitle = `📅 Mark Season ${season} of "${title}" as Watched\n${keepSingleStateEmoji} Keeps only latest watched state`;
      } else { // inline (default)
        streamTitle = `📅 Mark Season ${season} of "${title}" as Watched ${keepSingleStateEmoji} Keeps only latest watched state`;
      }
    } else {
      streamTitle = `📅 Mark Season ${season} of "${title}" as Watched`;
    }
    streamName = "Trakt Marks";
  } else if (action === 'mark_series_watched') {
    if (keepSingleState) {
      if (keepSingleStateDisplay === 'none') {
        streamTitle = `📺 Mark Entire "${title}" Series as Watched`;
      } else if (keepSingleStateDisplay === 'newline') {
        streamTitle = `📺 Mark Entire "${title}" Series as Watched\n${keepSingleStateEmoji} Keeps only latest watched state`;
      } else { // inline (default)
        streamTitle = `📺 Mark Entire "${title}" Series as Watched ${keepSingleStateEmoji} Keeps only latest watched state`;
      }
    } else {
      streamTitle = `📺 Mark Entire "${title}" Series as Watched`;
    }
    streamName = "Trakt Marks";
  } else if (action === 'rate_only') {
    streamTitle = await formatRatingTitle(ratingPattern, ratingStyle, rating, title, type, season, episode, year, decodedConfig, imdbId);
    streamName = "Trakt Rating";
  } else if (action === 'add_to_watchlist') {
    streamTitle = `📥 Add to Watchlist\n${mediaEmoji} "${title}" ${yearText}\n✅ Add ${mediaType} to your Trakt watchlist`;
    streamName = "Trakt Watchlist";
  } else if (action === 'remove_from_watchlist') {
    streamTitle = `📤 Remove from Watchlist\n${mediaEmoji} "${title}" ${yearText}\n🗑️ Remove ${mediaType} from your Trakt watchlist`;
    streamName = "Trakt Watchlist";
  }

  const params = new URLSearchParams({
    config: config || '',
    action: action,
    type: type,
    imdbId: imdbId,
    title: encodeURIComponent(title),
    rating: rating || '',
    season: season || '',
    episode: episode || ''
  });

  const finalVideoUrl = `${SERVER_URL}/configured/${config}/trakt-action?${params.toString()}`;

  return {
    name: streamName,
    title: streamTitle,
    url: finalVideoUrl,
    behaviorHints: {
      notWebReady: false,
      bingeGroup: `trakt-${type}-${imdbId}-${action}`
    }
  };
}

// ============================================
// MANIFEST ROUTES
// ============================================

app.get("/manifest.json", (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  const manifest = {
    id: "org.stremio.trakt",
    version: "2.2.1",
    name: "Trakt Sync & Rate",
    description: "Sync watched states, rate content, and manage watchlist on Trakt.tv - configure your instance with Upstash Redis for persistent connection",
    resources: ["stream"],
    types: ["movie", "series"],
    catalogs: [],
    idPrefixes: ["tt"],
behaviorHints: {
  configurable: true,
  configurationRequired: true,
  configuration: {
    type: "link",
    link: `${SERVER_URL}/configure`
  }
},
    background: BACKGROUND_URL,
    logo: LOGO_URL,
    icon: ICON_URL,
    contactEmail: ""
  };

  console.log(`[MANIFEST] Default manifest requested (shows Configure button)`);
  res.json(manifest);
});

app.get("/configured/:config/manifest.json", (req, res) => {
  const { config } = req.params;

  res.setHeader('Content-Type', 'application/json');
  console.log(`[MANIFEST] Configured manifest requested for config: ${config}`);

  try {
    const userConfig = decodeConfig(config);
    let username = 'Trakt User';
    let showUsername = true;

    if (userConfig) {
      if (userConfig.username) {
        username = userConfig.username;
      }
      if (userConfig.showUsernameInName !== undefined) {
        showUsername = userConfig.showUsernameInName;
      }
    }

    let addonName = "Trakt Sync & Rate";
    if (showUsername && username) {
      addonName = `Trakt Sync & Rate (${username})`;
    }

    const manifest = {
      id: `org.stremio.trakt.${config}`,
      version: "2.2.1",
      name: addonName,
      description: `Sync watched states, rate content, and manage watchlist on Trakt.tv${username ? ` - ${username}'s instance` : ''} with Upstash Redis persistent storage`,
      resources: ["stream"],
      types: ["movie", "series"],
      catalogs: [],
      idPrefixes: ["tt"],
behaviorHints: {
  configurable: true,
  configurationRequired: false,
  configuration: {
    type: "link",
    link: `${SERVER_URL}/configured/${config}/configure`
  }
},
      background: BACKGROUND_URL,
      logo: LOGO_URL,
      icon: ICON_URL,
      contactEmail: ""
    };

    console.log(`[MANIFEST] ✅ Sending configured manifest. Show username: ${showUsername}, Name: "${addonName}"`);
    res.json(manifest);

  } catch (error) {
    console.error(`[MANIFEST] ❌ Error generating manifest: ${error.message}`);

    const fallbackManifest = {
      id: "org.stremio.trakt",
      version: "2.2.1",
      name: "Trakt Sync & Rate",
      description: "Sync watched states, rate content, and manage watchlist on Trakt.tv",
      resources: ["stream"],
      types: ["movie", "series"],
      catalogs: [],
      idPrefixes: ["tt"],
      behaviorHints: {
        configurable: true,
        configurationRequired: true
      },
      background: BACKGROUND_URL,
      logo: LOGO_URL,
      icon: ICON_URL
    };

    res.json(fallbackManifest);
  }
});

app.get("/:config/manifest.json", (req, res) => {
  const { config } = req.params;
  res.redirect(`/configured/${config}/manifest.json`);
});

// ============================================
// Stream Endpoint (UPDATED with Upstash support)
// ============================================

app.get("/configured/:config/stream/:type/:id.json", async (req, res) => {
  const { config, type, id } = req.params;

  res.setHeader('Content-Type', 'application/json');

  console.log(`[STREAM] Configured stream requested for ${type} ID: ${id}`);

  try {
    // Use the helper function to get config with tokens
    const userConfig = await getUserConfigWithTokens(config);

    if (!userConfig || !userConfig.access_token) {
      console.log(`[STREAM] Invalid config or missing access token`);
      return res.json({ streams: [] });
    }

    const parsedId = parseStremioId(id, type);
    if (!parsedId || !parsedId.imdbId) {
      console.log(`[STREAM] Unsupported ID: ${id}`);
      return res.json({ streams: [] });
    }

    let title = `IMDb: ${parsedId.imdbId}`;
    let year = null;

    // Fetch title and year from TMDB if API key is available
    if (userConfig.tmdbKey) {
      try {
        const mediaType = type === 'movie' ? 'movie' : 'tv';
        const tmdbResponse = await fetch(
          `https://api.themoviedb.org/3/find/${parsedId.imdbId}?api_key=${userConfig.tmdbKey}&external_source=imdb_id`
        );

        if (tmdbResponse.ok) {
          const tmdbData = await tmdbResponse.json();
          const results = type === 'movie' ? tmdbData.movie_results : tmdbData.tv_results;
          if (results && results.length > 0) {
            title = results[0].title || results[0].name || title;

            // Extract year from release_date or first_air_date
            if (results[0].release_date) {
              year = results[0].release_date.split('-')[0];
            } else if (results[0].first_air_date) {
              year = results[0].first_air_date.split('-')[0];
            }

            console.log(`[STREAM] Found title: "${title}" year: ${year || 'N/A'} via TMDB`);
          }
        }
      } catch (error) {
        console.log(`[STREAM] TMDB error: ${error.message}`);
      }
    }

    const streams = [];
    const {
      ratings = [],
      markAsWatched = true,
      markAsUnwatched = true,
      enableSeasonWatched = true,
      enableWatchlist = true,
      enableRemoveFromWatchlist = true,
      keepSingleWatchedState = false,
      keepSingleStateDisplay = 'inline',
      keepSingleStateEmoji = '🔄'
    } = userConfig;

    console.log(`[STREAM] Config - Watched: ${markAsWatched}, Unwatched: ${markAsUnwatched}, Ratings: ${ratings.length}, Season: ${enableSeasonWatched}, Watchlist: ${enableWatchlist}, KeepSingleState: ${keepSingleWatchedState}, Display: ${keepSingleStateDisplay}, Emoji: ${keepSingleStateEmoji}`);

    if (type === 'movie') {
      // Watched/Unwatched options
      if (markAsWatched) {
        let watchedTitle = `✅ Mark "${title}" as Watched`;
        if (keepSingleWatchedState) {
          if (keepSingleStateDisplay === 'none') {
            watchedTitle = `✅ Mark "${title}" as Watched`;
          } else if (keepSingleStateDisplay === 'newline') {
            watchedTitle = `✅ Mark "${title}" as Watched\n${keepSingleStateEmoji} Keeps only latest watched state`;
          } else {
            watchedTitle = `✅ Mark "${title}" as Watched ${keepSingleStateEmoji} Keeps only latest watched state`;
          }
        }
        streams.push({
          name: "Trakt Marks",
          title: watchedTitle,
          url: `${SERVER_URL}/configured/${config}/trakt-action?config=${config}&action=mark_watched&type=movie&imdbId=${parsedId.imdbId}&title=${encodeURIComponent(title)}`,
          behaviorHints: {
            notWebReady: false,
            bingeGroup: `trakt-movie-${parsedId.imdbId}-mark_watched`
          }
        });
      }

      if (markAsUnwatched) {
        streams.push(await createStreamObject(title, 'mark_unwatched', 'movie', parsedId.imdbId, null, null, null, config, year, userConfig));
      }

      // Watchlist options for movies
      if (enableWatchlist) {
        streams.push(await createStreamObject(title, 'add_to_watchlist', 'movie', parsedId.imdbId, null, null, null, config, year, userConfig));
      }

      if (enableRemoveFromWatchlist) {
        streams.push(await createStreamObject(title, 'remove_from_watchlist', 'movie', parsedId.imdbId, null, null, null, config, year, userConfig));
      }

      // Rating options
      if (ratings && ratings.length > 0) {
        for (const rating of ratings) {
          streams.push(await createStreamObject(title, 'rate_only', 'movie', parsedId.imdbId, rating, null, null, config, year, userConfig));
        }
      }

    } else if (type === 'series') {
      if (parsedId.season !== null && parsedId.episode !== null) {
        console.log(`[STREAM] Episode view: S${parsedId.season}E${parsedId.episode}`);

        // Watched options for episodes
        if (markAsWatched) {
          let watchedTitle = `✅ Mark S${parsedId.season}E${parsedId.episode} as Watched`;
          if (keepSingleWatchedState) {
            if (keepSingleStateDisplay === 'none') {
              watchedTitle = `✅ Mark S${parsedId.season}E${parsedId.episode} as Watched`;
            } else if (keepSingleStateDisplay === 'newline') {
              watchedTitle = `✅ Mark S${parsedId.season}E${parsedId.episode} as Watched\n${keepSingleStateEmoji} Keeps only latest watched state`;
            } else {
              watchedTitle = `✅ Mark S${parsedId.season}E${parsedId.episode} as Watched ${keepSingleStateEmoji} Keeps only latest watched state`;
            }
          }
          streams.push({
            name: "Trakt Marks",
            title: watchedTitle,
            url: `${SERVER_URL}/configured/${config}/trakt-action?config=${config}&action=mark_watched&type=series&imdbId=${parsedId.imdbId}&title=${encodeURIComponent(title)}&season=${parsedId.season}&episode=${parsedId.episode}`,
            behaviorHints: {
              notWebReady: false,
              bingeGroup: `trakt-series-${parsedId.imdbId}-mark_watched`
            }
          });

          if (enableSeasonWatched) {
            let seasonTitle = `📅 Mark Season ${parsedId.season} of "${title}" as Watched`;
            if (keepSingleWatchedState) {
              if (keepSingleStateDisplay === 'none') {
                seasonTitle = `📅 Mark Season ${parsedId.season} of "${title}" as Watched`;
              } else if (keepSingleStateDisplay === 'newline') {
                seasonTitle = `📅 Mark Season ${parsedId.season} of "${title}" as Watched\n${keepSingleStateEmoji} Keeps only latest watched state`;
              } else {
                seasonTitle = `📅 Mark Season ${parsedId.season} of "${title}" as Watched ${keepSingleStateEmoji} Keeps only latest watched state`;
              }
            }
            streams.push({
              name: "Trakt Marks",
              title: seasonTitle,
              url: `${SERVER_URL}/configured/${config}/trakt-action?config=${config}&action=mark_season_watched&type=series&imdbId=${parsedId.imdbId}&title=${encodeURIComponent(title)}&season=${parsedId.season}`,
              behaviorHints: {
                notWebReady: false,
                bingeGroup: `trakt-series-${parsedId.imdbId}-mark_season_watched`
              }
            });
          }

          let seriesTitle = `📺 Mark Entire "${title}" Series as Watched`;
          if (keepSingleWatchedState) {
            if (keepSingleStateDisplay === 'none') {
              seriesTitle = `📺 Mark Entire "${title}" Series as Watched`;
            } else if (keepSingleStateDisplay === 'newline') {
              seriesTitle = `📺 Mark Entire "${title}" Series as Watched\n${keepSingleStateEmoji} Keeps only latest watched state`;
            } else {
              seriesTitle = `📺 Mark Entire "${title}" Series as Watched ${keepSingleStateEmoji} Keeps only latest watched state`;
            }
          }
          streams.push({
            name: "Trakt Marks",
            title: seriesTitle,
            url: `${SERVER_URL}/configured/${config}/trakt-action?config=${config}&action=mark_series_watched&type=series&imdbId=${parsedId.imdbId}&title=${encodeURIComponent(title)}`,
            behaviorHints: {
              notWebReady: false,
              bingeGroup: `trakt-series-${parsedId.imdbId}-mark_series_watched`
            }
          });
        }

        // Unwatched options
        if (markAsUnwatched) {
          streams.push(await createStreamObject(title, 'mark_unwatched', 'series', parsedId.imdbId, null, parsedId.season, parsedId.episode, config, year, userConfig));
        }

        // Watchlist options for series (available in episode view)
        if (enableWatchlist) {
          streams.push(await createStreamObject(title, 'add_to_watchlist', 'series', parsedId.imdbId, null, null, null, config, year, userConfig));
        }

        if (enableRemoveFromWatchlist) {
          streams.push(await createStreamObject(title, 'remove_from_watchlist', 'series', parsedId.imdbId, null, null, null, config, year, userConfig));
        }

        // Rating options for episodes
        if (ratings && ratings.length > 0) {
          for (const rating of ratings) {
            streams.push(await createStreamObject(title, 'rate_only', 'series', parsedId.imdbId, rating, parsedId.season, parsedId.episode, config, year, userConfig));
          }
        }
      } else {
        console.log(`[STREAM] Series overview`);

        // Series-wide watched option
        if (markAsWatched) {
          let seriesTitle = `📺 Mark Entire "${title}" Series as Watched`;
          if (keepSingleWatchedState) {
            if (keepSingleStateDisplay === 'none') {
              seriesTitle = `📺 Mark Entire "${title}" Series as Watched`;
            } else if (keepSingleStateDisplay === 'newline') {
              seriesTitle = `📺 Mark Entire "${title}" Series as Watched\n${keepSingleStateEmoji} Keeps only latest watched state`;
            } else {
              seriesTitle = `📺 Mark Entire "${title}" Series as Watched ${keepSingleStateEmoji} Keeps only latest watched state`;
            }
          }
          streams.push({
            name: "Trakt Marks",
            title: seriesTitle,
            url: `${SERVER_URL}/configured/${config}/trakt-action?config=${config}&action=mark_series_watched&type=series&imdbId=${parsedId.imdbId}&title=${encodeURIComponent(title)}`,
            behaviorHints: {
              notWebReady: false,
              bingeGroup: `trakt-series-${parsedId.imdbId}-mark_series_watched`
            }
          });
        }

        // Watchlist options for entire series (no episodes)
        if (enableWatchlist) {
          streams.push(await createStreamObject(title, 'add_to_watchlist', 'series', parsedId.imdbId, null, null, null, config, year, userConfig));
        }

        if (enableRemoveFromWatchlist) {
          streams.push(await createStreamObject(title, 'remove_from_watchlist', 'series', parsedId.imdbId, null, null, null, config, year, userConfig));
        }

        // Series-wide rating options
        if (ratings && ratings.length > 0) {
          for (const rating of ratings) {
            streams.push(await createStreamObject(title, 'rate_only', 'series', parsedId.imdbId, rating, null, null, config, year, userConfig));
          }
        }
      }
    }

    console.log(`[STREAM] Returning ${streams.length} stream(s) for: "${title}"`);
    res.json({ streams });

  } catch (error) {
    console.error('[STREAM] Error:', error);
    res.json({ streams: [] });
  }
});

// ============================================
// Configuration Page Route
// ============================================
app.get("/configured/:config/configure", (req, res) => {
  const { config } = req.params;
  console.log(`[CONFIG REDIRECT] Redirecting to configuration page with config: ${config}`);
  res.redirect(`/configure`);
});

app.get("/configure", (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// ============================================
// Trakt Action Endpoint (UPDATED to handle rating cleanup)
// ============================================

app.get("/configured/:config/trakt-action", async (req, res) => {
  const { config } = req.params;
  const { action, type, imdbId, title, season, episode, rating } = req.query;

  console.log(`[TRAKT-ACTION] Click detected! Executing immediately...`);
  console.log(`  Action: ${action}, Type: ${type}, IMDb: ${imdbId}`);
  console.log(`  Title: ${decodeURIComponent(title)}`);

  // Using the proven working video URL from Overseerr
  const waitUrl = "https://cdn.jsdelivr.net/gh/ericvlog/material@main/stream1.mp4";

  setTimeout(async () => {
    try {
      // Use the helper function to get config with tokens
      const userConfig = await getUserConfigWithTokens(config);

      if (userConfig && userConfig.access_token) {
        // NEW: If both markAsPlayedOnRate AND keepSingleWatchedState are enabled,
        // we need to handle cleanup in the rate_only action itself
        // This is now handled inside makeTraktRequest for rate_only action

        const result = await makeTraktRequest(
          action,
          type,
          imdbId,
          decodeURIComponent(title),
          userConfig,
          rating,
          season,
          episode
        );

        if (result.success) {
          console.log(`[TRAKT] ✅ ${result.message}`);
        } else {
          console.error(`[TRAKT] ❌ ${result.error}`);
        }
      } else {
        console.error(`[TRAKT-ACTION] Invalid config or missing access token`);
      }
    } catch (error) {
      console.error(`[TRAKT] Error: ${error.message}`);
    }
  }, 100);

  // Redirect to the working video
  res.redirect(waitUrl);
});

// ============================================
// Default Routes
// ============================================

app.get("/stream/:type/:id.json", (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({ streams: [] });
});

app.get("/", (req, res) => {
  res.redirect('/configure');
});

app.get("/health", (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    server: SERVER_URL,
    pending_requests: pendingRequests.size,
    oauth_states: oauthStates.size,
    environment: process.env.NODE_ENV || 'development',
    version: '2.2.1',
    features: 'Upstash Redis, Trakt Sync, Ratings, Watchlist, Keep Single Watched State'
  });
});

// Cleanup old requests endpoint
app.get("/cleanup", (req, res) => {
  const beforeCount = pendingRequests.size;

  // Clean up old requests (older than 1 hour)
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const [key, timestamp] of pendingRequests.entries()) {
    if (timestamp < oneHourAgo) {
      pendingRequests.delete(key);
    }
  }

  const afterCount = pendingRequests.size;
  const cleaned = beforeCount - afterCount;

  res.json({
    cleaned: cleaned,
    remaining: afterCount,
    message: `Cleaned ${cleaned} old requests, ${afterCount} remaining`
  });
});

// ============================================
// Server Startup
// ============================================

if (process.env.NODE_ENV !== 'production' || process.env.RUN_SERVER) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Trakt Addon Server Started v2.2.1`);
    console.log(`📋 Configuration: ${SERVER_URL}/configure`);
    console.log(`📦 Default Manifest: ${SERVER_URL}/manifest.json`);
    console.log(`📦 Configured Manifest Example: ${SERVER_URL}/configured/eyJjbGllbnRJZCI6Ii4uLiJ9/manifest.json`);
    console.log(`🔐 OAuth: ${SERVER_URL}/oauth/initiate`);
    console.log(`🔑 Upstash Test: POST ${SERVER_URL}/upstash/test`);
    console.log(`🔑 Get Tokens: POST ${SERVER_URL}/oauth/tokens`);
    console.log(`🧪 Health: ${SERVER_URL}/health`);
    console.log(`🧹 Cleanup: ${SERVER_URL}/cleanup`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`⚡ Server URL: ${SERVER_URL}`);
    console.log(`🖼️  Images: Logo: ${LOGO_URL}, Background: ${BACKGROUND_URL}`);
    console.log(`🔧 Features: Watched/Unwatched, Season Watched, Ratings, Watchlist, Keep Single State`);
    console.log(`🎨 Rating Patterns: Original, Pattern 1, Pattern 6`);
    console.log(`📊 Stats Display: Customizable Trakt stats (choose any 3)`);
    console.log(`🔐 Persistent Storage: Upstash Redis for 90-day token storage`);
    console.log(`⚠️  Fallback System: Local cache when Upstash is unreachable`);
    console.log(`🎬 Video: Using Overseerr wait.mp4 video (proven to work with Stremio)`);
    console.log(`🔄 Keep Single State: Removes duplicates when marking as watched`);
    console.log(`\n✅ IMPORTANT: All features working with Upstash support!`);
  });
}

export default app;
