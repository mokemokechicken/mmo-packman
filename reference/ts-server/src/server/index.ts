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
import { RankingStore } from './ranking_store.js';
import { buildAoiSnapshot, DEFAULT_AOI_RADIUS_TILES } from './aoi.js';

interface ClientContext {
  id: string;
  ws: WebSocket;
  playerId: string | null;
  roomId: string | null;
}

interface LobbyPlayerInternal extends LobbyPlayer {
  reconnectToken: string;
}

interface RoomState {
  id: string;
  lobbyPlayers: Map<string, LobbyPlayerInternal>;
  activeClientByPlayerId: Map<string, string>;
  hostId: string | null;
  game: GameEngine | null;
  loop: NodeJS.Timeout | null;
  runningAiCount: number;
  pingManager: PingManager;
}

const PORT = Number(process.env.PORT ?? 8080);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const rankingStore = new RankingStore(path.resolve(process.cwd(), process.env.RANKING_DB_PATH ?? '.data/ranking.json'));

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/api/ranking', (req, res) => {
  const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
  res.status(200).json(rankingStore.buildResponse(limitRaw));
});

const distClientDir = path.resolve(process.cwd(), 'dist/client');
if (fs.existsSync(distClientDir)) {
  app.use(express.static(distClientDir));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distClientDir, 'index.html'));
  });
}

const clients = new Map<string, ClientContext>();
const rooms = new Map<string, RoomState>();

const DIFFICULTIES = new Set<Difficulty>(['casual', 'normal', 'hard', 'nightmare']);
const MOVE_DIRECTIONS = new Set(['up', 'down', 'left', 'right']);
const PING_TYPES = new Set<PingType>(['focus', 'danger', 'help']);
const AOI_ENABLED = process.env.AOI_ENABLED !== '0';
const AOI_RADIUS_TILES = normalizeAoiRadius(process.env.AOI_RADIUS_TILES, DEFAULT_AOI_RADIUS_TILES);

wss.on('connection', (ws) => {
  const clientId = randomUUID();
  const ctx: ClientContext = { id: clientId, ws, playerId: null, roomId: null };
  clients.set(clientId, ctx);

  ws.on('message', (raw) => {
    const message = parseMessage(raw.toString());
    if (!message) {
      send(ctx.ws, { type: 'error', message: 'invalid message' });
      return;
    }

    if (message.type === 'hello') {
      handleHello(ctx, message.name, !!message.spectator, message.reconnectToken, message.roomId);
      return;
    }

    if (message.type === 'ping') {
      send(ctx.ws, { type: 'pong', t: message.t });
      return;
    }

    if (!ctx.playerId || !ctx.roomId) {
      send(ctx.ws, { type: 'error', message: 'send hello first' });
      return;
    }

    const room = rooms.get(ctx.roomId);
    if (!room) {
      send(ctx.ws, { type: 'error', message: 'room not found. reconnect required.' });
      ctx.playerId = null;
      ctx.roomId = null;
      return;
    }

    if (message.type === 'lobby_start') {
      handleLobbyStart(
        room,
        ctx.playerId,
        message.difficulty ?? 'normal',
        message.aiPlayerCount,
        message.timeLimitMinutes,
      );
      return;
    }

    if (message.type === 'input' && room.game) {
      room.game.receiveInput(ctx.playerId, { dir: message.dir, awaken: message.awaken });
      return;
    }

    if (message.type === 'place_ping') {
      handlePlacePing(room, ctx.playerId, message.kind);
      return;
    }
  });

  ws.on('close', () => {
    handleClientClose(ctx);
    clients.delete(clientId);
  });
});

server.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
});

