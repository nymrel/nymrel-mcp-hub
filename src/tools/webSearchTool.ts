import { MCPToolDefinition, ToolExecutionResult } from '../types/index.js';

type Provider = 'exa' | 'tavily' | 'brave' | 'serpapi';
type SearchProvider = 'auto' | Provider;
type SearchMode = 'search' | 'research' | 'serp_exact';

export interface WebSearchArgs {
  query: string;
  provider?: SearchProvider;
  mode?: SearchMode;
  maxResults?: number;
  language?: string;
  country?: string;
  freshnessDays?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface WebSearchRuntime {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

const PROVIDERS: Provider[] = ['exa', 'tavily', 'brave', 'serpapi'];
const ENV_KEY: Record<Provider, string> = {
  exa: 'EXA_API_KEY',
  tavily: 'TAVILY_API_KEY',
  brave: 'BRAVE_SEARCH_API_KEY',
  serpapi: 'SERPAPI_API_KEY'
};

export const webSearchToolDefinition: MCPToolDefinition = {
  name: 'nymrel_web_search',
  description:
    'Search the public web through a normalized studio gateway. Uses server-side Exa, Tavily, Brave Search, or SerpAPI credentials and fails closed rather than fabricating results.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, description: 'Public-web search query.' },
      provider: {
        type: 'string',
        enum: ['auto', 'exa', 'tavily', 'brave', 'serpapi'],
        default: 'auto'
      },
      mode: {
        type: 'string',
        enum: ['search', 'research', 'serp_exact'],
        default: 'search'
      },
      maxResults: { type: 'number', default: 8, description: 'Executor enforces 1-20.' },
      language: { type: 'string', description: 'Preferred language, e.g. en.' },
      country: { type: 'string', description: 'Preferred ISO alpha-2 country, e.g. US.' },
      freshnessDays: { type: 'number', description: 'Optional freshness window in days.' },
      includeDomains: { type: 'array', items: { type: 'string' } },
      excludeDomains: { type: 'array', items: { type: 'string' } }
    },
    required: ['query'],
    additionalProperties: false
  }
};

function error(textValue: string): ToolExecutionResult {
  return { isError: true, content: [{ type: 'text', text: textValue }] };
}

function cleanDomains(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('Domain filters must be arrays of strings.');
  }
  return [...new Set(value.map((item) => {
    const raw = (item as string).trim().toLowerCase().replace(/^https?:\/\//, '');
    return raw.replace(/^www\./, '').split('/')[0];
  }).filter(Boolean))];
}

function validate(args: WebSearchArgs) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) throw new Error('query must be a non-empty string.');

  const provider = (args.provider ?? 'auto') as SearchProvider;
  if (!['auto', ...PROVIDERS].includes(provider)) throw new Error('Unsupported provider.');

  const mode = (args.mode ?? 'search') as SearchMode;
  if (!['search', 'research', 'serp_exact'].includes(mode)) throw new Error('Unsupported mode.');

  const maxResults = args.maxResults ?? 8;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 20) {
    throw new Error('maxResults must be an integer from 1 through 20.');
  }

  const freshnessDays = args.freshnessDays;
  if (freshnessDays !== undefined &&
      (!Number.isInteger(freshnessDays) || freshnessDays < 1 || freshnessDays > 3650)) {
    throw new Error('freshnessDays must be an integer from 1 through 3650.');
  }

  const country = typeof args.country === 'string' ? args.country.trim().toUpperCase() : undefined;
  if (country && !/^[A-Z]{2}$/.test(country)) {
    throw new Error('country must be a two-letter code such as US.');
  }

  return {
    query,
    provider,
    mode,
    maxResults,
    language: typeof args.language === 'string' ? args.language.trim().toLowerCase() || undefined : undefined,
    country,
    freshnessDays,
    includeDomains: cleanDomains(args.includeDomains),
    excludeDomains: cleanDomains(args.excludeDomains)
  };
}

