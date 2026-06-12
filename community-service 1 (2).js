/**
* Community Service
* Calls the Community MCP Server to get community information
*/

const axios = require('axios');
const https = require('https');
const boschAuthService = require('./bosch-auth-service');
const configService = require('./config-service');
const { createOpenAIClient, getChatModelName } = require('./openai-client');

// Bosch internal MCP servers use corporate PKI (Bosch root CA) not trusted by Node.js by default.
// rejectUnauthorized: false is intentional for internal-network services — not a public-internet risk.
const httpsAgent = new https.Agent({
  rejectUnauthorized: false // [INTERNAL-CA] Bosch corporate PKI — system CA not available to Node.js
});

class CommunityService {
  constructor() {
    // Use deployed Community MCP Server (base URL); endpoint can be /mcp or root
    this.mcpBaseUrl = process.env.COMMUNITY_MCP_URL;
    this.communityBaseUrl = process.env.COMMUNITY_API_FOR_REG;
    this.mcpUrl = this.mcpBaseUrl;
    this.cache = new Map();
    this.cacheTimeout = 10 * 60 * 1000; // 10 minutes
    this.userSessions = new Map(); // employeeNumber -> mcpSessionId
    this._openai = null;
  }

  get openai() {
    if (!this._openai) {
      this._openai = createOpenAIClient();
    }
    return this._openai;
  }

  /**
   * Build candidate MCP endpoints for compatibility with different deployments.
   */
  getMcpEndpointCandidates() {
    const base = this.mcpBaseUrl.replace(/\/$/, '');
    if (base.endsWith('/mcp')) {
      return [base, base.replace(/\/mcp$/, '')];
    }
    return [`${base}/mcp`, base];
  }

  /**
   * Initialize MCP session for a specific user.
   */
  async initializeMCPSession(userId = 'default') {
    console.log(`[Community] Initializing MCP session for user: ${userId}...`);

    const initPayload = {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mybgs-companion", version: "1.0.0" }
      },
      id: 1
    };

    let lastError = null;
    for (const endpoint of this.getMcpEndpointCandidates()) {
      try {
        const response = await axios.post(endpoint, initPayload, {
          headers: {
            'Accept': 'application/json, text/event-stream',
            'Content-Type': 'application/json'
          },
          timeout: 30000,
          httpsAgent,
          transformResponse: [(data) => data]
        });

        this.mcpUrl = endpoint;
        const sessionId = response.headers['mcp-session-id'] || response.headers['x-mcp-session-id'] || null;
        if (sessionId) {
          this.userSessions.set(userId, sessionId);
        }
        console.log(`[Community] MCP session initialized for ${userId} at:`, this.mcpUrl, 'session:', sessionId || 'none');
        return sessionId;
      } catch (error) {
        lastError = error;
        console.log(`[Community] MCP init failed at ${endpoint}: ${error.message}`);
      }
    }

