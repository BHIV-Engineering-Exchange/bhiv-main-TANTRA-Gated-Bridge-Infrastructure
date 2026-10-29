try { require('dotenv').config(); } catch {}
const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const keyPersistence = require('./key_persistence');

const app = express();
app.use(express.json());

const log = (trace_id, execution_id, service_name, status, message) => {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    trace_id,
    execution_id,
    service_name,
    status,
    message
  }));
};

const tokenCache = new Map();
const REPLAY_TTL_MS = 3600000;

const tokenCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [jti, expiry] of tokenCache.entries()) {
    if (expiry <= now) {
      tokenCache.delete(jti);
    }
  }
}, 60000);
if (tokenCleanupInterval && tokenCleanupInterval.unref) tokenCleanupInterval.unref();

const keys = keyPersistence.loadOrGenerateKeys();
const RSA_PRIVATE_KEY = keys.rsa.privateKey;
const ED25519_PRIVATE_KEY = keys.ed25519.privateKey;
const KEY_META = keys.meta;

const rsaKid = KEY_META.algorithms.rs256.key_id;
const ed25519Kid = KEY_META.algorithms.eddsa.key_id;

log(null, null, 'sarathi', 'info', keys.generated ? 'Generated new RSA + Ed25519 key pairs' : 'Loaded existing RSA + Ed25519 key pairs');
log(null, null, 'sarathi', 'info', `RSA KID: ${rsaKid}, Ed25519 KID: ${ed25519Kid}`);

const ISSUER = process.env.ISSUER || 'tantra-sarathi';
const PORT = process.env.PORT || process.env.SARATHI_PORT || 3001;

function base64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

function base64urlDecode(str) {
  return Buffer.from(str, 'base64url').toString();
}

function signEdDSAToken(claims, keyid) {
  const header = { alg: 'EdDSA', kid: keyid, typ: 'JWT' };
  const headerB64 = base64urlEncode(JSON.stringify(header));
  const payloadB64 = base64urlEncode(JSON.stringify(claims));
  const signingInput = headerB64 + '.' + payloadB64;

  const privateKey = crypto.createPrivateKey(ED25519_PRIVATE_KEY);
  const signature = crypto.sign(null, Buffer.from(signingInput), privateKey);

  return signingInput + '.' + base64urlEncode(signature);
}

function signRS256Token(claims, keyid) {
  return jwt.sign(claims, RSA_PRIVATE_KEY, { algorithm: 'RS256', keyid });
}

function generateRsaJwk() {
  const publicKeyObj = crypto.createPublicKey(RSA_PRIVATE_KEY);
  const jwk = publicKeyObj.export({ format: 'jwk' });
  jwk.alg = 'RS256';
  jwk.kid = rsaKid;
  jwk.use = 'sig';
  return jwk;
}

function generateEd25519Jwk() {
  const publicKeyObj = crypto.createPublicKey(ED25519_PRIVATE_KEY);
  const jwk = publicKeyObj.export({ format: 'jwk' });
  jwk.alg = 'EdDSA';
  jwk.kid = ed25519Kid;
  jwk.use = 'sig';
  return jwk;
}

// Authoritative Service Principal Registry & Role Policy
// Callers CANNOT grant themselves arbitrary or elevated privileges.
const TRUSTED_SERVICE_POLICIES = {
  'tantra-execution': {
    allowedRoles: ['ecosystem-reader'],
    defaultRoles: ['ecosystem-reader'],
    allowedAudiences: ['tantra-bridge', 'masterdb'],
    defaultAudience: 'tantra-bridge'
  },
  'tantra-bridge': {
    allowedRoles: ['ecosystem-reader'],
    defaultRoles: ['ecosystem-reader'],
    allowedAudiences: ['tantra-bridge', 'masterdb'],
    defaultAudience: 'tantra-bridge'
  },
  'tantra-sdk': {
    allowedRoles: ['ecosystem-reader'],
    defaultRoles: ['ecosystem-reader'],
    allowedAudiences: ['tantra-bridge'],
    defaultAudience: 'tantra-bridge'
  }
};

app.get('/health', (req, res) => {
  res.json({ service: 'sarathi', status: 'healthy', issuer: ISSUER, algorithms: ['RS256', 'EdDSA'] });
});

