const axios = require('axios');

async function storeArtifact({ bucketUrl, timeoutMs, requesterId, traceId, executionId, result, timestampUtc, durationMs }) {
  const latestHashResponse = await axios.get(`${bucketUrl}/bucket/latest-hash`, {
    timeout: timeoutMs
  });

  const latestHash = latestHashResponse.data && (
    latestHashResponse.data.last_hash ||
    (latestHashResponse.data.data && latestHashResponse.data.data.last_hash)
  );

  const artifact = {
    artifact_id: executionId,
    trace_id: traceId,
    timestamp_utc: timestampUtc,
    schema_version: '1.0.0',
    source_module_id: 'tantra-execution',
    artifact_type: 'agent_outputs',
    payload: {
      ...result,
      duration_ms: durationMs
    }
  };

  if (latestHash) {
    artifact.parent_hash = latestHash;
  }

  const response = await axios.post(
    `${bucketUrl}/bucket/artifacts/write`,
    {
      requester_id: requesterId,
      integration_id: 'core',
      artifact
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: timeoutMs
    }
  );

  return response.data;
}

module.exports = { storeArtifact };