function order(provider: SearchProvider, mode: SearchMode): Provider[] {
  if (provider !== 'auto') return [provider];
  return mode === 'serp_exact'
    ? ['serpapi', 'brave', 'exa', 'tavily']
    : ['exa', 'tavily', 'brave', 'serpapi'];
}

async function jsonRequest(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const raw = await response.text();
    let body: any = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = raw; }
    if (!response.ok) {
      const detail = typeof body === 'string'
        ? body
        : body?.message ?? body?.error ?? body?.detail?.error ?? body?.detail ?? 'provider error';
      throw new Error(`HTTP ${response.status}: ${String(detail).slice(0, 500)}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function normalized(rank: number, row: any, provider: Provider) {
  const url = provider === 'serpapi' ? row.link : row.url;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  const snippet = provider === 'tavily'
    ? row.content
    : provider === 'brave'
      ? row.description
      : provider === 'serpapi'
        ? row.snippet
        : row.summary ?? row.text ?? row.highlights?.[0];
  const publishedAt = provider === 'exa'
    ? row.publishedDate
    : provider === 'tavily'
      ? row.published_date
      : provider === 'brave'
        ? row.page_age ?? row.age
        : row.date;
  const out: Record<string, any> = {
    rank,
    title: typeof row.title === 'string' ? row.title.trim() : '',
    url,
    snippet: typeof snippet === 'string' ? snippet.trim() : ''
  };
  if (typeof publishedAt === 'string' && publishedAt.trim()) out.publishedAt = publishedAt.trim();
  if (typeof row.score === 'number' && Number.isFinite(row.score)) out.score = row.score;
  return out;
}

function dateStart(now: Date, days?: number): Date | undefined {
  return days ? new Date(now.getTime() - days * 86_400_000) : undefined;
}

function braveFreshness(days?: number) {
  if (!days) return undefined;
  if (days <= 1) return 'pd';
  if (days <= 7) return 'pw';
  if (days <= 31) return 'pm';
  if (days <= 365) return 'py';
  return undefined;
}

function serpFreshness(days?: number) {
  if (!days) return undefined;
  if (days <= 1) return 'qdr:d';
  if (days <= 7) return 'qdr:w';
  if (days <= 31) return 'qdr:m';
  if (days <= 365) return 'qdr:y';
  return undefined;
}

async function callProvider(
  provider: Provider,
  args: ReturnType<typeof validate>,
  key: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  now: Date
) {
  let body: any;

  if (provider === 'exa') {
    const payload: Record<string, any> = { query: args.query, numResults: args.maxResults };
    if (args.includeDomains.length) payload.includeDomains = args.includeDomains;
    if (args.excludeDomains.length) payload.excludeDomains = args.excludeDomains;
    const start = dateStart(now, args.freshnessDays);
    if (start) payload.startPublishedDate = start.toISOString();
    body = await jsonRequest(fetchImpl, 'https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify(payload)
    }, timeoutMs);
  } else if (provider === 'tavily') {
    const payload: Record<string, any> = {
      query: args.query,
      search_depth: args.mode === 'research' ? 'advanced' : 'basic',
      max_results: args.maxResults,
      include_published_date: true,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      safe_search: true
    };
    if (args.includeDomains.length) payload.include_domains = args.includeDomains;
    if (args.excludeDomains.length) payload.exclude_domains = args.excludeDomains;
    if (args.language) {
      payload.language = args.language;
      payload.filter_by_language = true;
    }
    const start = dateStart(now, args.freshnessDays);
    if (start) payload.start_date = start.toISOString().slice(0, 10);
    body = await jsonRequest(fetchImpl, 'https://api.tavily.com/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, timeoutMs);
  } else if (provider === 'brave') {
    const params = new URLSearchParams({ q: args.query, count: String(args.maxResults) });
    if (args.country) params.set('country', args.country);
    if (args.language) params.set('search_lang', args.language);
    const fresh = braveFreshness(args.freshnessDays);
    if (fresh) params.set('freshness', fresh);
    body = await jsonRequest(
      fetchImpl,
      `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
      { headers: { Accept: 'application/json', 'X-Subscription-Token': key } },
      timeoutMs
    );
  } else {
    const params = new URLSearchParams({
      engine: 'google',
      q: args.query,
      api_key: key,
      num: String(args.maxResults)
    });
    if (args.country) params.set('gl', args.country.toLowerCase());
    if (args.language) params.set('hl', args.language);
    const fresh = serpFreshness(args.freshnessDays);
    if (fresh) params.set('tbs', fresh);
    body = await jsonRequest(
      fetchImpl,
      `https://serpapi.com/search.json?${params.toString()}`,
      {},
      timeoutMs
    );
  }

  const rows = provider === 'brave'
    ? body?.web?.results
    : provider === 'serpapi'
      ? body?.organic_results
      : body?.results;
  const results = (Array.isArray(rows) ? rows : [])
    .map((row: any, index: number) =>
      normalized(
        provider === 'serpapi' && typeof row.position === 'number' ? row.position : index + 1,
        row,
        provider
      )
    )
    .filter(Boolean) as Array<Record<string, any>>;

  return {
    results,
    requestId: body?.request_id ?? body?.requestId ?? body?.search_metadata?.id ?? body?.query?.id,
    responseTimeMs: provider === 'tavily' && Number.isFinite(Number(body?.response_time))
      ? Math.round(Number(body.response_time) * 1000)
      : undefined
  };
}

