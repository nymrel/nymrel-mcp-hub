import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { CHATGPT_REMOTE_TOOLS } from '../src/chatgpt-mcp-edge.js';

test('ChatGPT submission packet matches the frozen public action catalog', async () => {
  const submission = JSON.parse(await fs.readFile(new URL('../chatgpt-app-submission.json', import.meta.url), 'utf8'));
  assert.equal(submission.schema_version, 1);
  assert.equal(submission.app_info.display_name, 'Nymrel Remote');
  assert.equal(submission.app_info.category, 'DEVELOPER_TOOLS');
  assert.equal(submission.test_cases.length, 5);
  assert.equal(submission.negative_test_cases.length, 3);

  const sourceNames = CHATGPT_REMOTE_TOOLS.map((tool) => tool.name).sort();
  const submissionNames = Object.keys(submission.tools).sort();
  assert.deepEqual(submissionNames, sourceNames);

  for (const tool of CHATGPT_REMOTE_TOOLS) {
    const packet = submission.tools[tool.name];
    assert.ok(packet, `missing submission entry for ${tool.name}`);
    assert.deepEqual(packet.annotations, {
      readOnlyHint: tool.annotations.readOnlyHint,
      openWorldHint: tool.annotations.openWorldHint,
      destructiveHint: tool.annotations.destructiveHint
    });
    for (const key of ['read_only_justification', 'open_world_justification', 'destructive_justification']) {
      assert.equal(typeof packet.justifications?.[key], 'string', `${tool.name}.${key}`);
      assert.ok(packet.justifications[key].trim().endsWith('.'), `${tool.name}.${key} must be a complete sentence`);
    }
  }

  for (const item of submission.test_cases) {
    assert.equal(typeof item.tools_triggered, 'string');
    assert.ok(sourceNames.includes(item.tools_triggered), `positive test references unknown tool ${item.tools_triggered}`);
  }
  for (const item of submission.negative_test_cases) {
    assert.equal(item.tools_triggered, null);
  }
});
