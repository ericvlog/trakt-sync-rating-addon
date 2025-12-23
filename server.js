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

function createStreamObject(title, action, type, imdbId, rating = null, season = null, episode = null, config = '') {
  let streamTitle;
  let streamName = "Trakt"; // Default name

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
    // Get rating style from config (default to 'stars')
    let ratingStyle = 'stars';
    try {
      const userConfig = decodeConfig(config);
      if (userConfig && userConfig.ratingStyle) {
        ratingStyle = userConfig.ratingStyle;
      }
    } catch (e) {
      console.log('[STREAM] Could not decode config for rating style, using default');
    }
    
    // Generate visual rating based on style
    const ratingVisual = generateRatingVisual(ratingStyle, rating);
    
    if (type === 'movie') {
      streamTitle = `${ratingVisual}\n"${title}" ${rating}/10`;
    } else if (season && episode) {
      streamTitle = `${ratingVisual}\nS${season}E${episode} "${title}" ${rating}/10`;
    } else {
      streamTitle = `${ratingVisual}\n"${title}" Series ${rating}/10`;
    }
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
// Configured Manifest Endpoint
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
      idPrefixes: ["tt"]
    };

    res.json(fallbackManifest);
  }
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
            console.log(`[STREAM] Found title: "${title}" via TMDB`);
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
        streams.push(createStreamObject(title, 'mark_watched', 'movie', parsedId.imdbId, null, null, null, config));
      }

      if (markAsUnwatched) {
        streams.push(createStreamObject(title, 'mark_unwatched', 'movie', parsedId.imdbId, null, null, null, config));
      }

      if (ratings && ratings.length > 0) {
        ratings.forEach(rating => {
          streams.push(createStreamObject(title, 'rate_only', 'movie', parsedId.imdbId, rating, null, null, config));
        });
      }

    } else if (type === 'series') {
      if (parsedId.season !== null && parsedId.episode !== null) {
        console.log(`[STREAM] Episode view: S${parsedId.season}E${parsedId.episode}`);

        if (markAsWatched) {
          streams.push(createStreamObject(title, 'mark_watched', 'series', parsedId.imdbId, null, parsedId.season, parsedId.episode, config));

          if (enableSeasonWatched) {
            streams.push(createStreamObject(title, 'mark_season_watched', 'series', parsedId.imdbId, null, parsedId.season, null, config));
          }

          streams.push(createStreamObject(title, 'mark_series_watched', 'series', parsedId.imdbId, null, null, null, config));
        }

        if (markAsUnwatched) {
          streams.push(createStreamObject(title, 'mark_unwatched', 'series', parsedId.imdbId, null, parsedId.season, parsedId.episode, config));
        }

        if (ratings && ratings.length > 0) {
          ratings.forEach(rating => {
            streams.push(createStreamObject(title, 'rate_only', 'series', parsedId.imdbId, rating, parsedId.season, parsedId.episode, config));
          });
        }
      } else {
        console.log(`[STREAM] Series overview`);

        if (markAsWatched) {
          streams.push(createStreamObject(title, 'mark_series_watched', 'series', parsedId.imdbId, null, null, null, config));
        }

        if (ratings && ratings.length > 0) {
          ratings.forEach(rating => {
            streams.push(createStreamObject(title, 'rate_only', 'series', parsedId.imdbId, rating, null, null, config));
          });
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
// Default Routes
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
    idPrefixes: ["tt"]
  };

  console.log(`[MANIFEST] Default manifest requested`);
  res.json(manifest);
});

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
    console.log(`📦 Manifest: ${SERVER_URL}/manifest.json`);
    console.log(`🔐 OAuth: ${SERVER_URL}/oauth/initiate`);
    console.log(`🧪 Health: ${SERVER_URL}/health`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`⚡ Server URL: ${SERVER_URL}`);
    console.log(`🔧 Features: Watched/Unwatched, Season Watched, Ratings`);
  });
}

// Export for serverless (Vercel)
export default app;
