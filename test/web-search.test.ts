import test from 'node:test';
import assert from 'node:assert';
import { executeWebSearch } from '../src/tools/webSearchTool.js';

test('web search fails closed when no provider is configured', async () => {
  const result = await executeWebSearch(
    { query: 'agent web search' },
    { env: {} }
  );
  assert.strictEqual(result.isError, true);
  const data = JSON.parse(result.content[0].text!);
  assert.strictEqual(data.error, 'No web-search provider is configured.');
  assert.deepStrictEqual(data.configuredProviders, []);
  assert.strictEqual(data.policy.fabricatedResults, false);
});

test('web search normalizes Tavily results without exposing credentials', async () => {
  let authorization = '';
  const fakeFetch: typeof fetch = async (_url, init) => {
    authorization = String((init?.headers as Record<string, string>)?.Authorization ?? '');
    return new Response(JSON.stringify({
      results: [
        {
          title: 'Tavily Docs',
          url: 'https://docs.tavily.com/example',
          content: 'Agent-oriented search result.',
          score: 0.91,
          published_date: '2026-09-24T12:00:00Z'
        }
      ],
      response_time: '0.42',
      request_id: 'req-test'
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await executeWebSearch(
    {
      query: 'agent search',
      provider: 'tavily',
      includeDomains: ['docs.tavily.com']
    },
    {
      env: { TAVILY_API_KEY: 'tvly-secret-test' },
      fetchImpl: fakeFetch,
      now: () => new Date('2026-09-24T20:00:00Z')
    }
  );

  assert.strictEqual(result.isError, undefined);
  assert.strictEqual(authorization, 'Bearer tvly-secret-test');
  assert.ok(!result.content[0].text!.includes('tvly-secret-test'));
  const data = JSON.parse(result.content[0].text!);
  assert.strictEqual(data.providerUsed, 'tavily');
  assert.strictEqual(data.resultCount, 1);
  assert.strictEqual(data.results[0].url, 'https://docs.tavily.com/example');
  assert.strictEqual(data.responseTimeMs, 420);
  assert.strictEqual(data.policy.resultUrlsFetched, false);
});

test('web search auto mode falls back after a provider failure', async () => {
  const fakeFetch: typeof fetch = async (url) => {
    if (String(url).includes('api.exa.ai')) {
      return new Response(JSON.stringify({ error: 'temporary failure' }), { status: 503 });
    }
    return new Response(JSON.stringify({
      web: {
        results: [
          {
            title: 'Fallback',
            url: 'https://example.com/fallback',
            description: 'Brave fallback result.'
          }
        ]
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await executeWebSearch(
    { query: 'fallback test' },
    {
      env: {
        EXA_API_KEY: 'exa-secret-test',
        BRAVE_SEARCH_API_KEY: 'brave-secret-test'
      },
      fetchImpl: fakeFetch
    }
  );

  assert.strictEqual(result.isError, undefined);
  const data = JSON.parse(result.content[0].text!);
  assert.strictEqual(data.providerUsed, 'brave');
  assert.deepStrictEqual(
    data.attempts.map((attempt: any) => [attempt.provider, attempt.status]),
    [
      ['exa', 'failed'],
      ['tavily', 'missing_configuration'],
      ['brave', 'success']
    ]
  );
});
