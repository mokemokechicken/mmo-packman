import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { TICK_MS } from '../shared/constants.js';
import type {
  ClientMessage,
  Difficulty,
  LobbyPlayer,
  ServerMessage,
} from '../shared/types.js';
import { GameEngine, type StartPlayer } from './game.js';

interface ClientContext {
  id: string;
  ws: WebSocket;
  playerId: string | null;
}

interface LobbyPlayerInternal extends LobbyPlayer {
  reconnectToken: string;
}

const PORT = Number(process.env.PORT ?? 8080);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});

const distClientDir = path.resolve(process.cwd(), 'dist/client');
if (fs.existsSync(distClientDir)) {
  app.use(express.static(distClientDir));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distClientDir, 'index.html'));
  });
}

const clients = new Map<string, ClientContext>();
const lobbyPlayers = new Map<string, LobbyPlayerInternal>();

let hostId: string | null = null;
let game: GameEngine | null = null;
let loop: NodeJS.Timeout | null = null;

wss.on('connection', (ws) => {
  const clientId = randomUUID();
  const ctx: ClientContext = { id: clientId, ws, playerId: null };
  clients.set(clientId, ctx);

  ws.on('message', (raw) => {
    const message = parseMessage(raw.toString());
    if (!message) {
      send(ctx.ws, { type: 'error', message: 'invalid message' });
      return;
    }

    if (message.type === 'hello') {
      handleHello(ctx, message.name, message.reconnectToken);
      return;
    }

    if (message.type === 'ping') {
      send(ctx.ws, { type: 'pong', t: message.t });
      return;
    }

    if (!ctx.playerId) {
      send(ctx.ws, { type: 'error', message: 'send hello first' });
      return;
    }

    if (message.type === 'lobby_start') {
      handleLobbyStart(ctx.playerId, message.difficulty ?? 'normal');
      return;
    }

    if (message.type === 'input' && game) {
      game.receiveInput(ctx.playerId, { dir: message.dir, awaken: message.awaken });
      return;
    }
  });

  ws.on('close', () => {
    clients.delete(clientId);
    if (!ctx.playerId) {
      return;
    }

    const player = lobbyPlayers.get(ctx.playerId);
    if (!player) {
      return;
    }

    if (game) {
      player.connected = false;
      player.ai = true;
      game.setPlayerConnection(ctx.playerId, false);
    } else {
      lobbyPlayers.delete(ctx.playerId);
      if (hostId === ctx.playerId) {
        hostId = chooseNextHost();
      }
    }

    broadcastLobby();
  });
});

server.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
});

function handleHello(ctx: ClientContext, requestedName: string, reconnectToken?: string): void {
  const name = sanitizeName(requestedName);
  const existing = reconnectToken ? findPlayerByToken(reconnectToken) : null;

  if (game) {
    if (!existing || !game.hasPlayer(existing.id)) {
      send(ctx.ws, { type: 'error', message: 'game already running; reconnection only' });
      return;
    }

    existing.connected = true;
    existing.ai = false;
    ctx.playerId = existing.id;
    game.setPlayerConnection(existing.id, true);

    send(ctx.ws, {
      type: 'welcome',
      playerId: existing.id,
      reconnectToken: existing.reconnectToken,
      isHost: hostId === existing.id,
    });

    send(ctx.ws, {
      type: 'game_init',
      meId: existing.id,
      world: game.getWorldInit(),
      config: game.config,
      startedAtMs: game.startedAtMs,
    });

    send(ctx.ws, {
      type: 'state',
      snapshot: game.buildSnapshot(false),
    });

    broadcastLobby();
    return;
  }

  if (existing) {
    existing.connected = true;
    existing.ai = false;
    existing.name = name;
    ctx.playerId = existing.id;

    send(ctx.ws, {
      type: 'welcome',
      playerId: existing.id,
      reconnectToken: existing.reconnectToken,
      isHost: hostId === existing.id,
    });

    broadcastLobby();
    return;
  }

  const playerId = randomUUID();
  const token = randomUUID();
  const player: LobbyPlayerInternal = {
    id: playerId,
    name,
    connected: true,
    ai: false,
    isHost: false,
    reconnectToken: token,
  };
  lobbyPlayers.set(player.id, player);
  ctx.playerId = player.id;

  if (!hostId) {
    hostId = player.id;
  }

  send(ctx.ws, {
    type: 'welcome',
    playerId: player.id,
    reconnectToken: token,
    isHost: hostId === player.id,
  });

  broadcastLobby();
}

