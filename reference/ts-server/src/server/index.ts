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
  PingType,
  ServerMessage,
} from '../shared/types.js';
import { GameEngine, type StartPlayer } from './game.js';
import { PingManager } from './ping_manager.js';

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
const activeClientByPlayerId = new Map<string, string>();

let hostId: string | null = null;
let game: GameEngine | null = null;
let loop: NodeJS.Timeout | null = null;
let runningAiCount = 0;
const pingManager = new PingManager();

const DIFFICULTIES = new Set<Difficulty>(['casual', 'normal', 'hard', 'nightmare']);
const MOVE_DIRECTIONS = new Set(['up', 'down', 'left', 'right']);
const PING_TYPES = new Set<PingType>(['focus', 'danger', 'help']);

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

    if (message.type === 'place_ping') {
      handlePlacePing(ctx.playerId, message.kind);
      return;
    }
  });

  ws.on('close', () => {
    clients.delete(clientId);
    const boundPlayerId = ctx.playerId;
    if (!boundPlayerId) {
      return;
    }

    if (activeClientByPlayerId.get(boundPlayerId) !== ctx.id) {
      return;
    }
    activeClientByPlayerId.delete(boundPlayerId);

    const member = lobbyPlayers.get(boundPlayerId);
    if (!member) {
      return;
    }

    if (game) {
      if (member.spectator) {
        lobbyPlayers.delete(member.id);
        activeClientByPlayerId.delete(member.id);
      } else {
        member.connected = false;
        member.ai = true;
        game.setPlayerConnection(member.id, false);
      }
    } else {
      lobbyPlayers.delete(member.id);
      activeClientByPlayerId.delete(member.id);
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
  if (ctx.playerId) {
    const current = lobbyPlayers.get(ctx.playerId);
    if (current) {
      if (reconnectToken && reconnectToken !== current.reconnectToken) {
        send(ctx.ws, { type: 'error', message: 'reconnect token mismatch for this connection' });
        return;
      }

      if (!game) {
        current.spectator = spectatorRequested;
      }
      current.name = name;
      current.connected = true;
      current.ai = false;

      bindClientToPlayer(ctx, current);
      if (game && !current.spectator && game.hasPlayer(current.id)) {
        game.setPlayerConnection(current.id, true);
      }
      ensureHostAssigned(current.id);

      sendWelcomeAndInitialState(ctx, current);
      broadcastLobby();
      return;
    }

    ctx.playerId = null;
  }

  const existing = reconnectToken ? findPlayerByToken(reconnectToken) : null;
  if (existing) {
    if (game && !existing.spectator && !game.hasPlayer(existing.id)) {
      send(ctx.ws, { type: 'error', message: 'game already running; reconnection only' });
      return;
    }

    if (!game) {
      existing.spectator = spectatorRequested;
    }

    existing.name = name;
    existing.connected = true;
    existing.ai = false;

    bindClientToPlayer(ctx, existing);
    if (game && !existing.spectator && game.hasPlayer(existing.id)) {
      game.setPlayerConnection(existing.id, true);
    }
    ensureHostAssigned(existing.id);

    sendWelcomeAndInitialState(ctx, existing);
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
  bindClientToPlayer(ctx, member);
  ensureHostAssigned(member.id);
  sendWelcomeAndInitialState(ctx, member);

  broadcastLobby();
}

function sendWelcomeAndInitialState(ctx: ClientContext, member: LobbyPlayerInternal): void {
  send(ctx.ws, {
    type: 'welcome',
    playerId: member.id,
    reconnectToken: member.reconnectToken,
    isHost: hostId === member.id,
    isSpectator: member.spectator,
  });

  if (!game) {
    return;
  }

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
    snapshot: withPings(game.buildSnapshot(false)),
  });
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
  ensureHostAssigned();

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
  pingManager.clear();
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
    const snapshot = withPings(running.buildSnapshot(true));
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
      pingManager.clear();

      for (const player of lobbyPlayers.values()) {
        player.ai = false;
      }

      ensureHostAssigned();

      broadcastLobby('ゲーム終了。再スタート可能です');
    }
  }, TICK_MS);
}

function handlePlacePing(playerId: string, kind: PingType): void {
  const running = game;
  const member = lobbyPlayers.get(playerId);
  const client = getClientByPlayerId(playerId);

  if (!member || !client) {
    return;
  }

  if (!running) {
    send(client.ws, { type: 'error', message: 'game is not running' });
    return;
  }

  if (member.spectator) {
    send(client.ws, { type: 'error', message: 'spectator cannot place ping' });
    return;
  }

  const position = running.getPlayerPosition(member.id);
  if (!position) {
    send(client.ws, { type: 'error', message: 'player is not in current game' });
    return;
  }

  const result = pingManager.place({
    ownerId: member.id,
    ownerName: member.name,
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    kind,
    nowMs: running.getNowMs(),
    spectator: member.spectator,
  });

  if (!result.ok) {
    send(client.ws, { type: 'error', message: result.reason ?? 'failed to place ping' });
    return;
  }
}

