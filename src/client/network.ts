import type {
  ClientMessage,
  ServerMessage,
} from '../shared/types.js';
import { parseServerMessage } from './parseServerMessage.js';

export interface NetworkCallbacks {
  onOpen: () => void;
  onMessage: (message: ServerMessage) => void;
  onInvalidMessage: () => void;
  onConnectionReplaced: () => void;
  onConnectionClosed: () => void;
}

export interface NetworkOptions {
  reconnectDelayMs?: number;
  wsUrlFactory?: () => string;
}

export class NetworkClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectEnabled = true;
  private readonly reconnectDelayMs: number;
  private readonly wsUrlFactory: () => string;

  public constructor(
    private readonly callbacks: NetworkCallbacks,
    options: NetworkOptions = {},
  ) {
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1500;
    this.wsUrlFactory = options.wsUrlFactory ?? defaultWsUrl;
  }

  public connect(): void {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      return;
    }

    this.reconnectEnabled = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const url = this.wsUrlFactory();
    this.ws = new WebSocket(url);

    this.ws.addEventListener('open', () => {
      this.callbacks.onOpen();
    });

    this.ws.addEventListener('message', (event) => {
      const message = parseServerMessage(event.data.toString());
      if (!message) {
        this.callbacks.onInvalidMessage();
        return;
      }
      this.callbacks.onMessage(message);
    });

    this.ws.addEventListener('close', (event) => {
      this.ws = null;
      this.callbacks.onConnectionClosed();

      if (event.code === 4001) {
        this.callbacks.onConnectionReplaced();
        return;
      }
      if (!this.reconnectEnabled) {
        return;
      }

      if (this.reconnectTimer !== null) {
        window.clearTimeout(this.reconnectTimer);
      }
      this.reconnectTimer = window.setTimeout(() => {
        this.connect();
      }, this.reconnectDelayMs);
    });
  }

  public send(message: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  public disconnect(): void {
    this.reconnectEnabled = false;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.close(1000, 'client_disconnect');
    }
    this.ws = null;
  }
}

export function defaultWsUrl(): string {
  const env = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env.VITE_WS_URL;
  if (env) {
    return env;
  }

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const port = window.location.port === '5173' ? '8080' : window.location.port;
  return `${proto}//${window.location.hostname}${port ? `:${port}` : ''}/ws`;
}
