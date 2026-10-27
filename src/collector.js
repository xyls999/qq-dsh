import { WebSocket } from 'ws';
import { normalizeEvent } from './normalize-event.js';

const MAX_EVENT_BYTES = 1_048_576;

/**
 * Creates a read-only OneBot event collector with local reconnection-gap tracking.
 * @param {{config: object, store: object, pseudonymKey: Buffer, token?: string, WebSocketImpl?: typeof WebSocket, onStatus?: (status: object) => void}} options Validated local settings and dependencies.
 * @returns {{start(): Promise<object>, stop(): Promise<void>, status(): object}} Collector lifecycle controls.
 */
export function createCollector(options) {
  const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  let started = false;
  let socket = null;
  let reconnectTimer = null;
  let gapStartedAtMs = null;
  let state = options.config.enabled ? 'stopped' : 'disabled';
  let lastMessageAtMs = null;
  let lastError = null;
  let disconnectCount = 0;
  const publish = () => options.onStatus?.({ state, lastMessageAtMs, lastError, disconnectCount, gapStartedAtMs });

  const scheduleReconnect = () => {
    if (!started || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, options.config.reconnectMs);
    reconnectTimer.unref?.();
  };

  const connect = () => {
    if (!started) return;
    state = 'connecting';
    lastError = null;
    publish();
    let connection;
    try {
      const headers = options.token ? { Authorization: `Bearer ${options.token}` } : {};
      connection = new WebSocketImpl(options.config.wsUrl, { headers, maxPayload: MAX_EVENT_BYTES });
      socket = connection;
    } catch {
      state = 'disconnected';
      lastError = 'connection_error';
      publish();
      scheduleReconnect();
      return;
    }

    connection.on('open', () => {
      if (!started || socket !== connection) return;
      state = 'connected';
      lastError = null;
      if (gapStartedAtMs !== null) {
        try {
          options.store.recordGap({ fromMs: gapStartedAtMs, toMs: Date.now() });
        } catch {
          lastError = 'storage_error';
        }
        gapStartedAtMs = null;
      }
      publish();
    });

    connection.on('message', (data) => {
      if (!started || socket !== connection) return;
      if (data.length > MAX_EVENT_BYTES) {
        lastError = 'malformed_event';
        publish();
        return;
      }
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        lastError = 'malformed_event';
        publish();
        return;
      }
      const record = normalizeEvent(event, {
        groupId: options.config.groupId,
        selfId: event?.self_id,
        pseudonymKey: options.pseudonymKey,
      });
      if (!record) return;
      try {
        options.store.insertMessage(record);
        lastMessageAtMs = Date.now();
        lastError = null;
      } catch {
        lastError = 'storage_error';
      }
    });

    connection.on('error', () => {
      if (started && socket === connection) {
        lastError = 'connection_error';
        publish();
      }
    });

    connection.on('close', () => {
      if (socket !== connection) return;
      socket = null;
      if (!started) return;
      state = 'disconnected';
      gapStartedAtMs = Date.now();
      disconnectCount += 1;
      publish();
      scheduleReconnect();
    });
  };

  return {
    async start() {
      if (!options.config.enabled) {
        state = 'disabled';
        publish();
        return { started: false, reason: 'disabled' };
      }
      if (!options.token) throw new Error('OneBot access token is required in the local environment');
      if (started) return { started: true, reason: 'already_started' };
      started = true;
      connect();
      return { started: true };
    },

    async stop() {
      started = false;
      if (gapStartedAtMs !== null) {
        try {
          options.store.recordGap({ fromMs: gapStartedAtMs, toMs: Date.now() });
        } catch {
          lastError = 'storage_error';
        }
        gapStartedAtMs = null;
      }
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const current = socket;
      socket = null;
      if (current && current.readyState !== WebSocketImpl.CLOSED) current.close();
      state = 'stopped';
      publish();
    },

    status() {
      return { state, lastMessageAtMs, lastError, disconnectCount, gapStartedAtMs };
    },
  };
}
