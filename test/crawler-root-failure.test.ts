import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeCrawler } from '../src/tools/crawlerTool.js';

for (const action of ['map', 'crawl'] as const) {
  test(`MCP ${action} reports root HTTP failure as an error`, async () => {
    const fetcher: typeof fetch = async () => new Response('unavailable', { status: 503 });
    const result = await executeCrawler({ action, url: 'https://example.com/', sitemap: 'skip', limit: 1 }, {
      fetch: fetcher, respectRobots: false, resolveHostname: async () => ['93.184.216.34']
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text!, /CRAWL_ROOT_NOT_ACQUIRED/);
  });
}

test('MCP map may return no matches after successful root acquisition', async () => {
  const fetcher: typeof fetch = async () => new Response('<main><h1>Root</h1></main>', {
    status: 200, headers: { 'content-type': 'text/html' }
  });
  const result = await executeCrawler({ action: 'map', url: 'https://example.com/', sitemap: 'skip', limit: 1, search: 'not-present' }, {
    fetch: fetcher, respectRobots: false, resolveHostname: async () => ['93.184.216.34']
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0]!.text!).links, []);
});
