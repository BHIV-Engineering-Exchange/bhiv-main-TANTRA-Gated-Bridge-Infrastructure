const assert = require('assert');
const axios = require('axios');
const { storeArtifact } = require('../services/execution/bucket_client');

async function run() {
  const originalPost = axios.post;
  const calls = [];

  axios.post = async (url, body, options) => {
    calls.push({ method: 'POST', url, body, options });
    return {
      status: 201,
      data: {
        location: 'artifacts/trace-1/exec-1',
        trace_id: 'trace-1',
        execution_id: 'exec-1',
        hash: 'bucket-hash',
        verified: true,
        persistent: true
      }
    };
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

    assert.strictEqual(response.status, 201);
    assert.strictEqual(response.data.location, 'artifacts/trace-1/exec-1');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'http://bucket/store');
    assert.deepStrictEqual(calls[0].body, {
      trace_id: 'trace-1',
      execution_id: 'exec-1',
      result: { workload: 'test', output: 'Processed test', hash: 'result-hash' },
      timestamp: '2026-10-12T00:00:00.000Z',
      duration_ms: 3
    });
  } finally {
    axios.post = originalPost;
  }
}

run().then(() => console.log('bucket_client.test.js: PASS')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
