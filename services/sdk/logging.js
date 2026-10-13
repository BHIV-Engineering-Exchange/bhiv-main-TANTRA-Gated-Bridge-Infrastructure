/**
 * Logging Module - TANTRA SDK
 *
 * Provides structured JSON logging consistent with the TANTRA platform
 * log format used across all services (sarathi, bridge, core, etc.).
 *
 * Format:
 *   { timestamp, trace_id, execution_id, service_name, status, message }
 */

const SERVICE_NAME = process.env.SERVICE_NAME || 'execution';

function formatLog(level, message, meta = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    trace_id: meta.trace_id ?? null,
    execution_id: meta.execution_id ?? null,
    service_name: meta.service || SERVICE_NAME,
    status: level,
    message,
  };
  return JSON.stringify(entry);
}

const log = {
  info(message, meta = {}) {
    console.log(formatLog('info', message, meta));
  },

  warn(message, meta = {}) {
    console.warn(formatLog('warn', message, meta));
  },

  error(message, meta = {}) {
    console.error(formatLog('error', message, meta));
  },

  success(message, meta = {}) {
    console.log(formatLog('success', message, meta));
  },

  debug(message, meta = {}) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(formatLog('debug', message, meta));
    }
  },
};

module.exports = log;
