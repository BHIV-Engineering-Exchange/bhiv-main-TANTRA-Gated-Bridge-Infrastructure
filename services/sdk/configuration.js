/**
 * Configuration Module
 * 
 * Manages service configuration from environment variables.
 */

class Configuration {
  constructor() {
    this.config = this.loadConfig();
  }

  loadConfig() {
    return {
      service: {
        name: process.env.SERVICE_NAME || 'unknown',
        port: parseInt(process.env.PORT) || 3000,
        host: process.env.HOST || '0.0.0.0',
        env: process.env.NODE_ENV || 'development'
      },
      sarathi: {
        url: process.env.SARATHI_URL || 'http://localhost:3001',
        timeoutMs: parseInt(process.env.SARATHI_TIMEOUT_MS) || 25000
      },
      bridge: {
        url: process.env.BRIDGE_URL || 'http://localhost:3002',
        timeoutMs: parseInt(process.env.BRIDGE_TIMEOUT_MS) || 30000
      },
      execution: {
        url: process.env.EXECUTION_URL || 'http://localhost:3003',
        timeoutMs: parseInt(process.env.EXECUTION_TIMEOUT_MS) || 25000
      },
      bucket: {
        url: process.env.BUCKET_URL || 'http://localhost:3004',
        timeoutMs: parseInt(process.env.BUCKET_TIMEOUT_MS) || 15000,
        requesterId: process.env.BUCKET_REQUESTER_ID || 'tantra-core'
      },
      insightflow: {
        url: process.env.INSIGHTFLOW_URL || 'http://localhost:3005',
        apiKey: process.env.INSIGHTFLOW_API_KEY || '',
        enabled: process.env.INSIGHTFLOW_ENABLED === 'true',
        timeoutMs: parseInt(process.env.INSIGHTFLOW_TIMEOUT_MS) || 10000
      },
      masterdb: {
        url: process.env.MASTERDB_URL || 'http://localhost:8080',
        timeoutMs: parseInt(process.env.MASTERDB_TIMEOUT_MS) || 10000,
        applicationId: process.env.MASTERDB_APPLICATION_ID || 'app-tantra-gated-bridge',
        defaultCapabilityId: process.env.MASTERDB_CAPABILITY_ID || 'cap-mangrove-monitoring',
        defaultPurpose: process.env.MASTERDB_PURPOSE || 'environmental_monitoring'
      },
      vajra: {
        url: process.env.VAJRA_URL || 'http://localhost:8080',
        secret: process.env.VAJRA_TANTRA_SECRET || '',
        timeoutMs: parseInt(process.env.VAJRA_TIMEOUT_MS) || 5000,
        enabled: process.env.VAJRA_PROVENANCE_ENABLED === 'true'
      },
      jwt: {
        expiry: process.env.JWT_EXPIRY || '1h',
        expiryMs: parseInt(process.env.JWT_EXPIRY_MS) || 3600000
      },
      replay: {
        ttlMs: parseInt(process.env.REPLAY_TTL_MS) || 3600000
      }
    };
  }

  get(path) {
    return path.split('.').reduce((obj, key) => obj && obj[key], this.config);
  }

  getAll() {
    return { ...this.config };
  }

  update(path, value) {
    const keys = path.split('.');
    let obj = this.config;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!obj[keys[i]]) obj[keys[i]] = {};
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;
  }
}

module.exports = new Configuration();