function handleHello(
  ctx: ClientContext,
  requestedName: string,
  spectatorRequested: boolean,
  reconnectToken?: string,
  requestedRoomId?: string,
): void {
  const roomId = normalizeRoomId(requestedRoomId ?? ctx.roomId ?? 'main');
  if (ctx.roomId && ctx.roomId !== roomId) {
    const previousRoom = rooms.get(ctx.roomId);
    if (previousRoom) {
      leaveRoom(ctx, previousRoom);
    } else {
      ctx.playerId = null;
      ctx.roomId = null;
    }
  }

  const room = getOrCreateRoom(roomId);
  const name = sanitizeName(requestedName);

  if (ctx.playerId && ctx.roomId === room.id) {
    const current = room.lobbyPlayers.get(ctx.playerId);
    if (current) {
      if (reconnectToken && reconnectToken !== current.reconnectToken) {
        send(ctx.ws, { type: 'error', message: 'reconnect token mismatch for this connection' });
        return;
      }

      if (!room.game) {
        current.spectator = spectatorRequested;
      }
      current.name = name;
      current.connected = true;
      current.ai = false;

      bindClientToPlayer(ctx, room, current);
      if (room.game && !current.spectator && room.game.hasPlayer(current.id)) {
        room.game.setPlayerConnection(current.id, true);
      }
      ensureHostAssigned(room, current.id);

      sendWelcomeAndInitialState(ctx, room, current);
      broadcastLobby(room);
      return;
    }

    room.activeClientByPlayerId.delete(ctx.playerId);
    ctx.playerId = null;
    ctx.roomId = null;
  }

  const existing = reconnectToken ? findPlayerByToken(room, reconnectToken) : null;
  if (existing) {
    if (room.game && !existing.spectator && !room.game.hasPlayer(existing.id)) {
      send(ctx.ws, { type: 'error', message: 'game already running; reconnection only' });
      return;
    }

    if (!room.game) {
      existing.spectator = spectatorRequested;
    }

    existing.name = name;
    existing.connected = true;
    existing.ai = false;

    bindClientToPlayer(ctx, room, existing);
    if (room.game && !existing.spectator && room.game.hasPlayer(existing.id)) {
      room.game.setPlayerConnection(existing.id, true);
    }
    ensureHostAssigned(room, existing.id);

    sendWelcomeAndInitialState(ctx, room, existing);
    broadcastLobby(room);
    return;
  }

  if (room.game && !spectatorRequested) {
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

  room.lobbyPlayers.set(member.id, member);
  bindClientToPlayer(ctx, room, member);
  ensureHostAssigned(room, member.id);
  sendWelcomeAndInitialState(ctx, room, member);

  broadcastLobby(room);
}

function handleClientClose(ctx: ClientContext): void {
  const boundPlayerId = ctx.playerId;
  const boundRoomId = ctx.roomId;
  if (!boundPlayerId || !boundRoomId) {
    return;
  }

  const room = rooms.get(boundRoomId);
  if (!room) {
    ctx.playerId = null;
    ctx.roomId = null;
    return;
  }

  leaveRoom(ctx, room);
}

function sendWelcomeAndInitialState(ctx: ClientContext, room: RoomState, member: LobbyPlayerInternal): void {
  send(ctx.ws, {
    type: 'welcome',
    playerId: member.id,
    reconnectToken: member.reconnectToken,
    isHost: room.hostId === member.id,
    isSpectator: member.spectator,
  });

  if (!room.game) {
    return;
  }

  send(ctx.ws, {
    type: 'game_init',
    meId: member.id,
    world: room.game.getWorldInit(),
    config: room.game.config,
    startedAtMs: room.game.startedAtMs,
    seed: room.game.seed,
    isSpectator: member.spectator,
  });

  send(ctx.ws, {
    type: 'state',
    snapshot: scopedSnapshotForMember(room, member, withPings(room, room.game.buildSnapshot(false))),
  });
}

function handleLobbyStart(
  room: RoomState,
  requestedBy: string,
  difficulty: Difficulty,
  aiPlayerCount?: number,
  timeLimitMinutes?: number,
): void {
  if (room.game) {
    return;
  }
  ensureHostAssigned(room);

  if (requestedBy !== room.hostId) {
    const target = getClientByPlayerId(room, requestedBy);
    if (target) {
      send(target.ws, { type: 'error', message: 'only host can start' });
    }
    return;
  }

  const humanParticipants = Array.from(room.lobbyPlayers.values()).filter((player) => player.connected && !player.spectator);
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
    const target = getClientByPlayerId(room, requestedBy);
    if (target) {
      send(target.ws, { type: 'error', message: 'no players. set AI players or join as player.' });
    }
    return;
  }

  const timeLimitMsOverride = normalizeTimeLimitMs(timeLimitMinutes);
  room.game = new GameEngine(startPlayers, difficulty, Date.now(), { timeLimitMsOverride });
  room.pingManager.clear();
  room.runningAiCount = aiCount;

  for (const player of room.lobbyPlayers.values()) {
    if (player.spectator) {
      player.ai = false;
      continue;
    }

    if (!room.game.hasPlayer(player.id)) {
      room.lobbyPlayers.delete(player.id);
      room.activeClientByPlayerId.delete(player.id);
      continue;
    }

    player.ai = !player.connected;
  }

  const startNote = `ゲーム開始 (room:${room.id}, human:${humanParticipants.length}, ai:${aiCount}, limit:${Math.floor(
    room.game.config.timeLimitMs / 60_000,
  )}m)`;
  broadcastLobby(room, startNote);

  for (const member of room.lobbyPlayers.values()) {
    if (!member.connected) {
      continue;
    }

    const client = getClientByPlayerId(room, member.id);
    if (!client || !room.game) {
      continue;
    }

    send(client.ws, {
      type: 'game_init',
      meId: member.id,
      world: room.game.getWorldInit(),
      config: room.game.config,
      startedAtMs: room.game.startedAtMs,
      seed: room.game.seed,
      isSpectator: member.spectator,
    });
  }

  room.loop = setInterval(() => {
    const running = room.game;
    if (!running) {
      return;
    }

    running.step(TICK_MS);
    const snapshot = withPings(room, running.buildSnapshot(true));
    if (AOI_ENABLED) {
      broadcastState(room, snapshot);
    } else {
      broadcast(room, { type: 'state', snapshot });
    }

    if (running.isEnded()) {
      const summary = running.buildSummary();
      rankingStore.recordMatch(summary);
      broadcast(room, { type: 'game_over', summary });

      if (room.loop) {
        clearInterval(room.loop);
        room.loop = null;
      }

      room.game = null;
      room.runningAiCount = 0;
      room.pingManager.clear();

      for (const player of room.lobbyPlayers.values()) {
        player.ai = false;
      }

      ensureHostAssigned(room);
      broadcastLobby(room, 'ゲーム終了。再スタート可能です');
      cleanupRoomIfIdle(room);
    }
  }, TICK_MS);
}

