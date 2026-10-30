/**
 * MASTERDB Governed Capability Client
 *
 * Provides integration between TANTRA Gated Bridge execution runtime
 * and MASTERDB Backend Ingestion & Certification Service.
 *
 * Uses native fetch and crypto with zero external runtime dependencies.
 * Implements strict fail-closed timeout and verification semantics.
 */

const crypto = require('crypto');

class MasterDbClient {
  /**
   * @param {Object} options
   * @param {string} [options.baseUrl] - MASTERDB base URL (default: http://localhost:8080)
   * @param {number} [options.timeoutMs] - Request timeout in milliseconds (default: 10000)
   * @param {string} [options.applicationId] - Calling application identifier
   */
  constructor(options = {}) {
    const configuredUrl = options.baseUrl || process.env.MASTERDB_URL;
    if (!configuredUrl && process.env.NODE_ENV === 'production') {
      throw new Error('MASTERDB_URL is not configured in production environment');
    }
    this.baseUrl = (configuredUrl || 'http://localhost:8080').replace(/\/+$/, '');
    if (this.baseUrl && !this.baseUrl.startsWith('http://') && !this.baseUrl.startsWith('https://')) {
      throw new Error(`Invalid MASTERDB_URL: "${this.baseUrl}". Must begin with http:// or https://`);
    }
    this.timeoutMs = options.timeoutMs || parseInt(process.env.MASTERDB_TIMEOUT_MS) || 10000;
    this.applicationId = options.applicationId || process.env.MASTERDB_APPLICATION_ID || 'app-tantra-gated-bridge';
  }

  /**
   * Internal fetch wrapper with timeout and fail-closed error handling.
   */
  async _request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal
      });

      clearTimeout(timer);

      let data;
      const text = await response.text();
      try {
        data = text ? JSON.parse(text) : {};
      } catch (err) {
        data = { raw: text };
      }

      if (!response.ok) {
        const errorMsg = (data && (data.detail || data.error || data.message)) || `HTTP ${response.status} ${response.statusText}`;
        const error = new Error(`MASTERDB request failed [${response.status}]: ${errorMsg}`);
        error.status = response.status;
        error.response = data;
        error.endpoint = endpoint;
        throw error;
      }

      return data;
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        const timeoutError = new Error(`MASTERDB request timed out after ${this.timeoutMs}ms: ${endpoint}`);
        timeoutError.status = 504;
        throw timeoutError;
      }
      throw err;
    }
  }

  /**
   * Discover registered capabilities.
   * @param {Object} [filter]
   * @param {string} [filter.domain]
   * @param {string} [filter.status]
   * @returns {Promise<Array<Object>>}
   */
  async discoverCapabilities(filter = {}, token = null) {
    let actualFilter = filter;
    let actualToken = token;
    if (typeof filter === 'string') {
      actualToken = filter;
      actualFilter = token && typeof token === 'object' ? token : {};
    }
    const params = new URLSearchParams();
    if (actualFilter.domain) params.append('domain', actualFilter.domain);
    if (actualFilter.status) params.append('status', actualFilter.status);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const headers = actualToken ? { 'Authorization': `Bearer ${actualToken}` } : {};
    return await this._request(`/capabilities${qs}`, { method: 'GET', headers });
  }

  /**
   * Get capability contract definition.
   * @param {string} capabilityId
   * @param {string} [token] - Optional Sarathi RS256 JWT
   * @returns {Promise<Object>}
   */
  async getContract(capabilityId, token = null) {
    if (!capabilityId) throw new Error('capabilityId is required');
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
    return await this._request(`/capabilities/${encodeURIComponent(capabilityId)}/contract`, { method: 'GET', headers });
  }

  /**
   * Request access grant for a capability.
   * @param {Object} params
   * @param {string} params.token - Sarathi RS256 JWT
   * @param {string} params.capabilityId - Target capability ID
   * @param {string} [params.applicationId] - Consumer application ID
   * @param {string} [params.purpose] - Declared purpose
   * @param {number} [params.requestedTtlSeconds] - Grant TTL (default: 3600)
   * @returns {Promise<Object>} Access grant with access_token and request_id
   */
  async requestAccess({ token, capabilityId, applicationId, purpose, requestedTtlSeconds = 3600 }) {
    if (!token) throw new Error('Sarathi JWT token is required for access request');
    if (!capabilityId) throw new Error('capabilityId is required');

    const body = {
      application_id: applicationId || this.applicationId,
      capability_id: capabilityId,
      purpose: purpose || 'environmental_monitoring',
      requested_ttl_seconds: requestedTtlSeconds
    };

    return await this._request('/access/request', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(body)
    });
  }

  /**
   * Retrieve certified capability data using an access grant.
   * @param {Object} params
   * @param {string} params.token - Sarathi RS256 JWT
   * @param {string} params.grantToken - Grant token returned from requestAccess (access_token)
   * @param {string} params.capabilityId - Target capability ID
   * @param {string} [params.applicationId] - Consumer application ID
   * @param {Object} [params.queryParams] - Query filter parameters
   * @param {string} [params.traceId] - Distributed trace ID
   * @param {string} [params.executionId] - Workload execution ID
   * @returns {Promise<Object>} Retrieved capability payload with records and digest
   */
  async retrieveData({ token, grantToken, capabilityId, applicationId, queryParams = {}, traceId = null, executionId = null }) {
    if (!token) throw new Error('Sarathi JWT token is required for retrieval');
    if (!grantToken) throw new Error('grantToken is required for retrieval');
    if (!capabilityId) throw new Error('capabilityId is required');

    const body = {
      application_id: applicationId || this.applicationId,
      access_token: grantToken,
      query_params: queryParams,
      trace_id: traceId,
      execution_id: executionId
    };

    return await this._request(`/capabilities/${encodeURIComponent(capabilityId)}/retrieve`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(body)
    });
  }
}

module.exports = MasterDbClient;