function broadcastLobby(note?: string): void {
  ensureHostAssigned();
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
    if (!canReceiveBroadcast(ctx)) {
      continue;
    }
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
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || typeof value.type !== 'string') {
      return null;
    }

    if (value.type === 'hello') {
      if (typeof value.name !== 'string') {
        return null;
      }

      const reconnectToken =
        value.reconnectToken === undefined
          ? undefined
          : typeof value.reconnectToken === 'string'
            ? value.reconnectToken
            : null;
      const spectator =
        value.spectator === undefined ? undefined : typeof value.spectator === 'boolean' ? value.spectator : null;

      if (reconnectToken === null || spectator === null) {
        return null;
      }
      return {
        type: 'hello',
        name: value.name,
        reconnectToken,
        spectator,
      };
    }

    if (value.type === 'lobby_start') {
      const difficulty =
        value.difficulty === undefined
          ? undefined
          : typeof value.difficulty === 'string' && DIFFICULTIES.has(value.difficulty as Difficulty)
            ? (value.difficulty as Difficulty)
            : null;
      const aiPlayerCount =
        value.aiPlayerCount === undefined
          ? undefined
          : typeof value.aiPlayerCount === 'number' && Number.isFinite(value.aiPlayerCount)
            ? value.aiPlayerCount
            : null;
      const timeLimitMinutes =
        value.timeLimitMinutes === undefined
          ? undefined
          : typeof value.timeLimitMinutes === 'number' && Number.isFinite(value.timeLimitMinutes)
            ? value.timeLimitMinutes
            : null;

      if (difficulty === null || aiPlayerCount === null || timeLimitMinutes === null) {
        return null;
      }
      return {
        type: 'lobby_start',
        difficulty,
        aiPlayerCount,
        timeLimitMinutes,
      };
    }

    if (value.type === 'input') {
      const dir =
        value.dir === undefined
          ? undefined
          : typeof value.dir === 'string' && MOVE_DIRECTIONS.has(value.dir)
            ? (value.dir as 'up' | 'down' | 'left' | 'right')
            : null;
      const awaken = value.awaken === undefined ? undefined : typeof value.awaken === 'boolean' ? value.awaken : null;

      if (dir === null || awaken === null) {
        return null;
      }
      return {
        type: 'input',
        dir: dir as 'up' | 'down' | 'left' | 'right' | undefined,
        awaken,
      };
    }

    if (value.type === 'place_ping') {
      if (typeof value.kind !== 'string' || !PING_TYPES.has(value.kind as PingType)) {
        return null;
      }
      return {
        type: 'place_ping',
        kind: value.kind as PingType,
      };
    }

    if (value.type === 'ping') {
      if (typeof value.t !== 'number' || !Number.isFinite(value.t)) {
        return null;
      }
      return {
        type: 'ping',
        t: value.t,
      };
    }

    return null;
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
  return null;
}

function ensureHostAssigned(preferredPlayerId?: string): void {
  const currentHost = hostId ? lobbyPlayers.get(hostId) : null;
  if (currentHost?.connected) {
    return;
  }

  if (preferredPlayerId) {
    const preferred = lobbyPlayers.get(preferredPlayerId);
    if (preferred?.connected) {
      hostId = preferred.id;
      return;
    }
  }

  hostId = chooseNextHost();
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
  const clientId = activeClientByPlayerId.get(playerId);
  if (!clientId) {
    return null;
  }
  return clients.get(clientId) ?? null;
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

function withPings(snapshot: ReturnType<GameEngine['buildSnapshot']>): ReturnType<GameEngine['buildSnapshot']> {
  snapshot.pings = pingManager.snapshot(snapshot.nowMs);
  return snapshot;
}

function bindClientToPlayer(ctx: ClientContext, member: LobbyPlayerInternal): void {
  const oldClientId = activeClientByPlayerId.get(member.id);
  if (oldClientId && oldClientId !== ctx.id) {
    const oldClient = clients.get(oldClientId);
    if (oldClient) {
      oldClient.playerId = null;
      if (oldClient.ws.readyState === oldClient.ws.OPEN) {
        oldClient.ws.close(4001, 'superseded by new connection');
      }
    }
  }

  if (ctx.playerId && ctx.playerId !== member.id) {
    activeClientByPlayerId.delete(ctx.playerId);
  }
  ctx.playerId = member.id;
  activeClientByPlayerId.set(member.id, ctx.id);
}

function canReceiveBroadcast(ctx: ClientContext): boolean {
  if (!ctx.playerId) {
    return false;
  }
  if (activeClientByPlayerId.get(ctx.playerId) !== ctx.id) {
    return false;
  }
  return lobbyPlayers.has(ctx.playerId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}