app.post('/token', (req, res) => {
  const { trace_id, execution_id, cet_hash } = req.body;
  const algo = req.body.algorithm || 'EdDSA';

  if (!trace_id || !execution_id) {
    log(trace_id, execution_id, 'sarathi', 'error', 'Missing trace_id or execution_id');
    return res.status(400).json({ error: 'trace_id and execution_id required' });
  }

  const actor = req.body.actor || req.body.sub || 'tantra-execution';
  const policy = TRUSTED_SERVICE_POLICIES[actor];
  if (!policy) {
    log(trace_id, execution_id, 'sarathi', 'error', `Untrusted service principal: ${actor}`);
    return res.status(403).json({ error: `Untrusted service principal: ${actor}` });
  }

  // Caller cannot escalate privileges. If roles are explicitly supplied, they must be a subset of allowedRoles.
  let roles = policy.defaultRoles;
  if (Array.isArray(req.body.roles)) {
    const unauthorizedRoles = req.body.roles.filter(r => !policy.allowedRoles.includes(r));
    if (unauthorizedRoles.length > 0) {
      log(trace_id, execution_id, 'sarathi', 'error', `Privilege escalation attempt rejected for ${actor}: ${unauthorizedRoles.join(', ')}`);
      return res.status(403).json({
        error: `Privilege escalation denied: unauthorized roles requested for principal '${actor}': ${unauthorizedRoles.join(', ')}`
      });
    }
    roles = req.body.roles;
  }

  // Audience validation
  const requestedAudience = req.body.audience || req.body.aud || policy.defaultAudience;
  if (!policy.allowedAudiences.includes(requestedAudience)) {
    log(trace_id, execution_id, 'sarathi', 'error', `Unauthorized audience: ${requestedAudience}`);
    return res.status(400).json({
      error: `Invalid or unauthorized audience '${requestedAudience}' for principal '${actor}'`
    });
  }
  const audience = requestedAudience;

  const jti = crypto.randomUUID();
  const expiryMs = Date.now() + (parseInt(process.env.JWT_EXPIRY_MS) || 3600000);

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + (parseInt(process.env.JWT_EXPIRY_MS) || 3600000) / 1000;

  const claims = {
    trace_id,
    execution_id,
    actor,
    sub: actor,
    roles,
    iss: ISSUER,
    aud: audience,
    jti,
    iat,
    exp
  };

  if (cet_hash) {
    claims.cet_hash = cet_hash;
  }

  if (algo === 'RS256') {
    const token = signRS256Token(claims, rsaKid);
    tokenCache.set(jti, expiryMs);
    log(trace_id, execution_id, 'sarathi', 'success', `RS256 token issued with jti: ${jti}`);
    return res.json({ token, trace_id, execution_id, jti, algorithm: 'RS256' });
  }

  const token = signEdDSAToken(claims, ed25519Kid);
  tokenCache.set(jti, expiryMs);
  log(trace_id, execution_id, 'sarathi', 'success', `EdDSA token issued with jti: ${jti}`);
  res.json({ token, trace_id, execution_id, jti, algorithm: 'EdDSA' });
});

app.get('/public-key', (req, res) => {
  const publicKeyObj = crypto.createPublicKey(RSA_PRIVATE_KEY);
  res.json({ public_key: publicKeyObj.export({ format: 'pem', type: 'spki' }) });
});

app.get('/jwks', (req, res) => {
  const rsaJwk = generateRsaJwk();
  const ed25519Jwk = generateEd25519Jwk();
  res.json({ keys: [ed25519Jwk, rsaJwk] });
});

app.get('/.well-known/jwks.json', (req, res) => {
  const rsaJwk = generateRsaJwk();
  const ed25519Jwk = generateEd25519Jwk();
  res.json({ keys: [ed25519Jwk, rsaJwk] });
});

let server = null;
if (require.main === module) {
  server = app.listen(PORT, () => {
    log(null, null, 'sarathi', 'info', `Sarathi Authority Service running on port ${PORT}`);
  });
}

function gracefulShutdown(signal) {
  log(null, null, 'sarathi', 'info', `Received ${signal}, shutting down gracefully`);
  clearInterval(tokenCleanupInterval);
  server.close(() => {
    log(null, null, 'sarathi', 'info', 'Server closed');
    process.exit(0);
  });
  setTimeout(() => {
    log(null, null, 'sarathi', 'warn', 'Forced shutdown after timeout');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = { app, server, TRUSTED_SERVICE_POLICIES };