    console.error('[Community] Failed to initialize MCP session on all endpoints');
    throw lastError || new Error('Failed to initialize community MCP session');
  }

  /**
   * Get cache key
   */
  getCacheKey(page, pageSize) {
    return `community:${page}:${pageSize}`;
  }

  /**
   * Check if cache is valid
   */
  isCacheValid(cacheEntry) {
    if (!cacheEntry) return false;
    return Date.now() - cacheEntry.timestamp < this.cacheTimeout;
  }

  /**
   * Parse SSE response data
   */
  parseSSEResponse(sseData) {
    if (typeof sseData !== 'string') return sseData;

    const lines = sseData.split('\n');
    let result = null;

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          result = JSON.parse(line.substring(6));
        } catch (e) {
          result = { answer: line.substring(6) };
        }
      }
    }

    return result;
  }

  /**
   * Parse MCP tool response to plain object/string.
   */
  parseMcpToolResponse(rawData) {
    const result = this.parseSSEResponse(rawData);
    const mcpResult = result?.result || result;

    // Common shape: { content: [{ type: 'text', text: '...json...' }] }
    if (mcpResult?.content && Array.isArray(mcpResult.content)) {
      for (const item of mcpResult.content) {
        if (item.type === 'text' && item.text) {
          try {
            return JSON.parse(item.text);
          } catch (e) {
            return item.text;
          }
        }
      }
    }

    // Alternate shape: { structuredContent: { result: '...json...' } }
    if (mcpResult?.structuredContent?.result) {
      const parsed = this.tryParseJson(mcpResult.structuredContent.result);
      if (parsed) return parsed;
    }

    return mcpResult;
  }

  tryParseJson(value) {
    if (typeof value !== 'string') return null;
    try {
      return JSON.parse(value);
    } catch (e) {
      return null;
    }
  }

  normalizeText(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Simple suffix stemmer so semantic variants of the same root word match each other.
   * Examples: runner / runners / running → "run"
   *           player / players / playing → "play"
   *           wellness → "well", clubs → "club"
   */
  _stemWord(w) {
    if (w.length <= 3) return w;
    const dedup = s => s.replace(/(.)\1$/, '$1');
    if (w.endsWith('iers')) return dedup(w.slice(0, -4)) + 'y';
    if (w.endsWith('ies'))  return dedup(w.slice(0, -3)) + 'y';
    if (w.endsWith('ing'))  return dedup(w.slice(0, -3));
    if (w.endsWith('ers'))  return dedup(w.slice(0, -3));
    if (w.endsWith('ness')) return w.slice(0, -4);
    if (w.endsWith('er'))   return dedup(w.slice(0, -2));
    if (w.endsWith('ed'))   return dedup(w.slice(0, -2));
    if (w.endsWith('s'))    return w.slice(0, -1);
    return w;
  }

  flattenCommunities(data) {
    let parsed = data;

    if (typeof parsed === 'string') {
      const parsedString = this.tryParseJson(parsed);
      if (parsedString) parsed = parsedString;
    }

    if (parsed?.structuredContent?.result) {
      const structured = this.tryParseJson(parsed.structuredContent.result);
      if (structured) parsed = structured;
    }

    if (parsed?.content && Array.isArray(parsed.content)) {
      for (const item of parsed.content) {
        if (item?.type === 'text' && item?.text) {
          const parsedText = this.tryParseJson(item.text);
          if (parsedText) {
            parsed = parsedText;
            break;
          }
        }
      }
    }

    const communities = [];

    if (parsed?.ResponseData && Array.isArray(parsed.ResponseData)) {
      parsed.ResponseData.forEach(group => {
        const groupMembers = group?.MembersCount;

        if (Array.isArray(group?.CommunityDetails)) {
          // ── Nested format (getCommunityList / all-communities API) ──────────
          // { ResponseData: [{ MembersCount, CommunityDetails: [...] }] }
          if (group.CommunityDetails.length > 0) {
            console.log('[Community] Raw community keys:', Object.keys(group.CommunityDetails[0]));
          }
          group.CommunityDetails.forEach(c => {
            communities.push({
              communityId: c?.CommunityId,
              name: c?.CommunityName || c?.Name || '',
              description: c?.Description || '',
              members: c?.CommunityMembers ?? c?.MembersCount ?? groupMembers ?? null,
              color: c?.Colour || c?.colour || null,
              imageUrl: c?.ImageUrl || null,
              locations: Array.isArray(c?.CommunityLocations)
                ? c.CommunityLocations.map(l => ({
                  id: l?.Id,
                  name: l?.LocationName || '',
                  code: l?.LocationCode || ''
                }))
                : []
            });
          });
        } else if (
          group?.CommunityId !== undefined || group?.communityId !== undefined ||
          group?.CommunityName || group?.communityName || group?.Name
        ) {
          // ── Flat format (GetRegisteredCommunityList API) ─────────────────
          // { ResponseData: [{ CommunityId, CommunityName, ... }, ...] }
          // Each ResponseData item is itself a community — no CommunityDetails nesting.
          // Log the actual field names once so we can verify the correct key.
          if (communities.length === 0) {
            console.log('[Community] Flat ResponseData keys (registered list):', Object.keys(group));
          }
          communities.push({
            // GetRegisteredCommunityList uses "RegisteredCommunityId" as the community key.
            // Also try all other casing variants for defensive compatibility.
            communityId: group?.RegisteredCommunityId ?? group?.registeredCommunityId
              ?? group?.CommunityId ?? group?.communityId ?? group?.CommunityID
              ?? group?.community_id ?? group?.Id ?? group?.id ?? null,
            name: group?.CommunityName || group?.communityName || group?.Name || group?.name || '',
            description: group?.Description || group?.description || '',
            members: group?.CommunityMembers ?? group?.communityMembers
              ?? group?.MembersCount ?? group?.membersCount ?? null,
            color: group?.Colour || group?.colour || group?.Color || group?.color || null,
            imageUrl: group?.ImageUrl || group?.imageUrl || null,
            locations: (() => {
              const locs = group?.CommunityLocations || group?.communityLocations;
              return Array.isArray(locs) ? locs.map(l => ({
                id: l?.Id ?? l?.id ?? null,
                name: l?.LocationName || l?.locationName || '',
                code: l?.LocationCode || l?.locationCode || ''
              })) : [];
            })()
          });
        }
      });
      return communities;
    }

    const list = Array.isArray(parsed)
      ? parsed
      : (Array.isArray(parsed?.communities) ? parsed.communities
        : (Array.isArray(parsed?.data) ? parsed.data
          : (Array.isArray(parsed?.items) ? parsed.items : [])));

    list.forEach(c => {
      communities.push({
        communityId: c?.communityId ?? c?.CommunityId ?? c?.id ?? null,
        name: c?.name || c?.CommunityName || c?.Name || '',
        description: c?.description || c?.Description || '',
        members: c?.members ?? c?.memberCount ?? c?.MembersCount ?? c?.CommunityMembers ?? null,
        color: c?.color || c?.Colour || null,
        imageUrl: c?.imageUrl || c?.ImageUrl || null,
        locations: Array.isArray(c?.locations)
          ? c.locations.map(l => ({
            id: l?.id ?? l?.Id ?? null,
            name: l?.name || l?.LocationName || '',
            code: l?.code || l?.LocationCode || ''
          }))
          : []
      });
    });

    return communities;
  }

  getLocationAliases(nameOrCode) {
    const n = this.normalizeText(nameOrCode);
    const aliases = new Set([n]);
    if (n.includes('bengaluru')) aliases.add('bangalore');
    if (n.includes('bangalore')) aliases.add('bengaluru');
    if (n.includes('bgsw pun dta') || n === 'pun') aliases.add('pune');
    if (n === 'ban') aliases.add('bangalore');
    if (n === 'cob') aliases.add('coimbatore');
    if (n === 'hyd') aliases.add('hyderabad');
    return aliases;
  }

  async resolveRegistrationFromQuery(query, communities) {
    const normalizedQuery = this.normalizeText(query);
    if (!normalizedQuery || !Array.isArray(communities) || communities.length === 0) {
      return { community: null, location: null };
    }

    const communityIdMatch = query.match(/community\s*id\s*[:=]?\s*(\d+)/i) || query.match(/community\s*(\d+)/i);
    const locationIdMatch = query.match(/location\s*id\s*[:=]?\s*(\d+)/i) || query.match(/location\s*(\d+)/i);
    const communityId = communityIdMatch ? parseInt(communityIdMatch[1], 10) : null;
    const locationId = locationIdMatch ? parseInt(locationIdMatch[1], 10) : null;

    let community = null;
    if (communityId) {
      community = communities.find(c => Number(c.communityId) === Number(communityId)) || null;
    }

    if (!community) {
      const orgSuffixes = new Set(['inc', 'ltd', 'co', 'corp']);
      const stemmedQueryWords = normalizedQuery
        .split(' ')
        .filter(w => w.length > 2 && !orgSuffixes.has(w))
        .map(w => this._stemWord(w));

      const scored = communities
        .map(c => {
          const cname = this.normalizeText(c.name);
          if (!cname) return { c, score: 0 };
          if (normalizedQuery.includes(cname)) return { c, score: 100 };

          const nameWords = cname
            .split(' ')
            .filter(w => w.length > 2 && !['community', 'club'].includes(w) && !orgSuffixes.has(w))
            .map(w => this._stemWord(w));
          const hitCount = nameWords.filter(w => stemmedQueryWords.includes(w)).length;
          const score = nameWords.length > 0 ? Math.round((hitCount / nameWords.length) * 80) : 0;
          return { c, score };
        })
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score);

      if (scored.length > 0) {
        const top = scored[0];
        const next = scored[1];
        if (!next || top.score - next.score >= 15) {
          community = top.c;
        }
      }

      // Word matching found nothing — fall back to LLM for semantic synonym resolution
      if (!community) {
        const llmMatches = await this._resolveCommunitiesWithLLM(query, communities);
        if (llmMatches.length > 0) {
          community = llmMatches[0];
        }
      }
    }

    let location = null;
    if (community) {
      if (locationId) {
        location = (community.locations || []).find(l => Number(l.id) === Number(locationId)) || null;
      }

      if (!location) {
        const candidates = (community.locations || []).map(l => {
          const aliases = [
            ...this.getLocationAliases(l.name),
            ...this.getLocationAliases(l.code)
          ];
          const matched = aliases.some(a => a && normalizedQuery.includes(a));
          return { l, matched };
        }).filter(x => x.matched);

        if (candidates.length === 1) {
          location = candidates[0].l;
        }
      }
    }

    return { community, location };
  }

  shouldShowAllCommunities(query) {
    const q = this.normalizeText(query);
    // Build regex from centralised config (editable via Admin UI)
    const communityKw = configService.getKeywordConfigSync().communityService;
    const phrases = (communityKw.listIntentPhrases || [
      'show all', 'list all', 'all communities', 'all active',
      'community list', 'active communities', 'what communities',
      'which communities', 'what are the communities',
      'show me communities', 'show communities', 'list communities'
    ]).map(p => p.toLowerCase().replace(/\s+/g, ' ').trim());
    return phrases.some(p => q.includes(p));
  }

  /**
   * LLM fallback for community name resolution.
   * Called only when word-matching returns no results — handles semantic synonyms
   * that no stemmer can cover (e.g. "jogging" → "Runners inc",
   * "photography" → "360 Pictures").
   */
  async _resolveCommunitiesWithLLM(query, communities) {
    if (!communities || communities.length === 0) return [];
    try {
      const nameList = communities
        .map(c => `${c.communityId}: ${c.name}`)
        .join('\n');

      const openai = createOpenAIClient();
      const response = await openai.chat.completions.create({
        model: getChatModelName('gpt-4o-mini'),
        messages: [{
          role: 'user',
          content: `You are matching a user's query to a list of Bosch workplace communities.\n\nAvailable communities (id: name):\n${nameList}\n\nUser query: "${query}"\n\nIdentify which community or communities the user is asking about. Consider synonyms, related words, and conceptual matches (e.g. "running" or "jogging" → "Runners inc", "photography" → "360 Pictures").\n\nReturn a JSON object: {"ids": [<matched community ids as numbers>]} — or {"ids": []} if nothing matches.`
        }],
        response_format: { type: 'json_object' },
        max_tokens: 100,
        temperature: 0
      });

      const result = JSON.parse(response.choices[0].message.content);
      const ids = Array.isArray(result.ids) ? result.ids.map(Number) : [];
      console.log(`[CommunityService] LLM resolved "${query}" → IDs: [${ids}]`);
      return communities.filter(c => ids.includes(Number(c.communityId)));
    } catch (err) {
      console.error('[CommunityService] LLM community resolution failed:', err.message);
      return [];
    }
  }

  async resolveSpecificCommunitiesFromQuery(query, communities) {
    const q = this.normalizeText(query);
    if (!q || !Array.isArray(communities) || communities.length === 0) {
      return [];
    }

    // Allow explicit CommunityId lookup in natural language.
    const idMatch = query.match(/community\s*id\s*[:=]?\s*(\d+)/i) || query.match(/\bid\s*[:=]?\s*(\d+)\b/i);
    if (idMatch) {
      const id = Number(idMatch[1]);
      const byId = communities.filter(c => Number(c.communityId) === id);
      if (byId.length > 0) return byId;
    }

    const genericWords = new Set([
      'community', 'communities', 'about', 'details', 'detail', 'information', 'info', 'tell', 'show', 'give',
      'me', 'the', 'for', 'of', 'on', 'in', 'at', 'to', 'please', 'available', 'active', 'join', 'register',
      'list', 'all', 'which', 'what', 'is', 'are', 'can', 'i',
      'inc', 'ltd', 'co', 'corp'
    ]);

    // Stem query words so semantic variants match (runner/running/runners → run)
    const queryWords = q
      .split(' ')
      .map(w => w.trim())
      .filter(w => w.length > 2 && !genericWords.has(w))
      .map(w => this._stemWord(w));

    const scored = communities
      .map(c => {
        const cname = this.normalizeText(c.name);
        if (!cname) return { c, score: 0 };

        if (q.includes(cname)) {
          return { c, score: 100 };
        }

        // Filter generic/org words and stem, so "Runners inc" → ["run"]
        const nameWords = cname
          .split(' ')
          .filter(w => w.length > 2 && !genericWords.has(w))
          .map(w => this._stemWord(w));
        const matches = nameWords.filter(w => queryWords.includes(w)).length;
        if (matches === 0) return { c, score: 0 };

        const score = Math.round((matches / Math.max(nameWords.length, 1)) * 80);
        return { c, score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      // Word matching found nothing — fall back to LLM for semantic synonym resolution
      return this._resolveCommunitiesWithLLM(query, communities);
    }

    // Return tied best matches, otherwise just top one.
    const topScore = scored[0].score;
    const nearTop = scored.filter(x => x.score >= topScore - 10 && x.score >= 50).map(x => x.c);
    return nearTop.length > 0 ? nearTop : [scored[0].c];
  }

  /**
   * Post a JSON-RPC payload to MCP endpoint candidates.
   */
  async postMcpPayload(payload, extraHeaders = {}, userId = 'default') {
    const mcpSessionId = this.userSessions.get(userId);
    const endpoints = [this.mcpUrl, ...this.getMcpEndpointCandidates()].filter(Boolean);
    const tried = new Set();
    let lastError = null;

    for (const endpoint of endpoints) {
      if (tried.has(endpoint)) continue;
      tried.add(endpoint);

      try {
        const response = await axios.post(endpoint, payload, {
          headers: {
            'Accept': 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            ...(mcpSessionId ? { 'mcp-session-id': mcpSessionId } : {}),
            ...extraHeaders
          },
          httpsAgent,
          timeout: 30000,
          transformResponse: [(data) => data]
        });

        this.mcpUrl = endpoint;
        const newSessionId = response.headers['mcp-session-id'] || response.headers['x-mcp-session-id'] || mcpSessionId;
        if (newSessionId) {
          this.userSessions.set(userId, newSessionId);
        }
        return response;
      } catch (error) {
        lastError = error;
        console.log(`[Community] MCP request failed at ${endpoint}: ${error.message}`);
      }
    }

    throw lastError || new Error('MCP request failed on all endpoints');
  }

  /**
   * Resolves the best available authorization header, falling back to service account if needed.
   * This mirrors the logic in travel-service.js to handle cases where user JWT minting fails.
   */
  async resolveSafeAuthToken(context = {}) {
    const { jwtToken, authToken, employeeNumber } = context;

    // Strategy 1: Raw OAuth token from frontend (Preferred for Community legacy APIs)
    if (authToken) {
      console.log(`[Community] Using direct OAuth authToken (Employee: ${employeeNumber})`);
      return this.normalizeAuthHeader(authToken);
    }

    // Strategy 2: Explicit JWT from server.js resolution
    if (jwtToken) {
      console.log(`[Community] Falling back to primary JWT token (Employee: ${employeeNumber})`);
      return this.normalizeAuthHeader(jwtToken);
    }

    // Strategy 3: Service Account Fallback
    console.log('[Community] No valid user tokens found. Requesting Service Account JWT fallback...');
    try {
      const serviceToken = await boschAuthService.getServiceToken();
      if (serviceToken) {
        console.log('[Community] Using Service Account JWT fallback (Votan)');
        return `Bearer ${serviceToken}`;
      }
    } catch (err) {
      console.error('[Community] Service Account fallback failed:', err.message);
    }

    return null;
  }

  /**
   * Ensure Authorization header uses Bearer scheme.
   */
  normalizeAuthHeader(authToken) {
    if (!authToken || typeof authToken !== 'string') return null;
    return authToken.toLowerCase().startsWith('bearer ') ? authToken : `Bearer ${authToken}`;
  }

  /**
   * Fetch community list from MCP Server or API
   */
  async getCommunityList(page = 1, pageSize = 10, context = {}) {
    const cacheKey = this.getCacheKey(page, pageSize);
    const cached = this.cache.get(cacheKey);

    if (this.isCacheValid(cached)) {
      console.log('[Community] Returning cached data');
      return cached.data;
    }

    try {
      console.log(`[Community] Fetching community list: page=${page}, pageSize=${pageSize}`);

      // Strategy 1-3: Resolve safe auth header
      const authHeader = await this.resolveSafeAuthToken(context);

      // Prepare headers
      const identityHeaders = {
        'X-Employee-Number': String(context.employeeNumber || ''),
        'X-User-Name': String(context.userName || 'Bosch User')
      };

      if (authHeader) {
        identityHeaders['Authorization'] = authHeader;
      }

      // Initialize session if needed
      const userId = context.employeeNumber || 'default';
      if (!this.userSessions.get(userId)) {
        try {
          await this.initializeMCPSession(userId);
        } catch (initErr) {
          console.log(`[Community] Continuing without MCP session for ${userId}`);
        }
      }

      // Call FastMCP tool: get_community_list (no arguments)
      const toolCallPayload = {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "get_community_list",
          arguments: {}
        },
        id: Date.now()
      };

      let response;
      try {
        response = await this.postMcpPayload(toolCallPayload, identityHeaders, userId);

        console.log('[Community] MCP response received — HTTP status:', response.status);
        console.log('[Community] MCP raw response (first 500 chars):', String(response.data || '').substring(0, 500));
        const data = this.parseMcpToolResponse(response.data);
        const communities = this.flattenCommunities(data);
        console.log(`[Community] get_community_list parsed — total communities: ${communities.length}`);
        if (communities.length > 0) {
          console.log('[Community] Community names:', communities.map(c => c.name).join(', '));
        }

        // Cache the response
        this.cache.set(cacheKey, {
          data,
          timestamp: Date.now()
        });

        return data;
      } catch (mcpError) {
        console.log(`[Community] MCP failed for ${userId}: ${mcpError.message}, trying legacy API`);
        // Reset session on failure
        this.userSessions.delete(userId);

        // Fallback to legacy Bosch Arena API
        const legacyUrl = this.communityBaseUrl + 'communityplanet/getcommunitylist';
        response = await axios.get(legacyUrl, {
          params: { page, pageSize },
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json, text/plain, */*',
          },
          httpsAgent,
          timeout: 30000
        });

        const data = response.data;

        // Cache the response
        this.cache.set(cacheKey, {
          data,
          timestamp: Date.now()
        });

        return data;
      }
    } catch (error) {
      console.error('[Community] API error:', error.message);

      // Return cached data if available
      if (cached) {
        console.log('[Community] Returning expired cache due to error');
        return cached.data;
      }

      throw new Error(`Failed to fetch community list: ${error.message}`);
    }
  }

  /**
   * Fetches the list of communities the logged-in user is already registered to.
   * Calls GET /api/CommunityPlanet/GetRegisteredCommunityList with the user's auth token.
   */
  async getRegisteredCommunityList(context = {}) {
    try {
      console.log('[Community] Fetching registered community list for user');
      const authHeader = await this.resolveSafeAuthToken(context);

      const identityHeaders = {
        'X-Employee-Number': String(context.employeeNumber || ''),
        'X-User-Name': String(context.userName || 'Bosch User'),
        'content-type': 'application/json'
      };
      if (authHeader) identityHeaders['Authorization'] = authHeader;

      const url = this.communityBaseUrl + 'CommunityPlanet/GetRegisteredCommunityList';
      const response = await axios.get(url, {
        headers: identityHeaders,
        httpsAgent,
        timeout: 30000
      });

      const data = response.data;
      // ── Diagnostic logging — shows exact API response shape ───────────────
      // Check backend console for "[Community] REGISTERED RAW" to identify
      // the correct field names, then remove these logs once confirmed.
      try {
        const preview = JSON.stringify(data).substring(0, 800);
        console.log('[Community] REGISTERED RAW (first 800 chars):', preview);
        const rd = data?.ResponseData;
        if (Array.isArray(rd) && rd.length > 0) {
          console.log('[Community] REGISTERED ResponseData[0] keys:', Object.keys(rd[0]));
          console.log('[Community] REGISTERED ResponseData[0] sample:', JSON.stringify(rd[0]).substring(0, 300));
        }
      } catch (_) { /* ignore logging errors */ }
      // ─────────────────────────────────────────────────────────────────────
      console.log('[Community] GetRegisteredCommunityList response received');
      return data;
    } catch (error) {
      console.error('[Community] getRegisteredCommunityList error:', error.message);
      throw new Error(`Failed to fetch registered communities: ${error.message}`);
    }
  }

  /**
   * Register user to a community through MCP tool register_user_to_community.
   */
  async registerUserToCommunity(communityId, locationId, context = {}) {
    if (!Number.isInteger(communityId) || !Number.isInteger(locationId)) {
      throw new Error('communityId and locationId must be integers');
    }

    const tokenSource = context.jwtToken ? 'JWT' : (context.authToken ? 'OAuth' : 'None');
    console.log(`[Community] Registering with token source: ${tokenSource}`);

    // Strategy 1-3: Resolve safe auth header (with service account fallback)
    const authHeader = await this.resolveSafeAuthToken(context);

    if (!authHeader) {
      console.error('[Community] No authorization token found in context:', Object.keys(context));
      throw new Error('Authorization token is required to register to a community');
    }

    console.log(`[Community] Auth header length: ${authHeader.length}`);
    console.log(`[Community] Auth header sample: ${authHeader.substring(0, 15)}...${authHeader.substring(authHeader.length - 5)}`);

    // Prepare extra identity headers for the MCP server
    const identityHeaders = {
      'Authorization': authHeader,
      'X-Employee-Number': String(context.employeeNumber || ''),
      'X-User-Name': String(context.userName || 'Bosch User')
    };

    const userId = context.employeeNumber || 'default';
    if (!this.userSessions.get(userId)) {
      try {
        await this.initializeMCPSession(userId);
      } catch (initErr) {
        console.log(`[Community] Continuing registration without MCP session for ${userId}`);
      }
    }

    const payload = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'register_user_to_community',
        arguments: {
          community_id: communityId,
          location_id: locationId
        }
      },
      id: Date.now()
    };

    console.log(`[Community] Calling tool: register_user_to_community (ID: ${communityId}, Location: ${locationId})`);
    console.log(`[Community] Identity: Employee=${identityHeaders['X-Employee-Number']}, User=${identityHeaders['X-User-Name']}`);
    if (identityHeaders['Authorization']) {
      const auth = identityHeaders['Authorization'];
      console.log(`[Community] Auth Type: ${auth.split(' ')[0]}, Length: ${auth.length}`);
    }

    try {
      const response = await this.postMcpPayload(payload, identityHeaders, userId);
      console.log('[Community] Registration tool response received — HTTP status:', response.status);
      console.log('[Community] Registration raw response (first 500 chars):', String(response.data || '').substring(0, 500));
      const parsed = this.parseMcpToolResponse(response.data);
      console.log('[Community] Registration parsed response:', JSON.stringify(parsed, null, 2));
      return parsed;
    } catch (error) {
      console.warn('[Community] Registration attempt 1 failed:', error.message, '— retrying with fresh session');
      // Session can expire; retry once with a fresh session
      this.userSessions.delete(userId);
      try {
        await this.initializeMCPSession(userId);
      } catch (initErr) {
        console.log(`[Community] Retry registration without MCP session for ${userId}`);
      }
      const retryResponse = await this.postMcpPayload(payload, identityHeaders, userId);
      console.log('[Community] Registration retry response — HTTP status:', retryResponse.status);
      console.log('[Community] Registration retry raw response (first 500 chars):', String(retryResponse.data || '').substring(0, 500));
      const retryParsed = this.parseMcpToolResponse(retryResponse.data);
      console.log('[Community] Registration retry parsed response:', JSON.stringify(retryParsed, null, 2));
      return retryParsed;
    }
  }

  /**
   * Format community data for display
   */
  formatCommunityResponse(data, query, options = {}) {
    console.log('Community API response structure:', JSON.stringify(data, null, 2).substring(0, 500));

    const communities = Array.isArray(options.communitiesOverride)
      ? options.communitiesOverride
      : this.flattenCommunities(data);
    const totalCount = communities.length;

    console.log(`Found ${communities.length} communities`);

    if (communities.length === 0) {
      return "I couldn't find any community information at the moment. Please try again later.";
    }

    const showFull = options.specificView || options.showAll;
    const heading = options.specificView
      ? '👥 **Community Details**\n\nHere is what I found:\n\n'
      : options.showAll
        ? (options.membershipQuery
          ? `👥 **Your Registered Communities** (${totalCount})\n\nHere are the communities you are currently registered to:\n\n`
          : options.unregisteredQuery
            ? `👥 **Communities You Haven't Joined Yet** (${totalCount})\n\nHere are the Bosch communities you are not yet registered to:\n\n`
            : `👥 **Bosch Communities** (${totalCount} active)\n\nHere are all the available communities with details:\n\n`)
        : '👥 **Bosch Communities**\n\nHere are the available communities:\n\n';
    let response = heading;

    const displayLimit = showFull ? communities.length : Math.min(10, communities.length);
    communities.slice(0, displayLimit).forEach((community, index) => {
      const name = community.name || `Community ${index + 1}`;
      const communityId = community.communityId ?? 'N/A';
      response += `**${index + 1}. ${name}** (CommunityId: ${communityId})\n`;

      const desc = community.description;
      if (desc) {
        if (showFull) {
          response += `   ${desc}\n`;
        } else {
          const cleanDesc = desc.substring(0, 100);
          response += `   ${cleanDesc}${desc.length > 100 ? '...' : ''}\n`;
        }
      }

      const members = community.members;
      if (members) {
        response += `   👥 Members: ${members}\n`;
      }

      if (Array.isArray(community.locations) && community.locations.length > 0) {
        const locationText = community.locations
          .map(l => `${l.name || 'Unknown'} (LocationId: ${l.id ?? 'N/A'})`)
          .join(', ');
        response += `   📍 Locations: ${locationText}\n`;
      }

      response += '\n';
    });

    if (!showFull && totalCount > 10) {
      response += `\n_Showing 10 of ${totalCount} communities. Ask "show me all communities" to see the full list._`;
    }

    response += '\n\nTo join, click the **Join** button on a community card, or type naturally like: "join Art in Motion Community in Bangalore".';

    return response;
  }

  /**
   * Classify the user's community query intent using few-shot LLM prompting.
   * Returns one of: 'join' | 'list' | 'info' | 'general'
   * Falls back to keyword matching if the LLM call fails.
   */
  async classifyQueryIntent(query) {
    const examples = configService.getFewShotConfigSync().community || [];
    const exampleLines = examples.map(e => `Q: "${e.query}" → {"intent":"${e.intent}"}`).join('\n');

    const systemPrompt = `You are an intent classifier for a workplace community assistant at Bosch.
Classify the user query into exactly one of these six intents:
- "join"         : user wants to join or register for a specific community
- "list"         : user wants to browse or discover ALL available communities (not asking about their own membership)
- "membership"   : user is asking which communities THEY are currently part of, belong to, have joined, or are registered in
- "unregistered" : user is asking which communities they are NOT registered in / have NOT joined yet (contains negation like "not part of", "not registered", "haven't joined", "not a member of")
- "info"         : user wants details or information about a specific named community
- "general"      : any other community-related query

Key distinction — membership vs unregistered:
  "which communities am I part of"        → membership   (positive — what they HAVE joined)
  "communities I am NOT part of"          → unregistered (negated — what they HAVE NOT joined)
  "communities I am not registered in"    → unregistered
  "communities which I am not registered" → unregistered
  "communities I haven't joined"          → unregistered
  "show my communities"                   → membership
  "what communities have I joined"        → membership

Built-in examples:
Q: "any community I am not part of" → {"intent":"unregistered"}
Q: "communities I am not registered in" → {"intent":"unregistered"}
Q: "communities which I am not registered" → {"intent":"unregistered"}
Q: "communities I haven't joined yet" → {"intent":"unregistered"}
Q: "which communities have I not joined" → {"intent":"unregistered"}
Q: "communities not in my list" → {"intent":"unregistered"}
Q: "which communities am I part of" → {"intent":"membership"}
Q: "show my registered communities" → {"intent":"membership"}
Q: "communities I belong to" → {"intent":"membership"}
Q: "show all communities" → {"intent":"list"}
Q: "join Runners inc in Bangalore" → {"intent":"join"}
Q: "is Runners community available" → {"intent":"info"}

Admin-configured examples (override built-ins on conflict):
${exampleLines}

Respond with ONLY valid JSON, no explanation: {"intent":"join"|"list"|"membership"|"unregistered"|"info"|"general"}`;

    try {
      const response = await this.openai.chat.completions.create({
        model: getChatModelName('gpt-4o-mini'),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query }
        ],
        max_tokens: 20,
        temperature: 0
      });

      const raw = response.choices[0].message.content.trim();
      const parsed = JSON.parse(raw);
      const valid = ['join', 'list', 'membership', 'unregistered', 'info', 'general'];
      if (valid.includes(parsed.intent)) {
        console.log(`[Community] LLM intent: "${parsed.intent}" for query: "${query}"`);
        return parsed.intent;
      }
    } catch (e) {
      console.warn('[Community] LLM intent classification failed, using keyword fallback:', e.message);
    }

    return this.classifyQueryIntentFallback(query);
  }

  /**
   * Keyword-based intent fallback used when the LLM call fails.
   */
  classifyQueryIntentFallback(query) {
    const lowerQuery = query.toLowerCase();

    // Unregistered queries — check BEFORE membership (more specific)
    if (this._isUnregisteredQuery(query)) return 'unregistered';

    // Membership queries ("which communities am I part of", "communities I belong to", "my communities")
    if (this._isMembershipQuery(query)) return 'membership';

    if (this.shouldShowAllCommunities(query) || lowerQuery.includes('all')) return 'list';

    // Static literal — never constructed from external data (fixes jssecurity:S2631)
    const hasJoinWordBuiltin = /\b(?:join|register|enroll?|subscribe|add\s+me|sign\s+me\s+up)\b/i.test(lowerQuery);
    // Config-extended keywords use plain string matching so no RegExp is constructed from external input
    const configKws = (configService.getKeywordConfigSync().communityService.joinIntentKeywords || [])
      .filter(k => typeof k === 'string' && /^[\w\s]+$/.test(k.trim()))
      .map(k => k.trim().toLowerCase());
    const hasJoinWordConfig = configKws.some(kw => {
      let i = lowerQuery.indexOf(kw);
      while (i !== -1) {
        if ((i === 0 || !/\w/.test(lowerQuery[i - 1]))
          && (i + kw.length === lowerQuery.length || !/\w/.test(lowerQuery[i + kw.length]))) {
          return true;
        }
        i = lowerQuery.indexOf(kw, i + 1);
      }
      return false;
    });
    const hasJoinWord = hasJoinWordBuiltin || hasJoinWordConfig;
    const isDiscovery = /\b(which|what|show|list|available|active|how to|where)\b.*\b(join|register|enroll)\b/i.test(lowerQuery)
      || /\b(join|register|enroll)\b.*\b(which|what|available|active|communities?|all)\b/i.test(lowerQuery)
      || /\b(join|register|enroll)\s+(a\s+)?community\b$/i.test(lowerQuery.trim());
    if (hasJoinWord && !isDiscovery) return 'join';

    if (/\b(?:tell|info|information|details?|about|describe)\b.*\bcommunity\b/i.test(lowerQuery)
      || /\bcommunity\b.*\b(?:tell|info|information|details?|about|describe)\b/i.test(lowerQuery)
      || /\b(?:tell me about|info on|details of|information on|describe)\s+\w+/i.test(lowerQuery)) {
      return 'info';
    }

    // Availability checks — "is X community available", "is there a hockey community",
    // "do you have X", "does X community exist" — treat as info lookup.
    if (/\b(is|are|does|do\s+you\s+have|is\s+there)\b/i.test(lowerQuery)
      && /\bcommunity\b/i.test(lowerQuery)) {
      return 'info';
    }

    return 'general';
  }

  /**
   * Returns true when the query is a membership/belonging query
   * (e.g. "which communities am I part of", "communities I belong to").
   * These should be treated as list queries, not specific-community lookups.
   */
  _isMembershipQuery(query) {
    return /\b(part\s+of|belong\s+to|member\s+of|enrolled\s+in|subscribed\s+to|affiliated\s+with|my\s+communit(y|ies)|communities\s+(i\s+)?(belong|joined|enrolled|am\s+part)|am\s+part|registered\s+(communities|community)|my\s+registered|show\s+(my\s+)?registered|communities\s+i\s+(have\s+)?(signed|registered|joined)|my\s+membership|show\s+my\s+communit(y|ies)|which\s+communit(y|ies)\s+(am\s+i|i\s+am)|communit(y|ies)\s+i\s+joined)\b/i.test(query);
  }

  /**
   * Returns true when the query asks for communities the user is NOT registered in.
   */
  _isUnregisteredQuery(query) {
    return /\b(not\s+(yet\s+)?(registered|joined|enrolled|a\s+member|part\s+of|subscribed)|haven'?t\s+(joined|enrolled|registered)|not\s+in\s+my\s+(list|communities)|communities?\s+(i\s+)?(am\s+)?not|yet\s+to\s+join|unregistered|communities?\s+outside)\b/i.test(query);
  }

  /**
   * Returns true when the query contains at least one non-generic word that
   * indicates the user is asking about a specifically named community.
   * Used to decide whether a zero-match result means "not found" vs "show list".
   */
  _hasSpecificSearchTerms(query) {
    if (this._isMembershipQuery(query)) return false;
    const q = this.normalizeText(query);
    const generic = new Set([
      'community', 'communities', 'about', 'details', 'information', 'tell', 'show',
      'give', 'me', 'my', 'the', 'for', 'of', 'on', 'in', 'at', 'to', 'please', 'available',
      'active', 'list', 'all', 'which', 'what', 'is', 'are', 'can', 'bosch', 'bgsw',
      'there', 'any', 'you', 'have', 'does', 'exist', 'check', 'find', 'search', 'join',
      'register', 'registered', 'registration', 'currently', 'current', 'see', 'get',
      'and', 'or', 'not', 'how', 'when', 'where', 'do', 'its', 'hi', 'hey', 'hello',
      // membership/belonging words — not community names
      'part', 'belong', 'belonging', 'member', 'enrolled', 'subscribed', 'affiliated', 'mine', 'signed'
    ]);
    const words = q.split(' ').filter(w => w.length > 2 && !generic.has(w));
    return words.length > 0;
  }

  /**
   * Extracts the non-generic words from a community query to use in the
   * "not found" message (e.g. "hockey" from "Is hockey community available").
   */
  _extractSearchedCommunityName(query) {
    const q = this.normalizeText(query);
    const generic = new Set([
      'community', 'communities', 'about', 'details', 'information', 'tell', 'show',
      'give', 'me', 'my', 'the', 'for', 'of', 'on', 'in', 'at', 'to', 'please', 'available',
      'active', 'list', 'all', 'which', 'what', 'is', 'are', 'can', 'bosch', 'bgsw',
      'there', 'any', 'you', 'have', 'does', 'exist', 'check', 'find', 'search', 'join',
      'register', 'registered', 'registration', 'currently', 'current', 'see', 'get',
      'and', 'or', 'not', 'how', 'when', 'where', 'do', 'its', 'hi', 'hey', 'hello',
      // membership/belonging words — not community names
      'part', 'belong', 'belonging', 'member', 'enrolled', 'subscribed', 'affiliated', 'mine', 'signed'
    ]);
    const words = q.split(' ').filter(w => w.length > 2 && !generic.has(w));
    return words.length > 0 ? words.join(' ') : null;
  }

  /**
   * Process a community-related query
   */
  async processQuery(query, context = {}) {
    try {
      const lowerQuery = query.toLowerCase();

      // Let the LLM classify everything — it understands negation, synonyms and
      // phrasing variations far better than any regex chain.  The regex helpers
      // (_isMembershipQuery, _isUnregisteredQuery) are kept only as the fallback
      // inside classifyQueryIntentFallback() for when the LLM call fails.
      const intent = await this.classifyQueryIntent(query);
      const isRegistrationIntent = intent === 'join';
      const isMembershipIntent   = intent === 'membership';
      const isUnregisteredIntent = intent === 'unregistered';
      const listIntent           = intent === 'list';
      const isSpecificCommunityQuery = intent === 'info';

      // Handle join request via MCP tool register_user_to_community
      if (isRegistrationIntent) {
        const data = await this.getCommunityList(1, 50, context);
        const communities = this.flattenCommunities(data);
        const resolved = await this.resolveRegistrationFromQuery(query, communities);

        if (!resolved.community) {
          // No specific community name in the query — show the list so the user can pick one
          if (!this._hasSpecificSearchTerms(query)) {
            const listResponse = this.formatCommunityResponse(data, query, { communitiesOverride: communities });
            return {
              success: true,
              response: `Here are the available communities you can join:\n\n${listResponse}\n\nWhich community would you like to join?`,
              data,
              page: 1,
              pageSize: 50
            };
          }
          return {
            success: true,
            response: `Sorry, I don't have any information about that community. It may not exist in Bosch.`,
            data,
            page: 1,
            pageSize: 50
          };
        }

        if (!resolved.location) {
          const locations = (resolved.community.locations || [])
            .map(l => `- ${l.name} (LocationId: ${l.id})`)
            .join('\n');
          return {
            success: true,
            response: `I found the community **${resolved.community.name}** (CommunityId: ${resolved.community.communityId}), but I need the location. Please pick one of these locations:\n${locations}\n\nExample: join ${resolved.community.name} in Bengaluru`,
            data,
            page: 1,
            pageSize: 50
          };
        }

        const joinData = await this.registerUserToCommunity(
          Number(resolved.community.communityId),
          Number(resolved.location.id),
          context
        );

        // Parse the registration response
        let joinResponse;
        const parsed = typeof joinData === 'string' ? this.tryParseJson(joinData) : joinData;
        console.log('[Community] Registration Tool Raw Response:', JSON.stringify(parsed, null, 2));
        let isJoinSuccess = false;

        const msg = (parsed && (parsed.Message || parsed.ErrorMessage)) || '';
        const isAlreadyMember = /already\s+(registered|member|exists|enrolled|joined)/i.test(msg);
        // Detect auth/token failures — Bosch API returns these as 401 or in the error message
        const isAuthError = /invalid token|authorization has been denied|unauthorized|authentication failed|access denied/i.test(msg);

        if (isAlreadyMember) {
          joinResponse = `ℹ️ You are already a registered member of **${resolved.community.name}** (CommunityId: ${resolved.community.communityId}).`;
          isJoinSuccess = false; // Prevent +1 increment
        } else if (parsed && parsed.IsSuccess) {
          isJoinSuccess = true;
          joinResponse = `✅ You have been successfully registered to **${resolved.community.name}** at **${resolved.location.name}** (CommunityId: ${resolved.community.communityId}, LocationId: ${resolved.location.id}).`;
        } else if (isAuthError) {
          // Token expired or invalid — guide the user to re-login instead of showing the raw Bosch error
          console.warn('[Community] Registration blocked by auth error:', msg);
          joinResponse = `🔒 **Registration Failed — Session Expired**\n\nYour login session could not be verified by the community service. This usually means your session has expired.\n\nPlease **refresh the page and log in again**, then try joining **${resolved.community.name}** once more.`;
        } else if (parsed && (parsed.Message || parsed.ErrorMessage)) {
          joinResponse = `❌ Registration for **${resolved.community.name}** at **${resolved.location.name}** was not successful: ${msg}`;
        } else {
          const joinText = typeof joinData === 'string' ? joinData : JSON.stringify(joinData);
          joinResponse = `Registration submitted for **${resolved.community.name}** at **${resolved.location.name}** (CommunityId: ${resolved.community.communityId}, LocationId: ${resolved.location.id}).\n\nResponse: ${joinText}`;
        }

        let returnData;
        if (isJoinSuccess) {
          returnData = await this.applyOptimisticUpdate(Number(resolved.community.communityId), context);
          joinResponse += '\n\n_Note: The member count has been updated in your view to reflect your registration._';
        } else if (!isAuthError) {
          returnData = await this.getCommunityList(1, 50, context);
        }

        // Auth errors are hard failures — return success:false so server.js
        // skips saving the error to conversation history (keeps history clean
        // so the next attempt isn't confused by a stale failed-auth message).
        console.log(`[Community] join flow final response (isSuccess=${isJoinSuccess}, isAuthError=${isAuthError}, isAlreadyMember=${isAlreadyMember}):`);
        console.log('[Community] Join response text:', joinResponse);
        return {
          success: isAuthError ? false : true,
          response: joinResponse,
          data: returnData,
          page: 1,
          pageSize: 50
        };
      }

      let page = 1;
      let pageSize = 10;

      // Check if user wants more results
      if (lowerQuery.includes('more') || lowerQuery.includes('next')) {
        page = (context.communityPage || 1) + 1;
      }

      // Fetch all communities when user wants the full list
      if (listIntent || lowerQuery.includes('all')) {
        pageSize = 50;
      }

      const data = await this.getCommunityList(page, pageSize, context);
      const communities = this.flattenCommunities(data);
      const matches = await this.resolveSpecificCommunitiesFromQuery(query, communities);

      // isSpecificCommunityQuery is set by the LLM classifier above (intent === 'info')

      // Structural availability check: "is X community available", "is there a X",
      // "do you have X community" — reliable regardless of LLM intent.
      const isAvailabilityCheck = /\b(is|are|does|do\s+you\s+have|is\s+there)\b/i.test(query)
        && /\bcommunity\b/i.test(query);

      // Treat as a specific-community lookup when:
      //   - The query is an explicit availability check (overrides listIntent), OR
      //   - The query has an actual non-generic search term (community name present).
      // NOTE: The LLM intent="info" alone is NOT sufficient — the query must also
      // contain a recognisable non-generic word. This prevents vague queries like
      // "my community" or "show my community" (no named community) from hitting the
      // "not found" path when the LLM misclassifies them as info intent.
      const isSpecificSearch = isAvailabilityCheck
        || (!listIntent && this._hasSpecificSearchTerms(query));

      let response;
      // ── isUnregisteredIntent is checked FIRST — before isSpecificSearch ────
      // Words like "not" or "yet" in the query would otherwise fool
      // _hasSpecificSearchTerms into treating the query as a named-community lookup,
      // landing it on the "not found" path.
      if (isUnregisteredIntent) {
        // User wants communities they are NOT yet registered in.
        // Fetch all communities + registered communities, then return the difference.
        try {
          const allData        = await this.getCommunityList(1, 50, context);
          const allCommunities = this.flattenCommunities(allData);

          let registeredIds = new Set();
          try {
            const registeredData        = await this.getRegisteredCommunityList(context);
            const registeredCommunities = this.flattenCommunities(registeredData);
            registeredIds = new Set(registeredCommunities.map(c => Number(c.communityId)));
            console.log(`[Community] Registered IDs for unregistered diff: [${[...registeredIds].join(', ')}]`);
          } catch (regErr) {
            console.warn('[Community] Could not fetch registered list for unregistered diff — showing all communities:', regErr.message);
          }

          const unregistered = allCommunities.filter(c => !registeredIds.has(Number(c.communityId)));
          console.log(`[Community] Unregistered communities: ${unregistered.length} of ${allCommunities.length} total`);

          if (unregistered.length === 0) {
            response = "🎉 **All communities joined!**\n\nYou are already registered to all available communities at Bosch. Nothing left to join!";
          } else {
            response = this.formatCommunityResponse(allData, query, {
              showAll: true,
              communitiesOverride: unregistered,
              unregisteredQuery: true
            });
          }
        } catch (err) {
          console.error('[Community] Unregistered query failed:', err.message);
          response = "I'm having trouble retrieving community data right now. Please try again later.";
        }
      } else if (isSpecificSearch) {
        if (matches.length === 1) {
          response = this.formatCommunityResponse(data, query, {
            communitiesOverride: matches,
            specificView: true
          });
        } else if (matches.length > 1) {
          response = this.formatCommunityResponse(data, query, {
            communitiesOverride: matches,
            specificView: true
          });
          response += '\n\nI found multiple close matches. Please mention the exact community name if you want just one.';
        } else {
          // No match found — show a clean "not available" message only.
          const searchedName = this._extractSearchedCommunityName(query);
          const namePart = searchedName ? `The **${searchedName}** community` : 'That community';
          response = `👥 **Community Not Found**\n\n${namePart} is not available at Bosch.`;
        }
      } else if (isMembershipIntent) {
        // User is asking which communities they are registered to — use the dedicated API
        try {
          const registeredData = await this.getRegisteredCommunityList(context);
          const registeredCommunities = this.flattenCommunities(registeredData);
          if (registeredCommunities.length === 0) {
            response = "👥 **Your Communities**\n\nYou are not registered to any communities yet. You can ask me to show all available communities and join one!";
          } else {
            response = this.formatCommunityResponse(registeredData, query, {
              showAll: true,
              communitiesOverride: registeredCommunities,
              membershipQuery: true
            });
          }
        } catch (regErr) {
          console.warn('[Community] getRegisteredCommunityList failed, falling back to full list:', regErr.message);
          response = this.formatCommunityResponse(data, query, { showAll: true, membershipQuery: true });
        }
      } else if (listIntent) {
        response = this.formatCommunityResponse(data, query, { showAll: true });
      } else {
        response = this.formatCommunityResponse(data, query);
      }

      console.log(`[Community] processQuery final response (intent="${intent}", matches=${matches.length}, communities=${communities.length}):`);
      console.log('[Community] Response text (first 300 chars):', response.substring(0, 300));

      return {
        success: true,
        response,
        data,
        page,
        pageSize
      };
    } catch (error) {
      console.error('Community query error:', error);
      return {
        success: false,
        response: `I'm having trouble accessing community information right now. Error: ${error.message}`,
        error: error.message
      };
    }
  }

  /**
   * Refreshes the community list after a successful join so the UI reflects
   * the authoritative member count returned by the API.
   *
   * Previously this method applied a client-side +1 on top of a freshly
   * fetched list, which double-counted (API already reflected the new
   * member, then we added another). The API is authoritative — just clear
   * the cache and return the latest data.
   */
  async applyOptimisticUpdate(targetId, context = {}) {
    console.log(`[Community] Refreshing community list after join for ID: ${targetId}`);
    this.cache.clear();
    // Re-warm the two most common page sizes so the next request hits cache
    const [data] = await Promise.all([
      this.getCommunityList(1, 50, context),
      this.getCommunityList(1, 10, context)
    ]);
    return data;
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    return { cleared: true };
  }
}

module.exports = new CommunityService();
