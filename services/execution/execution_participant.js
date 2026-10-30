const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MasterDbClient = require('./masterdb_client');
const VajraClient = require('./vajra_client');

const OUTPUT_DIR = process.env.EXECUTION_OUTPUT_DIR || path.join(__dirname, 'outputs');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function obtainSarathiToken(trace_id, execution_id) {
  const sarathiUrl = process.env.SARATHI_URL || 'http://localhost:3001';
  const response = await fetch(`${sarathiUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      trace_id,
      execution_id,
      algorithm: 'RS256',
      actor: 'tantra-execution',
      audience: 'masterdb',
      roles: ['ecosystem-reader']
    })
  });
  if (!response.ok) {
    throw new Error(`Failed to obtain Sarathi RS256 token: HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.token;
}

async function executeWorkload(workload, trace_id, execution_id, context = {}) {
  let result = {
    workload,
    output: typeof workload === 'string' ? `Processed ${workload}` : `Processed ${JSON.stringify(workload)}`,
    trace_id,
    execution_id
  };

  let capabilityId = null;
  let purpose = process.env.MASTERDB_PURPOSE || 'environmental_monitoring';
  let applicationId = process.env.MASTERDB_APPLICATION_ID || 'app-tantra-gated-bridge';

  if (typeof workload === 'object' && workload !== null) {
    if (workload.capability_id) capabilityId = workload.capability_id;
    if (workload.purpose) purpose = workload.purpose;
    if (workload.application_id) applicationId = workload.application_id;
  } else if (typeof workload === 'string' && workload.startsWith('cap-')) {
    capabilityId = workload;
  } else if (process.env.MASTERDB_AUTO_RETRIEVE === 'true') {
    capabilityId = process.env.MASTERDB_CAPABILITY_ID || 'cap-mangrove-monitoring';
  }

  if (capabilityId) {
    const client = new MasterDbClient();

    let token = null;
    if (context.token && context.bridgeTokenData && context.bridgeTokenData.aud === 'masterdb') {
      token = context.token;
    } else {
      token = await obtainSarathiToken(trace_id, execution_id);
    }

    const contract = await client.getContract(capabilityId, token);

    const grant = await client.requestAccess({
      token,
      capabilityId,
      applicationId,
      purpose
    });

    const queryParams = (typeof workload === 'object' && workload.query_params) ? workload.query_params : {};
    const grantToken = grant.access_token || grant.grant_token;
    const retrieval = await client.retrieveData({
      token,
      grantToken,
      capabilityId,
      applicationId,
      queryParams,
      traceId: trace_id,
      executionId: execution_id
    });

    result.governed_capability = {
      capability_id: capabilityId,
      contract_name: contract.capability_name,
      domain: contract.domain,
      grant_id: grant.request_id,
      records: retrieval.records,
      total_records: retrieval.total_records,
      content_digest_sha256: retrieval.content_digest_sha256,
      retrieval_timestamp: retrieval.retrieval_timestamp || retrieval.retrieved_at
    };

    // Optional VAJRA TrustStore provenance recording (fails open if disabled/unavailable)
    const vajraClient = new VajraClient();
    if (vajraClient.isEnabled()) {
      try {
        const provenanceReceipt = await vajraClient.recordRetrievalProvenance({
          trace_id,
          actor_id: context.actor || 'tantra-execution',
          capability_id: capabilityId,
          dataset_id: (contract && contract.dataset_id) ? contract.dataset_id : capabilityId,
          access_grant_ref: grant.request_id || grant.grant_id || 'unassigned_grant_ref',
          workflow_id: execution_id,
          record_count: retrieval.total_records !== undefined ? retrieval.total_records : (Array.isArray(retrieval.records) ? retrieval.records.length : 0),
          content_digest: retrieval.content_digest_sha256,
          retrieval_outcome: 'SUCCESS'
        });
        result.vajra_provenance = provenanceReceipt;
      } catch (vajraErr) {
        result.vajra_provenance = {
          recorded: false,
          error: vajraErr.message
        };
      }
    }
  }

  const outputFile = path.join(OUTPUT_DIR, `${execution_id}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));

  const hash = crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex');

  return {
    ...result,
    hash,
    output_file: outputFile
  };
}

function getExecutionOutput(executionId) {
  const outputFile = path.join(OUTPUT_DIR, `${executionId}.json`);
  if (!fs.existsSync(outputFile)) return null;
  return JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
}

function getAllOutputs() {
  if (!fs.existsSync(OUTPUT_DIR)) return [];
  return fs.readdirSync(OUTPUT_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => ({
      execution_id: f.replace('.json', ''),
      path: path.join(OUTPUT_DIR, f)
    }));
}

module.exports = { executeWorkload, getExecutionOutput, getAllOutputs, obtainSarathiToken };
