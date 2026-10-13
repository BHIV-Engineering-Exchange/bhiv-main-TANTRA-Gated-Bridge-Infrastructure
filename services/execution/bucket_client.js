const axios = require('axios');

async function storeArtifact({ bucketUrl, timeoutMs, requesterId, traceId, executionId, result, timestampUtc, durationMs }) {
  const response = await axios.post(
    `${bucketUrl}/store`,
    {
      trace_id: traceId,
      execution_id: executionId,
      result,
      timestamp: timestampUtc,
      duration_ms: durationMs
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: timeoutMs
    }
  );

  return response;
}

module.exports = { storeArtifact };

