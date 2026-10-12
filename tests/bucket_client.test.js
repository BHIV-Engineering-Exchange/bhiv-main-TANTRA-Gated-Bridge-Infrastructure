const assert = require('assert');
const axios = require('axios');
const { storeArtifact } = require('../services/execution/bucket_client');

async function run() {
  const originalGet = axios.get;
  const originalPost = axios.post;
  const calls = [];

  axios.get = async (url, options) => {
    calls.push({ method: 'GET', url, options });
    return { data: { last_hash: 'current-chain-head' } };
  };
  axios.post = async (url, body, options) => {
    calls.push({ method: 'POST', url, body, options });
    return { data: { success: true, data: { artifact_id: 'exec-1', hash: 'bucket-hash' } } };
  };

  try {
    const response = await storeArtifact({
      bucketUrl: 'http://bucket',
      timeoutMs: 15000,
      requesterId: 'tantra-core',
      traceId: 'trace-1',
      executionId: 'exec-1',
      result: { workload: 'test', output: 'Processed test', hash: 'result-hash' },
      timestampUtc: '2026-10-12T00:00:00.000Z',
      durationMs: 3
    });

    assert.strictEqual(response.success, true);
    assert.strictEqual(calls[0].url, 'http://bucket/bucket/latest-hash');
    assert.strictEqual(calls[1].url, 'http://bucket/bucket/artifacts/write');
    assert.strictEqual(calls[1].body.requester_id, 'tantra-core');
    assert.strictEqual(calls[1].body.integration_id, 'core');
    assert.strictEqual(calls[1].body.artifact.artifact_id, 'exec-1');
    assert.strictEqual(calls[1].body.artifact.trace_id, 'trace-1');
    assert.strictEqual(calls[1].body.artifact.parent_hash, 'current-chain-head');
    assert.deepStrictEqual(calls[1].body.artifact.payload, {
      workload: 'test',
      output: 'Processed test',
      hash: 'result-hash',
      duration_ms: 3
    });
  } finally {
    axios.get = originalGet;
    axios.post = originalPost;
  }
}

run().then(() => console.log('bucket_client.test.js: PASS')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
