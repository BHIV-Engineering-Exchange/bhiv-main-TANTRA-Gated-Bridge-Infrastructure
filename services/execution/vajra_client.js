/**
 * VAJRA Provenance Dispatch Client
 *
 * Provides bounded, secure dispatch of governed dataset retrieval provenance
 * from TANTRA execution runtime to the VAJRA TrustStore receiver.
 *
 * Contract: POST /api/vajra/provenance/retrieval
 * Auth: Authorization: Bearer <VAJRA_TANTRA_SECRET>
 *
 * Uses native fetch and crypto with zero external runtime dependencies.
 * Fails closed on missing required fields or missing credentials when enabled.
 * Defaults to disabled (VAJRA_PROVENANCE_ENABLED=false) until explicitly enabled.
 */

class VajraClient {
  /**
   * @param {Object} [options]
   * @param {string} [options.baseUrl] - VAJRA base URL (default: VAJRA_URL or http://localhost:8080)
   * @param {string} [options.secret] - VAJRA pre-shared secret (default: VAJRA_TANTRA_SECRET)
   * @param {number} [options.timeoutMs] - Request timeout in milliseconds (default: 5000)
   * @param {boolean} [options.enabled] - Whether provenance dispatch is active (default: VAJRA_PROVENANCE_ENABLED === 'true')
   */
  constructor(options = {}) {
    const configuredUrl = options.baseUrl || process.env.VAJRA_URL;
    this.baseUrl = (configuredUrl || 'http://localhost:8080').replace(/\/+$/, '');
    if (this.baseUrl && !this.baseUrl.startsWith('http://') && !this.baseUrl.startsWith('https://')) {
      throw new Error(`Invalid VAJRA_URL: "${this.baseUrl}". Must begin with http:// or https://`);
    }

    this.secret = options.secret !== undefined ? options.secret : (process.env.VAJRA_TANTRA_SECRET || '');
    this.timeoutMs = options.timeoutMs || parseInt(process.env.VAJRA_TIMEOUT_MS) || 5000;
    this.enabled = options.enabled !== undefined ? options.enabled : (process.env.VAJRA_PROVENANCE_ENABLED === 'true');
  }

  /**
   * Check whether VAJRA provenance dispatch is enabled.
   * @returns {boolean}
   */
  isEnabled() {
    return this.enabled === true;
  }

  /**
   * Record governed dataset retrieval provenance in VAJRA TrustStore.
   *
   * @param {Object} params
   * @param {string} params.trace_id - Primary trace correlation ID (required)
   * @param {string} params.actor_id - Authenticated actor performing retrieval (required)
   * @param {string} params.capability_id - MASTERDB capability ID (required)
   * @param {string} params.dataset_id - Target dataset identifier (required)
   * @param {string} [params.access_grant_ref] - Reference to access grant (request_id or grant token)
   * @param {string} [params.workflow_id] - Workload execution ID
   * @param {number} [params.record_count] - Count of retrieved records
   * @param {string} [params.content_digest] - Content digest (SHA-256)
   * @param {string} [params.retrieval_outcome] - Outcome (default: SUCCESS)
   * @param {Object} [params.metadata] - Non-sensitive metadata
   * @returns {Promise<Object>} Receipt details or skipped status
   */
  async recordRetrievalProvenance(params = {}) {
    if (!this.isEnabled()) {
      return {
        recorded: false,
        skipped: true,
        reason: 'VAJRA_PROVENANCE_DISABLED'
      };
    }

    // Validate required fields per VAJRA contract
    const missing = [];
    if (!params.trace_id) missing.push('trace_id');
    if (!params.actor_id) missing.push('actor_id');
    if (!params.capability_id) missing.push('capability_id');
    if (!params.dataset_id) missing.push('dataset_id');

    if (missing.length > 0) {
      const err = new Error(`Missing required fields for VAJRA provenance: ${missing.join(', ')}`);
      err.status = 400;
      err.missing_fields = missing;
      throw err;
    }

    // Fail closed if secret is not configured
    if (!this.secret || this.secret.trim() === '') {
      const err = new Error('VAJRA_TANTRA_SECRET is not configured; route is locked down');
      err.status = 401;
      throw err;
    }

    const payload = {
      trace_id: params.trace_id,
      actor_id: params.actor_id,
      capability_id: params.capability_id,
      dataset_id: params.dataset_id,
      ...(params.access_grant_ref ? { access_grant_ref: params.access_grant_ref } : {}),
      ...(params.workflow_id ? { workflow_id: params.workflow_id } : {}),
      ...(params.record_count !== undefined && params.record_count !== null ? { record_count: params.record_count } : {}),
      ...(params.content_digest ? { content_digest: params.content_digest } : {}),
      retrieval_outcome: params.retrieval_outcome || 'SUCCESS',
      ...(params.metadata && typeof params.metadata === 'object' ? { metadata: params.metadata } : {})
    };

    const url = `${this.baseUrl}/api/vajra/provenance/retrieval`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.secret}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timer);

      let data;
      const text = await response.text();
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }

      // Idempotency: duplicate trace_id returns 409 Conflict with duplicate: true
      if (response.status === 409 && data && data.duplicate) {
        return {
          recorded: true,
          duplicate: true,
          trace_id: params.trace_id,
          existing_hash: data.existing_hash,
          recorded_at: data.recorded_at
        };
      }

      if (!response.ok) {
        const errorMsg = (data && (data.message || data.error || data.details)) || `HTTP ${response.status} ${response.statusText}`;
        const error = new Error(`VAJRA provenance request failed [${response.status}]: ${errorMsg}`);
        error.status = response.status;
        error.response = data;
        throw error;
      }

      return {
        recorded: true,
        success: true,
        trace_id: data.trace_id || params.trace_id,
        evidence_hash: data.evidence_hash,
        stored_in: data.stored_in || ['TruthStore (data/tantra_truth.jsonl)'],
        recorded_at: data.recorded_at
      };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        const timeoutError = new Error(`VAJRA provenance request timed out after ${this.timeoutMs}ms`);
        timeoutError.status = 504;
        throw timeoutError;
      }
      throw err;
    }
  }
}

module.exports = VajraClient;
