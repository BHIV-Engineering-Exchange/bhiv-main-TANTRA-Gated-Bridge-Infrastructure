const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const VajraClient = require('../../services/execution/vajra_client');
const { executeWorkload } = require('../../services/execution/execution_participant');

test('VajraClient Unit & Integration Suite', async (t) => {

  await t.test('1. Disabled by default: returns skipped without making HTTP request', async () => {
    const client = new VajraClient({ enabled: false });
    assert.equal(client.isEnabled(), false);

    const res = await client.recordRetrievalProvenance({
      trace_id: 'test-trace-1',
      actor_id: 'tantra-execution',
      capability_id: 'cap-mangrove-monitoring',
      dataset_id: 'ds-mangroves'
    });

    assert.equal(res.recorded, false);
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'VAJRA_PROVENANCE_DISABLED');
  });

  await t.test('2. Fails closed when enabled but missing required fields', async () => {
    const client = new VajraClient({ enabled: true, secret: 'synthetic-secret-xyz' });

    // Missing trace_id
    await assert.rejects(
      async () => {
        await client.recordRetrievalProvenance({
          actor_id: 'tantra-execution',
          capability_id: 'cap-1',
          dataset_id: 'ds-1'
        });
      },
      (err) => {
        assert.equal(err.status, 400);
        assert.match(err.message, /trace_id/);
        return true;
      }
    );

    // Missing actor_id
    await assert.rejects(
      async () => {
        await client.recordRetrievalProvenance({
          trace_id: 't-1',
          capability_id: 'cap-1',
          dataset_id: 'ds-1'
        });
      },
      (err) => {
        assert.equal(err.status, 400);
        assert.match(err.message, /actor_id/);
        return true;
      }
    );
  });

  await t.test('3. Fails closed when enabled but secret is missing/empty', async () => {
    const client = new VajraClient({ enabled: true, secret: '' });

    await assert.rejects(
      async () => {
        await client.recordRetrievalProvenance({
          trace_id: 't-1',
          actor_id: 'tantra-execution',
          capability_id: 'cap-1',
          dataset_id: 'ds-1'
        });
      },
      (err) => {
        assert.equal(err.status, 401);
        assert.match(err.message, /VAJRA_TANTRA_SECRET is not configured/);
        return true;
      }
    );
  });

  await t.test('4. Successful provenance dispatch: validates Bearer token and payload', async () => {
    let capturedHeader = null;
    let capturedBody = null;

    const mockServer = http.createServer((req, res) => {
      capturedHeader = req.headers['authorization'];
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        capturedBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          trace_id: capturedBody.trace_id,
          evidence_hash: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          stored: true,
          stored_in: ['TruthStore (data/tantra_truth.jsonl)'],
          recorded_at: 1787184000
        }));
      });
    });

    await new Promise(r => mockServer.listen(0, '127.0.0.1', r));
    const port = mockServer.address().port;

    try {
      const client = new VajraClient({
        baseUrl: `http://127.0.0.1:${port}`,
        secret: 'test-secret-vault-123',
        enabled: true
      });

      const receipt = await client.recordRetrievalProvenance({
        trace_id: 'trace-test-rec-1',
        actor_id: 'tantra-execution',
        capability_id: 'cap-mangrove-monitoring',
        dataset_id: 'ds-mangroves-001',
        access_grant_ref: 'grant-abc123',
        workflow_id: 'exec-xyz789',
        record_count: 5,
        content_digest: 'sha256:abc123456789',
        retrieval_outcome: 'SUCCESS'
      });

      assert.equal(capturedHeader, 'Bearer test-secret-vault-123');
      assert.equal(capturedBody.trace_id, 'trace-test-rec-1');
      assert.equal(capturedBody.actor_id, 'tantra-execution');
      assert.equal(capturedBody.access_grant_ref, 'grant-abc123');
      assert.equal(capturedBody.record_count, 5);

      assert.equal(receipt.recorded, true);
      assert.equal(receipt.success, true);
      assert.equal(receipt.trace_id, 'trace-test-rec-1');
      assert.ok(receipt.evidence_hash);
    } finally {
      await new Promise(r => mockServer.close(r));
    }
  });

  await t.test('5. Idempotent duplicate: handles 409 Conflict as success without side effect', async () => {
    const mockServer = http.createServer((req, res) => {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        duplicate: true,
        trace_id: 'trace-dup-001',
        existing_hash: 'sha256:existing_evidence_hash_123',
        recorded_at: 1787180000
      }));
    });

    await new Promise(r => mockServer.listen(0, '127.0.0.1', r));
    const port = mockServer.address().port;

    try {
      const client = new VajraClient({
        baseUrl: `http://127.0.0.1:${port}`,
        secret: 'test-secret',
        enabled: true
      });

      const receipt = await client.recordRetrievalProvenance({
        trace_id: 'trace-dup-001',
        actor_id: 'tantra-execution',
        capability_id: 'cap-1',
        dataset_id: 'ds-1'
      });

      assert.equal(receipt.recorded, true);
      assert.equal(receipt.duplicate, true);
      assert.equal(receipt.trace_id, 'trace-dup-001');
      assert.equal(receipt.existing_hash, 'sha256:existing_evidence_hash_123');
    } finally {
      await new Promise(r => mockServer.close(r));
    }
  });

  await t.test('6. Authentication failure: handles 401 Unauthorized without leaking secret', async () => {
    const secretValue = 'super-secret-xyz-never-leak';
    const mockServer = http.createServer((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'UNAUTHORIZED',
        message: 'Invalid bearer token.'
      }));
    });

    await new Promise(r => mockServer.listen(0, '127.0.0.1', r));
    const port = mockServer.address().port;

    try {
      const client = new VajraClient({
        baseUrl: `http://127.0.0.1:${port}`,
        secret: secretValue,
        enabled: true
      });

      await assert.rejects(
        async () => {
          await client.recordRetrievalProvenance({
            trace_id: 'trace-unauth-001',
            actor_id: 'tantra-execution',
            capability_id: 'cap-1',
            dataset_id: 'ds-1'
          });
        },
        (err) => {
          assert.equal(err.status, 401);
          // Crucial security check: secret must never be exposed in error message
          assert.equal(err.message.includes(secretValue), false);
          return true;
        }
      );
    } finally {
      await new Promise(r => mockServer.close(r));
    }
  });

  await t.test('7. Network timeout: aborts and returns 504 status', async () => {
    const mockServer = http.createServer((req, res) => {
      // Intentionally do not respond to trigger client timeout
    });

    await new Promise(r => mockServer.listen(0, '127.0.0.1', r));
    const port = mockServer.address().port;

    try {
      const client = new VajraClient({
        baseUrl: `http://127.0.0.1:${port}`,
        secret: 'test-secret',
        enabled: true,
        timeoutMs: 100 // Fast timeout
      });

      await assert.rejects(
        async () => {
          await client.recordRetrievalProvenance({
            trace_id: 'trace-timeout-001',
            actor_id: 'tantra-execution',
            capability_id: 'cap-1',
            dataset_id: 'ds-1'
          });
        },
        (err) => {
          assert.equal(err.status, 504);
          assert.match(err.message, /timed out/);
          return true;
        }
      );
    } finally {
      await new Promise(r => mockServer.close(r));
    }
  });
});
