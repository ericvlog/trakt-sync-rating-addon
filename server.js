import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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

// Store OAuth states and pending requests (in-memory, reset on server restart)
const oauthStates = new Map();
const pendingRequests = new Map();

// Cache for TMDB and Trakt data
const tmdbCache = new Map();
const traktStatsCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

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
// Rating Title Formatter (UPDATED with Custom Stats)
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
                        'comments': 'comments',
                        'lists': 'lists',
                        'collectors': 'collected',
                        'votes': 'votes',
                        'rating': 'rating'
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
            if (season && episode) {
                // Detect series type for emoji
                let seriesEmoji = '📺';
                const animeKeywords = ['attack on titan', 'demon slayer', 'naruto', 'one piece',
                                      'dragon ball', 'my hero academia', 'bleach', 'hunter x hunter'];
                const animationKeywords = ['rick and morty', 'south park', 'family guy', 'simpsons'];
                const docKeywords = ['planet earth', 'cosmos', 'blue planet', 'documentary'];

                const lowerTitle = title.toLowerCase();
                if (animeKeywords.some(keyword => lowerTitle.includes(keyword))) seriesEmoji = '🐉';
                else if (animationKeywords.some(keyword => lowerTitle.includes(keyword))) seriesEmoji = '🎨';
                else if (docKeywords.some(keyword => lowerTitle.includes(keyword))) seriesEmoji = '📽️';

                // Get episode type indicator
                let episodeIndicator = '';
                if (episode === 1) episodeIndicator = ' 🚀';
                if (episode >= 10) episodeIndicator = ' 🔚';

                return `${seriesEmoji} ${title} S${season}E${episode}${episodeIndicator}\n⭐ ${ratingVisual}\n🎯 Rating ${rating}/10\n${statsLine}\n📊 ${rating} out of 10 stars`;
            } else if (season) {
                return `📺 ${title} Season ${season}\n⭐ ${ratingVisual}\n🎯 Rating ${rating}/10\n${statsLine}\n📊 ${rating} out of 10 stars`;
            } else {
                return `📺 ${title} (Series)\n⭐ ${ratingVisual}\n🎯 Rating ${rating}/10\n${statsLine}\n📊 ${rating} out of 10 stars`;
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
// OAuth Routes
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

app.post('/oauth/exchange', async (req, res) => {
  const { code, clientId } = req.body;

  try {
    const response = await fetch('https://api.trakt.tv/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: clientId,
        client_secret: '', // Required but can be empty
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

    res.json({
      success: true,
      tokens: tokens,
      username: username
    });

  } catch (error) {
    console.error('OAuth exchange error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// Trakt API Function
// ============================================

async function makeTraktRequest(action, type, imdbId, title, userConfig, rating = null, season = null, episode = null) {
  try {
    console.log(`[TRAKT] Making ${action} request for ${type}: ${imdbId} - "${title}"`);
    console.log(`[TRAKT] Season: ${season}, Episode: ${episode}, Rating: ${rating}`);

    const accessToken = userConfig.access_token;
    const clientId = userConfig.clientId;

    let message = '';
    let response;

    switch (action) {
      case 'mark_watched':
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
        if (type === 'movie') {
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
        } else if (type === 'series') {
          if (season && episode) {
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
          } else {
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
          }
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
// Stream Object Creator
// ============================================

async function createStreamObject(title, action, type, imdbId, rating = null, season = null, episode = null, config = '', year = null, userConfig = null) {
  let streamTitle;
  let streamName = "Trakt"; // Default name

  // Decode config to get user preferences
  let decodedConfig = userConfig;
  let ratingPattern = 0; // Default pattern
  let ratingStyle = 'stars'; // Default style
  let statsFormat = 1; // Default stats format
  let selectedStats = ['watchers', 'plays', 'comments']; // Default stats

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
  }

  if (action === 'mark_watched') {
    if (type === 'movie') {
      streamTitle = `✅ Mark "${title}" as Watched`;
    } else if (season && episode) {
      streamTitle = `✅ Mark S${season}E${episode} as Watched`;
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
    streamTitle = `📅 Mark Season ${season} of "${title}" as Watched`;
    streamName = "Trakt Marks";
  } else if (action === 'mark_series_watched') {
    streamTitle = `📺 Mark Entire "${title}" Series as Watched`;
    streamName = "Trakt Marks";
  } else if (action === 'rate_only') {
    // Use the new formatRatingTitle function with stats support
    streamTitle = await formatRatingTitle(ratingPattern, ratingStyle, rating, title, type, season, episode, year, decodedConfig, imdbId);
    streamName = "Trakt Rating";
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
// FIXED: DEFAULT MANIFEST (WITH CONFIGURE BUTTON)
// ============================================

app.get("/manifest.json", (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  const manifest = {
    id: "org.stremio.trakt",
    version: "1.0.0",
    name: "Trakt Sync & Rate",
    description: "Sync watched states and rate content on Trakt.tv - configure your instance",
    resources: ["stream"],
    types: ["movie", "series"],
    catalogs: [],
    idPrefixes: ["tt"],
    // CRITICAL: This tells Stremio to show the "Configure" button
    behaviorHints: {
      configurable: true,
      configurationRequired: true
    },
    background: "https://i.imgur.com/sO4pC8H.png",
    logo: "https://i.imgur.com/8Q3Zz5y.png",
    contactEmail: ""
  };

  console.log(`[MANIFEST] Default manifest requested (shows Configure button)`);
  res.json(manifest);
});

// ============================================
// FIXED: CONFIGURED MANIFEST (NO CONFIGURE BUTTON)
// ============================================

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
      version: "1.0.0",
      name: addonName,
      description: `Sync watched states and rate content on Trakt.tv${username ? ` - ${username}'s instance` : ''}`,
      resources: ["stream"],
      types: ["movie", "series"],
      catalogs: [],
      idPrefixes: ["tt"],
      // CRITICAL: Already configured, so no Configure button needed
      behaviorHints: {
        configurable: true,
        configurationRequired: false
      },
      background: "https://i.imgur.com/sO4pC8H.png",
      logo: "https://i.imgur.com/8Q3Zz5y.png",
      contactEmail: ""
    };

    console.log(`[MANIFEST] ✅ Sending configured manifest. Show username: ${showUsername}, Name: "${addonName}"`);
    res.json(manifest);

  } catch (error) {
    console.error(`[MANIFEST] ❌ Error generating manifest: ${error.message}`);

    const fallbackManifest = {
      id: "org.stremio.trakt",
      version: "1.0.0",
      name: "Trakt Sync & Rate",
      description: "Sync watched states and rate content on Trakt.tv",
      resources: ["stream"],
      types: ["movie", "series"],
      catalogs: [],
      idPrefixes: ["tt"],
      behaviorHints: {
        configurable: true,
        configurationRequired: true
      }
    };

    res.json(fallbackManifest);
  }
});

// ============================================
// ALSO ADD THIS ROUTE FOR COMPATIBILITY WITH STREMIO-ADDONS.NET
// ============================================

app.get("/:config/manifest.json", (req, res) => {
  const { config } = req.params;
  
  // Redirect to the configured manifest endpoint
  res.redirect(`/configured/${config}/manifest.json`);
});

// ============================================
// Stream Endpoint
// ============================================

app.get("/configured/:config/stream/:type/:id.json", async (req, res) => {
  const { config, type, id } = req.params;

  res.setHeader('Content-Type', 'application/json');

  console.log(`[STREAM] Configured stream requested for ${type} ID: ${id}`);

  try {
    const userConfig = decodeConfig(config);
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
    const { ratings = [], markAsWatched = true, markAsUnwatched = true, enableSeasonWatched = true } = userConfig;

    console.log(`[STREAM] Config - Watched: ${markAsWatched}, Unwatched: ${markAsUnwatched}, Ratings: ${ratings}, Season Watched: ${enableSeasonWatched}`);

    if (type === 'movie') {
      if (markAsWatched) {
        streams.push(await createStreamObject(title, 'mark_watched', 'movie', parsedId.imdbId, null, null, null, config, year, userConfig));
      }

      if (markAsUnwatched) {
        streams.push(await createStreamObject(title, 'mark_unwatched', 'movie', parsedId.imdbId, null, null, null, config, year, userConfig));
      }

      if (ratings && ratings.length > 0) {
        for (const rating of ratings) {
          streams.push(await createStreamObject(title, 'rate_only', 'movie', parsedId.imdbId, rating, null, null, config, year, userConfig));
        }
      }

    } else if (type === 'series') {
      if (parsedId.season !== null && parsedId.episode !== null) {
        console.log(`[STREAM] Episode view: S${parsedId.season}E${parsedId.episode}`);

        if (markAsWatched) {
          streams.push(await createStreamObject(title, 'mark_watched', 'series', parsedId.imdbId, null, parsedId.season, parsedId.episode, config, year, userConfig));

          if (enableSeasonWatched) {
            streams.push(await createStreamObject(title, 'mark_season_watched', 'series', parsedId.imdbId, null, parsedId.season, null, config, year, userConfig));
          }

          streams.push(await createStreamObject(title, 'mark_series_watched', 'series', parsedId.imdbId, null, null, null, config, year, userConfig));
        }

        if (markAsUnwatched) {
          streams.push(await createStreamObject(title, 'mark_unwatched', 'series', parsedId.imdbId, null, parsedId.season, parsedId.episode, config, year, userConfig));
        }

        if (ratings && ratings.length > 0) {
          for (const rating of ratings) {
            streams.push(await createStreamObject(title, 'rate_only', 'series', parsedId.imdbId, rating, parsedId.season, parsedId.episode, config, year, userConfig));
          }
        }
      } else {
        console.log(`[STREAM] Series overview`);

        if (markAsWatched) {
          streams.push(await createStreamObject(title, 'mark_series_watched', 'series', parsedId.imdbId, null, null, null, config, year, userConfig));
        }

        if (ratings && ratings.length > 0) {
          for (const rating of ratings) {
            streams.push(await createStreamObject(title, 'rate_only', 'series', parsedId.imdbId, rating, null, null, config, year, userConfig));
          }
        }
      }
    }

    console.log(`[STREAM] Returning ${streams.length} stream(s) for: "${title}"`);
    console.log(`[STREAM] Stream names: ${streams.map(s => s.name).join(', ')}`);
    res.json({ streams });

  } catch (error) {
    console.error('[STREAM] Error:', error);
    res.json({ streams: [] });
  }
});

// ============================================
// Configuration Page Route
// ============================================

app.get("/configure", (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// ============================================
// Trakt Action Endpoint
// ============================================

app.get("/configured/:config/trakt-action", async (req, res) => {
  const { config } = req.params;
  const { action, type, imdbId, title, season, episode, rating } = req.query;

  console.log(`[TRAKT-ACTION] Click detected! Executing immediately...`);
  console.log(`  Action: ${action}, Type: ${type}, IMDb: ${imdbId}`);
  console.log(`  Title: ${decodeURIComponent(title)}`);

  const waitUrl = "https://cdn.jsdelivr.net/gh/ericvlog/stremio-overseerr-addon@main/public/wait.mp4";

  // Execute immediately without any duplicate check
  setTimeout(async () => {
    try {
      const userConfig = decodeConfig(config);
      if (userConfig && userConfig.access_token) {

        // If action is rate_only and markAsPlayedOnRate is enabled, also mark as watched
        if (action === 'rate_only' && userConfig.markAsPlayedOnRate) {
          console.log(`[TRAKT-ACTION] Also marking as played (markAsPlayedOnRate enabled)`);

          // First mark as watched
          const markResult = await makeTraktRequest(
            'mark_watched',
            type,
            imdbId,
            decodeURIComponent(title),
            userConfig,
            null,
            season,
            episode
          );

          if (markResult.success) {
            console.log(`[TRAKT] ✅ ${markResult.message}`);
          }
        }

        // Then perform the main action (rating)
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
      }
    } catch (error) {
      console.error(`[TRAKT] Error: ${error.message}`);
    }
  }, 100);

  res.redirect(waitUrl);
});

// ============================================
// Default Stream Route (for unconfigured)
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
    environment: process.env.NODE_ENV || 'development'
  });
});

// ============================================
// Server Startup (Only for Docker/Standalone)
// ============================================

if (process.env.NODE_ENV !== 'production' || process.env.RUN_SERVER) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Trakt Addon Server Started`);
    console.log(`📋 Configuration: ${SERVER_URL}/configure`);
    console.log(`📦 Default Manifest: ${SERVER_URL}/manifest.json`);
    console.log(`📦 Configured Manifest Example: ${SERVER_URL}/configured/eyJjbGllbnRJZCI6Ii4uLiJ9/manifest.json`);
    console.log(`🔐 OAuth: ${SERVER_URL}/oauth/initiate`);
    console.log(`🧪 Health: ${SERVER_URL}/health`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`⚡ Server URL: ${SERVER_URL}`);
    console.log(`🔧 Features: Watched/Unwatched, Season Watched, Ratings`);
    console.log(`🎨 Rating Patterns: Original, Pattern 1, Pattern 6`);
    console.log(`📊 Stats Display: Customizable Trakt stats (choose any 3)`);
    console.log(`\n🔧 IMPORTANT: Addon now shows "Configure" button in Stremio!`);
  });
}

// Export for serverless (Vercel)
export default app;
