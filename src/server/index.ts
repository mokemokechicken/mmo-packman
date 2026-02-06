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
let runningAiCount = 0;

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
      handleHello(ctx, message.name, !!message.spectator, message.reconnectToken);
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
      handleLobbyStart(
        ctx.playerId,
        message.difficulty ?? 'normal',
        message.aiPlayerCount,
        message.timeLimitMinutes,
      );
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

    const member = lobbyPlayers.get(ctx.playerId);
    if (!member) {
      return;
    }

    if (game) {
      if (member.spectator) {
        lobbyPlayers.delete(member.id);
      } else {
        member.connected = false;
        member.ai = true;
        game.setPlayerConnection(member.id, false);
      }
    } else {
      lobbyPlayers.delete(member.id);
    }

    if (hostId === member.id) {
      hostId = chooseNextHost();
    }

    broadcastLobby();
  });
});

server.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
});

function handleHello(ctx: ClientContext, requestedName: string, spectatorRequested: boolean, reconnectToken?: string): void {
  const name = sanitizeName(requestedName);
  const existing = reconnectToken ? findPlayerByToken(reconnectToken) : null;

  if (existing) {
    if (game && !existing.spectator && !game.hasPlayer(existing.id)) {
      send(ctx.ws, { type: 'error', message: 'game already running; reconnection only' });
      return;
    }

    // 試合中はロール変更不可。ロビー中のみプレイヤー/観戦を切り替えられる。
    if (!game) {
      existing.spectator = spectatorRequested;
    }

    existing.name = name;
    existing.connected = true;
    existing.ai = false;
    ctx.playerId = existing.id;

    if (game && !existing.spectator) {
      game.setPlayerConnection(existing.id, true);
    }

    send(ctx.ws, {
      type: 'welcome',
      playerId: existing.id,
      reconnectToken: existing.reconnectToken,
      isHost: hostId === existing.id,
      isSpectator: existing.spectator,
    });

    if (game) {
      send(ctx.ws, {
        type: 'game_init',
        meId: existing.id,
        world: game.getWorldInit(),
        config: game.config,
        startedAtMs: game.startedAtMs,
        isSpectator: existing.spectator,
      });

      send(ctx.ws, {
        type: 'state',
        snapshot: game.buildSnapshot(false),
      });
    }

    broadcastLobby();
    return;
  }

  if (game && !spectatorRequested) {
    send(ctx.ws, { type: 'error', message: 'game already running; reconnection or spectator only' });
    return;
  }

  const playerId = randomUUID();
  const token = randomUUID();
  const member: LobbyPlayerInternal = {
    id: playerId,
    name,
    connected: true,
    ai: false,
    spectator: spectatorRequested,
    isHost: false,
    reconnectToken: token,
  };

  lobbyPlayers.set(member.id, member);
  ctx.playerId = member.id;

  if (!hostId) {
    hostId = member.id;
  }

  send(ctx.ws, {
    type: 'welcome',
    playerId: member.id,
    reconnectToken: member.reconnectToken,
    isHost: hostId === member.id,
    isSpectator: member.spectator,
  });

  if (game) {
    send(ctx.ws, {
      type: 'game_init',
      meId: member.id,
      world: game.getWorldInit(),
      config: game.config,
      startedAtMs: game.startedAtMs,
      isSpectator: member.spectator,
    });

    send(ctx.ws, {
      type: 'state',
      snapshot: game.buildSnapshot(false),
    });
  }

  broadcastLobby();
}

function handleLobbyStart(
  requestedBy: string,
  difficulty: Difficulty,
  aiPlayerCount?: number,
  timeLimitMinutes?: number,
): void {
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

  const humanParticipants = Array.from(lobbyPlayers.values()).filter((player) => player.connected && !player.spectator);
  const aiCount = normalizeAiCount(aiPlayerCount);
  const startPlayers: StartPlayer[] = humanParticipants.map((player) => ({
    id: player.id,
    name: player.name,
    reconnectToken: player.reconnectToken,
    connected: player.connected,
  }));

  for (let i = 0; i < aiCount; i += 1) {
    startPlayers.push({
      id: `ai_${randomUUID().slice(0, 8)}`,
      name: `AI-${(i + 1).toString().padStart(2, '0')}`,
      reconnectToken: randomUUID(),
      connected: false,
    });
  }

  if (startPlayers.length === 0) {
    const target = getClientByPlayerId(requestedBy);
    if (target) {
      send(target.ws, { type: 'error', message: 'no players. set AI players or join as player.' });
    }
    return;
  }

  const timeLimitMsOverride = normalizeTimeLimitMs(timeLimitMinutes);
  game = new GameEngine(startPlayers, difficulty, Date.now(), { timeLimitMsOverride });
  runningAiCount = aiCount;

  for (const player of lobbyPlayers.values()) {
    if (player.spectator) {
      player.ai = false;
      continue;
    }

    if (!game.hasPlayer(player.id)) {
      lobbyPlayers.delete(player.id);
      continue;
    }

    player.ai = !player.connected;
  }

  const startNote = `ゲーム開始 (human:${humanParticipants.length}, ai:${aiCount}, limit:${Math.floor(
    game.config.timeLimitMs / 60_000,
  )}m)`;
  broadcastLobby(startNote);

  for (const member of lobbyPlayers.values()) {
    if (!member.connected) {
      continue;
    }

    const client = getClientByPlayerId(member.id);
    if (!client) {
      continue;
    }

    send(client.ws, {
      type: 'game_init',
      meId: member.id,
      world: game.getWorldInit(),
      config: game.config,
      startedAtMs: game.startedAtMs,
      isSpectator: member.spectator,
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
      runningAiCount = 0;

      for (const player of lobbyPlayers.values()) {
        player.ai = false;
      }

      if (hostId && !lobbyPlayers.get(hostId)?.connected) {
        hostId = chooseNextHost();
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
      spectator: player.spectator,
      isHost: player.id === hostId,
    }));

  const spectatorCount = ordered.filter((player) => player.spectator).length;
  const canStart = !!hostId && !!lobbyPlayers.get(hostId)?.connected;
  const composedNote = runningAiCount > 0 && !note ? `AI稼働中: ${runningAiCount}` : note;

  broadcast({
    type: 'lobby',
    players: ordered,
    hostId,
    canStart,
    running: !!game,
    spectatorCount,
    note: composedNote,
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

function normalizeAiCount(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.floor(value)));
}

function normalizeTimeLimitMs(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return undefined;
  }
  const minutes = Math.max(1, Math.min(10, Math.floor(value)));
  return minutes * 60_000;
}