function handleLobbyStart(requestedBy: string, difficulty: Difficulty): void {
  if (game) {
    return;
  }
  if (requestedBy !== hostId) {
    const target = getClientByPlayerId(requestedBy);
    if (target) {
      send(target.ws, { type: 'error', message: 'only host can start' });
    }
    return;
  }

  const participants = Array.from(lobbyPlayers.values()).filter((player) => player.connected);
  if (participants.length === 0) {
    return;
  }

  const startPlayers: StartPlayer[] = participants.map((player) => ({
    id: player.id,
    name: player.name,
    reconnectToken: player.reconnectToken,
    connected: player.connected,
  }));

  game = new GameEngine(startPlayers, difficulty);

  for (const player of lobbyPlayers.values()) {
    if (!game.hasPlayer(player.id)) {
      lobbyPlayers.delete(player.id);
      continue;
    }
    player.ai = !player.connected;
  }

  broadcastLobby('ゲーム開始');

  for (const player of startPlayers) {
    const client = getClientByPlayerId(player.id);
    if (!client) {
      continue;
    }
    send(client.ws, {
      type: 'game_init',
      meId: player.id,
      world: game.getWorldInit(),
      config: game.config,
      startedAtMs: game.startedAtMs,
    });
  }

  loop = setInterval(() => {
    const running = game;
    if (!running) {
      return;
    }

    running.step(TICK_MS);
    const snapshot = running.buildSnapshot(true);
    broadcast({ type: 'state', snapshot });

    if (running.isEnded()) {
      const summary = running.buildSummary();
      broadcast({ type: 'game_over', summary });

      if (loop) {
        clearInterval(loop);
        loop = null;
      }

      game = null;
      hostId = hostId && lobbyPlayers.has(hostId) ? hostId : chooseNextHost();
      for (const player of lobbyPlayers.values()) {
        player.ai = false;
      }
      broadcastLobby('ゲーム終了。再スタート可能です');
    }
  }, TICK_MS);
}

function broadcastLobby(note?: string): void {
  const ordered = Array.from(lobbyPlayers.values())
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
    .map((player) => ({
      id: player.id,
      name: player.name,
      connected: player.connected,
      ai: player.ai,
      isHost: player.id === hostId,
    }));

  broadcast({
    type: 'lobby',
    players: ordered,
    hostId,
    canStart: !!hostId && ordered.some((p) => p.id === hostId && p.connected),
    running: !!game,
    note,
  });
}

function broadcast(message: ServerMessage): void {
  const payload = JSON.stringify(message);
  for (const ctx of clients.values()) {
    if (ctx.ws.readyState === ctx.ws.OPEN) {
      ctx.ws.send(payload);
    }
  }
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState !== ws.OPEN) {
    return;
  }
  ws.send(JSON.stringify(message));
}

function parseMessage(raw: string): ClientMessage | null {
  try {
    const value = JSON.parse(raw) as ClientMessage;
    if (!value || typeof value !== 'object' || !('type' in value)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function sanitizeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return 'Player';
  }
  return trimmed.slice(0, 16);
}

function chooseNextHost(): string | null {
  for (const player of lobbyPlayers.values()) {
    if (player.connected) {
      return player.id;
    }
  }
  return lobbyPlayers.values().next().value?.id ?? null;
}

function findPlayerByToken(token: string): LobbyPlayerInternal | null {
  for (const player of lobbyPlayers.values()) {
    if (player.reconnectToken === token) {
      return player;
    }
  }
  return null;
}

function getClientByPlayerId(playerId: string): ClientContext | null {
  for (const client of clients.values()) {
    if (client.playerId === playerId) {
      return client;
    }
  }
  return null;
}