function domainMatches(url: string, domain: string) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

export async function executeWebSearch(
  rawArgs: WebSearchArgs,
  runtime: WebSearchRuntime = {}
): Promise<ToolExecutionResult> {
  let args: ReturnType<typeof validate>;
  try {
    args = validate(rawArgs);
  } catch (err: any) {
    return error(err.message || String(err));
  }

  const env = runtime.env ?? process.env;
  const fetchImpl = runtime.fetchImpl ?? fetch;
  const now = runtime.now?.() ?? new Date();
  const timeoutMs = runtime.timeoutMs ?? 15_000;
  const attempts: Array<Record<string, any>> = [];

  for (const provider of order(args.provider, args.mode)) {
    const key = env[ENV_KEY[provider]]?.trim();
    if (!key) {
      attempts.push({
        provider,
        status: 'missing_configuration',
        reason: `Set ${ENV_KEY[provider]} in the MCP server environment.`
      });
      if (args.provider !== 'auto') break;
      continue;
    }

    try {
      const response = await callProvider(provider, args, key, fetchImpl, timeoutMs, now);
      const results = response.results
        .filter((item) =>
          (!args.includeDomains.length ||
            args.includeDomains.some((d) => domainMatches(item.url, d))) &&
          !args.excludeDomains.some((d) => domainMatches(item.url, d))
        )
        .slice(0, args.maxResults)
        .map((item, index) => ({ ...item, rank: index + 1 }));

      attempts.push({ provider, status: 'success' });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            schemaVersion: '1.0',
            query: args.query,
            mode: args.mode,
            providerUsed: provider,
            retrievedAt: now.toISOString(),
            requestId: response.requestId,
            responseTimeMs: response.responseTimeMs,
            resultCount: results.length,
            results,
            attempts,
            policy: {
              credentials: 'server-environment-only',
              fabricatedResults: false,
              resultUrlsFetched: false,
              escalation:
                'Use nymrel_crawler_mesh for extraction/crawling; use a privileged browser service only for interaction or JavaScript execution.'
            }
          }, null, 2)
        }]
      };
    } catch (err: any) {
      attempts.push({ provider, status: 'failed', reason: String(err.message || err).slice(0, 700) });
      if (args.provider !== 'auto') break;
    }
  }

  const configuredProviders = PROVIDERS.filter((provider) => !!env[ENV_KEY[provider]]?.trim());
  return error(JSON.stringify({
    error: configuredProviders.length
      ? 'All eligible web-search provider attempts failed.'
      : 'No web-search provider is configured.',
    query: args.query,
    mode: args.mode,
    attempts,
    configuredProviders,
    requiredEnvironmentVariables: ENV_KEY,
    policy: { credentials: 'server-environment-only', fabricatedResults: false }
  }, null, 2));
}
