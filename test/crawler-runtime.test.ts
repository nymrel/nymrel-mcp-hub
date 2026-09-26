import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCrawler } from '../src/tools/crawlerTool.js';

const publicResolver = async (hostname: string): Promise<string[]> => {
  if (hostname === 'private.example.com') return ['127.0.0.1'];
  if (hostname.endsWith('.example.com') || hostname === 'example.com') return ['93.184.216.34'];
  return ['93.184.216.34'];
};

function makeFetch(): typeof globalThis.fetch {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = input.toString();

    if (url.endsWith('/robots.txt')) {
      return new Response('User-agent: *\nAllow: /\n', {
        status: 200,
        headers: { 'content-type': 'text/plain' }
      });
    }

    if (url.endsWith('/sitemap.xml')) {
      return new Response('<?xml version="1.0"?><urlset><url><loc>https://example.com/docs</loc></url><url><loc>https://example.com/docs/a</loc></url></urlset>', {
        status: 200,
        headers: { 'content-type': 'application/xml' }
      });
    }

    if (url === 'https://example.com/' || url === 'https://example.com') {
      return new Response(
        '<html><head><title>Home</title></head><body><main><h1>Home</h1><a href="/docs">Docs</a><a href="https://api.example.com/reference">API</a></main></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } }
      );
    }

    if (url === 'https://example.com/docs') {
      return new Response(
        '<html><head><title>Docs</title></head><body><main><h1>Docs</h1><a href="/docs/a">A</a><a href="/pricing">Pricing</a></main></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } }
      );
    }

    if (url === 'https://example.com/docs/a') {
      return new Response(
        '<html><head><title>Doc A</title></head><body><main><p>Child page</p></main></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } }
      );
    }

    if (url === 'https://example.com/pricing') {
      return new Response(
        '<html><head><title>Pricing</title></head><body><main><p>Pricing</p></main></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } }
      );
    }

    if (url === 'https://api.example.com/reference') {
      return new Response(
        '<html><head><title>API Reference</title></head><body><main><p>Reference</p></main></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } }
      );
    }

    if (url === 'https://redirect.example.com/') {
      return new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/secret' }
      });
    }

    return new Response('Not Found', { status: 404, statusText: 'Not Found' });
  };
}

const runtime = {
  cache: false,
  respectRobots: true,
  maxConcurrency: 1,
  delayMs: 0,
  fetch: makeFetch(),
  resolveHostname: publicResolver
};

test('Crawler MCP: scrape performs a real bounded fetch through Crawler Mesh', async () => {
  const result = await executeCrawler({ action: 'scrape', url: 'https://example.com/' }, runtime);
  assert.equal(result.isError, undefined);
  const data = JSON.parse(result.content[0].text!);
  assert.equal(data.action, 'scrape');
  assert.equal(data.source, 'nymrel-crawler-mesh');
  assert.equal(data.networkFetchPerformed, true);
  assert.equal(data.success, true);
  assert.equal(data.data.metadata.creditsUsed, 0);
  assert.equal(data.data.metadata.provider, 'nymrel-crawler-mesh');
  assert.match(data.data.markdown, /Home/);
  assert.deepEqual(data.data.links.sort(), [
    'https://api.example.com/reference',
    'https://example.com/docs'
  ].sort());
});

test('Crawler MCP: map filters and discovers subdomain URLs', async () => {
  const result = await executeCrawler({
    action: 'map',
    url: 'https://example.com/',
    search: 'api',
    sitemap: 'skip',
    limit: 10
  }, runtime);
  assert.equal(result.isError, undefined);
  const data = JSON.parse(result.content[0].text!);
  assert.equal(data.action, 'map');
  assert.deepEqual(data.links.map((item: { url: string }) => item.url), [
    'https://api.example.com/reference'
  ]);
});

test('Crawler MCP: crawl stays within the starting child path by default', async () => {
  const result = await executeCrawler({
    action: 'crawl',
    url: 'https://example.com/docs',
    sitemap: 'skip',
    limit: 10,
    maxDepth: 2
  }, runtime);
  assert.equal(result.isError, undefined);
  const data = JSON.parse(result.content[0].text!);
  assert.equal(data.creditsUsed, 0);
  assert.deepEqual(data.data.map((item: any) => item.metadata.sourceURL).sort(), [
    'https://example.com/docs',
    'https://example.com/docs/a'
  ]);
});

test('Crawler MCP: crawl can explicitly widen to the full same domain', async () => {
  const result = await executeCrawler({
    action: 'crawl',
    url: 'https://example.com/docs',
    sitemap: 'skip',
    limit: 10,
    maxDepth: 1,
    crawlEntireDomain: true
  }, runtime);
  assert.equal(result.isError, undefined);
  const data = JSON.parse(result.content[0].text!);
  assert.deepEqual(data.data.map((item: any) => item.metadata.sourceURL).sort(), [
    'https://example.com/docs',
    'https://example.com/docs/a',
    'https://example.com/pricing'
  ]);
});

test('Crawler MCP: private literal targets fail closed before fetch', async () => {
  let calls = 0;
  const result = await executeCrawler(
    { action: 'scrape', url: 'http://127.0.0.1/secret' },
    {
      ...runtime,
      fetch: async () => {
        calls += 1;
        return new Response('should-not-run');
      }
    }
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text!, /PRIVATE_NETWORK_TARGET/);
  assert.equal(calls, 0);
});

test('Crawler MCP: DNS resolving to private space fails closed before fetch', async () => {
  let calls = 0;
  const result = await executeCrawler(
    { action: 'scrape', url: 'https://private.example.com/' },
    {
      ...runtime,
      fetch: async () => {
        calls += 1;
        return new Response('should-not-run');
      }
    }
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text!, /PRIVATE_NETWORK_TARGET/);
  assert.equal(calls, 0);
});

test('Crawler MCP: redirect to private target is rejected', async () => {
  const result = await executeCrawler(
    { action: 'scrape', url: 'https://redirect.example.com/' },
    runtime
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text!, /PRIVATE_NETWORK_TARGET/);
});

test('Crawler MCP: input caps reject oversized limits and depth', async () => {
  const limit = await executeCrawler({ action: 'crawl', url: 'https://example.com/', limit: 101 }, runtime);
  assert.equal(limit.isError, true);
  assert.match(limit.content[0].text!, /limit must be an integer between 1 and 100/);

  const depth = await executeCrawler({ action: 'crawl', url: 'https://example.com/', maxDepth: 11 }, runtime);
  assert.equal(depth.isError, true);
  assert.match(depth.content[0].text!, /maxDepth must be an integer between 0 and 10/);
});
