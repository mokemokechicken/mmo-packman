import assert from 'node:assert/strict';
import { NetworkClient } from './network.js';

type Listener = (event: any) => void;

class MockWebSocket {
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;
  public static instances: MockWebSocket[] = [];

  public readonly OPEN = MockWebSocket.OPEN;
  public readyState = MockWebSocket.CONNECTING;
  public emitCloseOnClose = true;
  public readonly sent: string[] = [];
  private readonly listeners: Record<string, Listener[]> = {
    open: [],
    message: [],
    close: [],
  };

  public constructor(public readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  public addEventListener(type: string, listener: Listener): void {
    this.listeners[type]?.push(listener);
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    if (this.emitCloseOnClose) {
      this.emit('close', { code, reason });
    }
  }

  public emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.emit('open', {});
  }

  public emitMessage(data: string): void {
    this.emit('message', { data });
  }

  public emitClose(code: number): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', { code });
  }

  private emit(type: string, event: any): void {
    for (const listener of this.listeners[type] ?? []) {
      listener(event);
    }
  }
}

interface TimerTask {
  id: number;
  fn: () => void;
}

function installMocks(): { timers: TimerTask[]; restore: () => void } {
  const root = globalThis as unknown as {
    window: {
      setTimeout: (fn: () => void, delay?: number) => number;
      clearTimeout: (id: number) => void;
    };
    WebSocket: typeof MockWebSocket;
  };
  const previousWindow = root.window;
  const previousWebSocket = root.WebSocket;

  let nextId = 1;
  const timers: TimerTask[] = [];
  root.window = {
    setTimeout(fn: () => void) {
      const id = nextId;
      nextId += 1;
      timers.push({ id, fn });
      return id;
    },
    clearTimeout(id: number) {
      const idx = timers.findIndex((task) => task.id === id);
      if (idx >= 0) {
        timers.splice(idx, 1);
      }
    },
  };
  root.WebSocket = MockWebSocket;

  MockWebSocket.instances = [];
  return {
    timers,
    restore: () => {
      root.window = previousWindow;
      root.WebSocket = previousWebSocket;
      MockWebSocket.instances = [];
    },
  };
}

function testDisconnectDisablesReconnect(): void {
  const { timers, restore } = installMocks();
  try {
    const client = new NetworkClient(
      {
        onOpen() {},
        onMessage() {},
        onInvalidMessage() {},
        onConnectionReplaced() {},
        onConnectionClosed() {},
      },
      { wsUrlFactory: () => 'ws://test' },
    );

    client.connect();
    assert.equal(MockWebSocket.instances.length, 1);
    const socket = MockWebSocket.instances[0] as MockWebSocket;
    socket.emitOpen();

    client.disconnect();
    assert.equal(timers.length, 0);
  } finally {
    restore();
  }
}

function testConnectIdempotencyAndReconnect(): void {
  const { timers, restore } = installMocks();
  try {
    let invalidCount = 0;
    let validCount = 0;
    const client = new NetworkClient(
      {
        onOpen() {},
        onMessage() {
          validCount += 1;
        },
        onInvalidMessage() {
          invalidCount += 1;
        },
        onConnectionReplaced() {},
        onConnectionClosed() {},
      },
      { wsUrlFactory: () => 'ws://test', reconnectDelayMs: 10 },
    );

    client.connect();
    client.connect();
    assert.equal(MockWebSocket.instances.length, 1);

    const socket = MockWebSocket.instances[0] as MockWebSocket;
    socket.emitOpen();
    socket.emitMessage('not-json');
    socket.emitMessage('{"type":"error","message":"oops"}');
    assert.equal(invalidCount, 1);
    assert.equal(validCount, 1);

    socket.emitClose(1006);
    assert.equal(timers.length, 1);

    const reconnectTask = timers[0] as TimerTask;
    timers.splice(0, 1);
    reconnectTask.fn();
    assert.equal(MockWebSocket.instances.length, 2);
  } finally {
    restore();
  }
}

function testConnectionReplacedDoesNotReconnect(): void {
  const { timers, restore } = installMocks();
  try {
    let replacedCount = 0;
    const client = new NetworkClient(
      {
        onOpen() {},
        onMessage() {},
        onInvalidMessage() {},
        onConnectionReplaced() {
          replacedCount += 1;
        },
        onConnectionClosed() {},
      },
      { wsUrlFactory: () => 'ws://test' },
    );

    client.connect();
    const socket = MockWebSocket.instances[0] as MockWebSocket;
    socket.emitOpen();
    socket.emitClose(4001);

    assert.equal(replacedCount, 1);
    assert.equal(timers.length, 0);
  } finally {
    restore();
  }
}

function testStaleCloseDoesNotBreakNewConnection(): void {
  const { timers, restore } = installMocks();
  try {
    const client = new NetworkClient(
      {
        onOpen() {},
        onMessage() {},
        onInvalidMessage() {},
        onConnectionReplaced() {},
        onConnectionClosed() {},
      },
      { wsUrlFactory: () => 'ws://test' },
    );

    client.connect();
    const socketA = MockWebSocket.instances[0] as MockWebSocket;
    socketA.emitOpen();
    socketA.emitCloseOnClose = false;

    client.disconnect();
    client.connect();
    const socketB = MockWebSocket.instances[1] as MockWebSocket;
    socketB.emitOpen();

    client.send({ type: 'ping', t: 1 });
    assert.equal(socketB.sent.length, 1);

    socketA.emitClose(1000);
    assert.equal(timers.length, 0);

    client.send({ type: 'ping', t: 2 });
    assert.equal(socketB.sent.length, 2);
  } finally {
    restore();
  }
}

function run(): void {
  testDisconnectDisablesReconnect();
  testConnectIdempotencyAndReconnect();
  testConnectionReplacedDoesNotReconnect();
  testStaleCloseDoesNotBreakNewConnection();
  console.log('client network selftest: OK');
}

run();
