const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const MasterDbClient = require('../../services/execution/masterdb_client');

test('MasterDbClient - Complete contract, auth, retrieval, and error handling suite', async (t) => {
  let recordedRequests = [];
  let mockStatusCode = 200;
  let mockResponseBody = {};
  let delayMs = 0;

  const server = http.createServer(async (req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      recordedRequests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: body ? JSON.parse(body) : null
      });

      if (delayMs > 0) {
        await new Promise(r => setTimeout(r, delayMs));
      }

      res.writeHead(mockStatusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mockResponseBody));
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const client = new MasterDbClient({ baseUrl, timeoutMs: 200, applicationId: 'test-tantra-app' });

  await t.test('discoverCapabilities sends proper GET with query parameters', async () => {
    recordedRequests = [];
    mockStatusCode = 200;
    mockResponseBody = [{ capability_id: 'cap-mangrove-monitoring', domain: 'geospatial' }];

    const result = await client.discoverCapabilities({ domain: 'geospatial', status: 'ACTIVE' });
    assert.equal(result.length, 1);
    assert.equal(recordedRequests.length, 1);
    assert.equal(recordedRequests[0].method, 'GET');
    assert.equal(recordedRequests[0].url, '/capabilities?domain=geospatial&status=ACTIVE');
  });

  await t.test('getContract sends GET for capability contract', async () => {
    recordedRequests = [];
    mockStatusCode = 200;
    mockResponseBody = { capability_id: 'cap-mangrove-monitoring', capability_name: 'Mangrove Coverage' };

    const result = await client.getContract('cap-mangrove-monitoring');
    assert.equal(result.capability_id, 'cap-mangrove-monitoring');
    assert.equal(recordedRequests[0].method, 'GET');
    assert.equal(recordedRequests[0].url, '/capabilities/cap-mangrove-monitoring/contract');
  });

  await t.test('requestAccess sends POST with Bearer token and grant request payload', async () => {
    recordedRequests = [];
    mockStatusCode = 200;
    mockResponseBody = {
      request_id: 'req-grant-101',
      grant_token: 'grant-tok-xyz',
      capability_id: 'cap-mangrove-monitoring',
      status: 'GRANTED'
    };

    const result = await client.requestAccess({
      token: 'jwt-rs256-mock-token',
      capabilityId: 'cap-mangrove-monitoring',
      applicationId: 'test-tantra-app',
      purpose: 'environmental_audit',
      requestedTtlSeconds: 1800
    });

    assert.equal(result.grant_token, 'grant-tok-xyz');
    assert.equal(recordedRequests[0].method, 'POST');
    assert.equal(recordedRequests[0].url, '/access/request');
    assert.equal(recordedRequests[0].headers['authorization'], 'Bearer jwt-rs256-mock-token');
    assert.equal(recordedRequests[0].body.application_id, 'test-tantra-app');
    assert.equal(recordedRequests[0].body.capability_id, 'cap-mangrove-monitoring');
    assert.equal(recordedRequests[0].body.purpose, 'environmental_audit');
    assert.equal(recordedRequests[0].body.requested_ttl_seconds, 1800);
  });

  await t.test('retrieveData sends POST with Bearer token, grant token, and trace context', async () => {
    recordedRequests = [];
    mockStatusCode = 200;
    mockResponseBody = {
      capability_id: 'cap-mangrove-monitoring',
      records: [{ id: 1, region: 'Sundarbans' }],
      total_records: 1,
      content_digest_sha256: 'abc123sha',
      trace_id: 'tr-001',
      execution_id: 'ex-002'
    };

    const result = await client.retrieveData({
      token: 'jwt-rs256-mock-token',
      grantToken: 'grant-tok-xyz',
      capabilityId: 'cap-mangrove-monitoring',
      queryParams: { region: 'Sundarbans' },
      traceId: 'tr-001',
      executionId: 'ex-002'
    });

    assert.equal(result.total_records, 1);
    assert.equal(result.content_digest_sha256, 'abc123sha');
    assert.equal(recordedRequests[0].method, 'POST');
    assert.equal(recordedRequests[0].url, '/capabilities/cap-mangrove-monitoring/retrieve');
    assert.equal(recordedRequests[0].headers['authorization'], 'Bearer jwt-rs256-mock-token');
    assert.equal(recordedRequests[0].body.access_token, 'grant-tok-xyz');
    assert.equal(recordedRequests[0].body.trace_id, 'tr-001');
    assert.equal(recordedRequests[0].body.execution_id, 'ex-002');
  });

  await t.test('fail-closed: throws on HTTP 403 Forbidden', async () => {
    mockStatusCode = 403;
    mockResponseBody = { detail: 'Access grant expired or revoked' };

    await assert.rejects(
      async () => {
        await client.retrieveData({
          token: 'jwt-token',
          grantToken: 'expired-grant',
          capabilityId: 'cap-mangrove-monitoring'
        });
      },
      (err) => {
        assert.equal(err.status, 403);
        assert.match(err.message, /Access grant expired or revoked/);
        return true;
      }
    );
  });

  await t.test('fail-closed: throws on timeout', async () => {
    delayMs = 350; // client timeout is 200ms
    mockStatusCode = 200;
    mockResponseBody = {};

    await assert.rejects(
      async () => {
        await client.getContract('cap-mangrove-monitoring');
      },
      (err) => {
        assert.equal(err.status, 504);
        assert.match(err.message, /timed out/);
        return true;
      }
    );
    delayMs = 0;
  });

  await t.test('configuration: rejects invalid protocol or missing production URL', async () => {
    // Missing in production
    const origEnv = process.env.NODE_ENV;
    const origUrl = process.env.MASTERDB_URL;
    delete process.env.MASTERDB_URL;
    process.env.NODE_ENV = 'production';
    assert.throws(
      () => new MasterDbClient(),
      /MASTERDB_URL is not configured in production environment/
    );

    // Invalid protocol
    process.env.NODE_ENV = 'development';
    assert.throws(
      () => new MasterDbClient({ baseUrl: 'ftp://masterdb.local' }),
      /Invalid MASTERDB_URL/
    );

    process.env.NODE_ENV = origEnv;
    if (origUrl) process.env.MASTERDB_URL = origUrl;
  });

  await t.test('executeWorkload: invokes MasterDbClient and attaches governed capability payload', async () => {
    const { executeWorkload } = require('../../services/execution/execution_participant');
    process.env.MASTERDB_URL = baseUrl;
    recordedRequests = [];
    mockStatusCode = 200;

    // Set responses for contract, access grant, and retrieval
    let step = 0;
    server.removeAllListeners('request');
    server.on('request', async (req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        if (req.url.includes('/contract')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            capability_id: 'cap-mangrove-monitoring',
            capability_name: 'Mangrove Monitoring',
            domain: 'geospatial',
            contract_version: '1.0.0'
          }));
        }
        if (req.url.includes('/access/request')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            request_id: 'grant-req-999',
            access_token: 'grant-tok-999',
            authorized: true
          }));
        }
        if (req.url.includes('/retrieve')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            capability: { capability_id: 'cap-mangrove-monitoring' },
            records: [{ id: 1, region: 'Delta' }],
            total_records: 1,
            content_digest_sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
            retrieval_timestamp: new Date().toISOString()
          }));
        }
        res.writeHead(404);
        res.end();
      });
    });

    const mockContext = {
      token: 'mock-sarathi-rs256-token',
      bridgeTokenData: { aud: 'masterdb' }
    };
    const result = await executeWorkload(
      { capability_id: 'cap-mangrove-monitoring', purpose: 'testing' },
      'test-trace-id',
      'test-exec-id',
      mockContext
    );

    assert.ok(result.governed_capability);
    assert.equal(result.governed_capability.capability_id, 'cap-mangrove-monitoring');
    assert.equal(result.governed_capability.grant_id, 'grant-req-999');
    assert.equal(result.governed_capability.content_digest_sha256.length, 64);
  });

  await t.test('executeWorkload: upstream MASTERDB failure cannot report false success', async () => {
    const { executeWorkload } = require('../../services/execution/execution_participant');
    process.env.MASTERDB_URL = baseUrl;

    server.removeAllListeners('request');
    server.on('request', async (req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'MASTERDB ingestion store offline' }));
    });

    const mockContext = {
      token: 'mock-sarathi-rs256-token',
      bridgeTokenData: { aud: 'masterdb' }
    };

    await assert.rejects(
      async () => {
        await executeWorkload(
          { capability_id: 'cap-mangrove-monitoring' },
          'test-trace-err',
          'test-exec-err',
          mockContext
        );
      },
      (err) => {
        assert.match(err.message, /MASTERDB request failed/);
        return true;
      }
    );
  });

  server.close();
});
