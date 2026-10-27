const TARGET_GROUP_ID = '1072362245';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

/**
 * Validates the local archive settings and supplies safe collection defaults.
 * @param {unknown} input Raw JSON configuration.
 * @returns {{enabled: boolean, modelExportEnabled: boolean, groupId: string, wsUrl: string, rawRetentionDays: number, summaryRetentionDays: number}} Validated settings.
 */
export function parseConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('config must be an object');
  }

  const config = /** @type {Record<string, unknown>} */ (input);
  const groupId = config.groupId;
  if (groupId !== TARGET_GROUP_ID) throw new Error(`groupId must match target group ${TARGET_GROUP_ID}`);

  const wsUrl = config.wsUrl ?? 'ws://127.0.0.1:3001';
  if (typeof wsUrl !== 'string') throw new Error('wsUrl must be a loopback WebSocket URL');
  let endpoint;
  try {
    endpoint = new URL(wsUrl);
  } catch {
    throw new Error('wsUrl must be a loopback WebSocket URL');
  }
  if (endpoint.protocol !== 'ws:' || !LOOPBACK_HOSTS.has(endpoint.hostname.toLowerCase())
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || (endpoint.pathname !== '/' && endpoint.pathname !== '')) {
    throw new Error('wsUrl must use a loopback WebSocket endpoint');
  }
  const port = Number(endpoint.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('wsUrl must include a valid loopback port');
  }

  const enabled = config.enabled ?? false;
  if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
  const modelExportEnabled = config.modelExportEnabled ?? false;
  if (typeof modelExportEnabled !== 'boolean') throw new Error('modelExportEnabled must be a boolean');
  const rawRetentionDays = config.rawRetentionDays ?? 30;
  const summaryRetentionDays = config.summaryRetentionDays ?? 90;
  const reconnectMs = config.reconnectMs ?? 1000;
  if (!Number.isSafeInteger(reconnectMs) || reconnectMs < 250 || reconnectMs > 60_000) {
    throw new Error('reconnect interval must be between 250 and 60000 milliseconds');
  }
  const configPollMs = config.configPollMs ?? 1000;
  if (!Number.isSafeInteger(configPollMs) || configPollMs < 250 || configPollMs > 60_000) {
    throw new Error('config polling interval must be between 250 and 60000 milliseconds');
  }
  const maintenancePollMs = config.maintenancePollMs ?? 3_600_000;
  if (!Number.isSafeInteger(maintenancePollMs) || maintenancePollMs < 60_000 || maintenancePollMs > 86_400_000) {
    throw new Error('maintenance polling interval must be between 60000 and 86400000 milliseconds');
  }
  for (const [name, days] of [['rawRetentionDays', rawRetentionDays], ['summaryRetentionDays', summaryRetentionDays]]) {
    if (!Number.isSafeInteger(days) || days < 1 || days > 3650) throw new Error(`${name} retention must be between 1 and 3650 days`);
  }

  return {
    enabled,
    modelExportEnabled,
    groupId,
    wsUrl: endpoint.toString(),
    rawRetentionDays,
    summaryRetentionDays,
    reconnectMs,
    configPollMs,
    maintenancePollMs,
  };
}