function handlePlacePing(room: RoomState, playerId: string, kind: PingType): void {
  const running = room.game;
  const member = room.lobbyPlayers.get(playerId);
  const client = getClientByPlayerId(room, playerId);

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

  const result = room.pingManager.place({
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
  }
}

function broadcastLobby(room: RoomState, note?: string): void {
  ensureHostAssigned(room);
  const ordered = Array.from(room.lobbyPlayers.values())
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
    .map((player) => ({
      id: player.id,
      name: player.name,
      connected: player.connected,
      ai: player.ai,
      spectator: player.spectator,
      isHost: player.id === room.hostId,
    }));

  const spectatorCount = ordered.filter((player) => player.spectator).length;
  const canStart = !!room.hostId && !!room.lobbyPlayers.get(room.hostId)?.connected;
  const composedNote = room.runningAiCount > 0 && !note ? `AI稼働中: ${room.runningAiCount}` : note;

  broadcast(room, {
    type: 'lobby',
    players: ordered,
    hostId: room.hostId,
    canStart,
    running: !!room.game,
    spectatorCount,
    note: composedNote,
  });
}

function broadcast(room: RoomState, message: ServerMessage): void {
  const payload = JSON.stringify(message);
  for (const clientId of room.activeClientByPlayerId.values()) {
    const ctx = clients.get(clientId);
    if (!ctx || !ctx.playerId || ctx.roomId !== room.id) {
      continue;
    }
    if (ctx.ws.readyState === ctx.ws.OPEN) {
      ctx.ws.send(payload);
    }
  }
}

function broadcastState(room: RoomState, snapshot: ReturnType<GameEngine['buildSnapshot']>): void {
  for (const [playerId, clientId] of room.activeClientByPlayerId.entries()) {
    const ctx = clients.get(clientId);
    if (!ctx || !ctx.playerId || ctx.roomId !== room.id) {
      continue;
    }
    if (ctx.ws.readyState !== ctx.ws.OPEN) {
      continue;
    }
    const member = room.lobbyPlayers.get(playerId);
    if (!member) {
      continue;
    }
    const scoped = scopedSnapshotForMember(room, member, snapshot);
    send(ctx.ws, { type: 'state', snapshot: scoped });
  }
}

function scopedSnapshotForMember(
  room: RoomState,
  member: LobbyPlayerInternal,
  snapshot: ReturnType<GameEngine['buildSnapshot']>,
): ReturnType<GameEngine['buildSnapshot']> {
  if (!AOI_ENABLED) {
    return snapshot;
  }
  return buildAoiSnapshot(snapshot, member.id, member.spectator, AOI_RADIUS_TILES);
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
      const roomId = value.roomId === undefined ? undefined : typeof value.roomId === 'string' ? value.roomId : null;

      if (reconnectToken === null || spectator === null || roomId === null) {
        return null;
      }
      return {
        type: 'hello',
        name: value.name,
        reconnectToken,
        spectator,
        roomId,
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

function normalizeRoomId(raw: string): string {
  const trimmed = raw.trim().slice(0, 24);
  if (!trimmed) {
    return 'main';
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return 'main';
  }
  return trimmed;
}

function chooseNextHost(room: RoomState): string | null {
  for (const player of room.lobbyPlayers.values()) {
    if (player.connected) {
      return player.id;
    }
  }
  return null;
}

function ensureHostAssigned(room: RoomState, preferredPlayerId?: string): void {
  const currentHost = room.hostId ? room.lobbyPlayers.get(room.hostId) : null;
  if (currentHost?.connected) {
    return;
  }

  if (preferredPlayerId) {
    const preferred = room.lobbyPlayers.get(preferredPlayerId);
    if (preferred?.connected) {
      room.hostId = preferred.id;
      return;
    }
  }

  room.hostId = chooseNextHost(room);
}

function findPlayerByToken(room: RoomState, token: string): LobbyPlayerInternal | null {
  for (const player of room.lobbyPlayers.values()) {
    if (player.reconnectToken === token) {
      return player;
    }
  }
  return null;
}

function getClientByPlayerId(room: RoomState, playerId: string): ClientContext | null {
  const clientId = room.activeClientByPlayerId.get(playerId);
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

function normalizeAoiRadius(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function bindClientToPlayer(ctx: ClientContext, room: RoomState, member: LobbyPlayerInternal): void {
  if (ctx.playerId === member.id && ctx.roomId === room.id && room.activeClientByPlayerId.get(member.id) === ctx.id) {
    return;
  }

  const oldClientId = room.activeClientByPlayerId.get(member.id);
  if (oldClientId && oldClientId !== ctx.id) {
    const oldClient = clients.get(oldClientId);
    if (oldClient) {
      oldClient.playerId = null;
      oldClient.roomId = null;
      if (oldClient.ws.readyState === oldClient.ws.OPEN) {
        oldClient.ws.close(4001, 'superseded by new connection');
      }
    }
  }

  if (ctx.playerId && ctx.roomId) {
    const previousRoom = rooms.get(ctx.roomId);
    if (previousRoom && previousRoom.activeClientByPlayerId.get(ctx.playerId) === ctx.id) {
      previousRoom.activeClientByPlayerId.delete(ctx.playerId);
    }
  }

  ctx.playerId = member.id;
  ctx.roomId = room.id;
  room.activeClientByPlayerId.set(member.id, ctx.id);
}

function leaveRoom(ctx: ClientContext, room: RoomState): void {
  if (!ctx.playerId || ctx.roomId !== room.id) {
    return;
  }
  if (room.activeClientByPlayerId.get(ctx.playerId) !== ctx.id) {
    ctx.playerId = null;
    ctx.roomId = null;
    return;
  }

  const member = room.lobbyPlayers.get(ctx.playerId);
  room.activeClientByPlayerId.delete(ctx.playerId);

  if (member) {
    if (room.game) {
      if (member.spectator) {
        room.lobbyPlayers.delete(member.id);
      } else {
        member.connected = false;
        member.ai = true;
        room.game.setPlayerConnection(member.id, false);
      }
    } else {
      room.lobbyPlayers.delete(member.id);
    }

    if (room.hostId === member.id) {
      room.hostId = chooseNextHost(room);
    }

    broadcastLobby(room);
  }

  ctx.playerId = null;
  ctx.roomId = null;
  cleanupRoomIfIdle(room);
}

function withPings(snapshotOwner: RoomState, snapshot: ReturnType<GameEngine['buildSnapshot']>): ReturnType<GameEngine['buildSnapshot']> {
  snapshot.pings = snapshotOwner.pingManager.snapshot(snapshot.nowMs);
  return snapshot;
}

function getOrCreateRoom(roomId: string): RoomState {
  const existing = rooms.get(roomId);
  if (existing) {
    return existing;
  }

  const created: RoomState = {
    id: roomId,
    lobbyPlayers: new Map<string, LobbyPlayerInternal>(),
    activeClientByPlayerId: new Map<string, string>(),
    hostId: null,
    game: null,
    loop: null,
    runningAiCount: 0,
    pingManager: new PingManager(),
  };
  rooms.set(roomId, created);
  return created;
}

function cleanupRoomIfIdle(room: RoomState): void {
  if (room.game || room.loop || room.activeClientByPlayerId.size > 0) {
    return;
  }
  room.lobbyPlayers.clear();
  room.hostId = null;
  room.runningAiCount = 0;
  rooms.delete(room.id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}
