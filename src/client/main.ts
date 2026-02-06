import type {
  ClientMessage,
  ServerMessage,
} from '../shared/types.js';
import { NetworkClient } from './network.js';
import { CanvasRenderer } from './renderer.js';
import {
  applyRuntimeEvent,
  createClientState,
  pushLog,
  resetForGameInit,
} from './state.js';
import { UiController } from './ui.js';

const canvas = mustElement<HTMLCanvasElement>('game');
const hud = mustElement<HTMLElement>('hud');
const lobby = mustElement<HTMLElement>('lobby');
const result = mustElement<HTMLElement>('result');
const touchControls = mustElement<HTMLElement>('touch-controls');
const topStatus = mustElement<HTMLElement>('top-status');
const spectatorControls = mustElement<HTMLElement>('spectator-controls');

const state = createClientState();
const renderer = new CanvasRenderer(canvas);
const ui = new UiController(
  {
    hud,
    lobby,
    result,
    touchControls,
    topStatus,
    spectatorControls,
  },
  {
    onSendInput: (message) => send(message),
    onSendHello: () => sendHello(),
    onStartGame: (difficulty, aiPlayerCount, timeLimitMinutes) => {
      send({
        type: 'lobby_start',
        difficulty,
        aiPlayerCount,
        timeLimitMinutes,
      });
    },
    onCycleSpectator: (delta) => cycleSpectatorTarget(delta),
  },
);
const network = new NetworkClient({
  onOpen: () => {
    state.currentDir = 'none';
    sendHello();
  },
  onMessage: (message) => handleServerMessage(message),
  onInvalidMessage: () => {
    pushLog(state, 'WARN: 不正なサーバーメッセージを破棄');
  },
  onConnectionClosed: () => {
    state.currentDir = 'none';
  },
  onConnectionReplaced: () => {
    pushLog(state, 'このタブの接続は他の接続に置き換えられました');
  },
});

start();

function start(): void {
  renderer.resize();
  network.connect();
  ui.init(state);
  window.addEventListener('resize', () => renderer.resize());
  requestAnimationFrame(renderFrame);
}

function renderFrame(): void {
  requestAnimationFrame(renderFrame);
  renderer.render(state);
}

function send(message: ClientMessage): void {
  network.send(message);
}

function sendHello(): void {
  send({
    type: 'hello',
    name: state.playerName,
    reconnectToken: state.reconnectToken || undefined,
    spectator: state.preferSpectator,
  });
}

function handleServerMessage(message: ServerMessage): void {
  if (message.type === 'welcome') {
    state.sessionId = message.playerId;
    state.isHost = message.isHost;
    state.reconnectToken = message.reconnectToken;
    state.isSpectator = message.isSpectator;
    localStorage.setItem('mmo-packman-token', state.reconnectToken);
    ui.updateTouchControlsVisibility(state);
    ui.updateStatusPanels(state);
    return;
  }

  if (message.type === 'lobby') {
    state.isHost = message.hostId === state.sessionId;
    state.lobbyMessage = message.note ?? '';
    ui.renderLobby(state, message.players, message.running, message.canStart, message.spectatorCount);
    ui.updateStatusPanels(state);
    return;
  }

  if (message.type === 'game_init') {
    resetForGameInit(state, {
      meId: message.meId,
      world: message.world,
      config: message.config,
      isSpectator: message.isSpectator,
    });
    ui.hideLobby();
    ui.hideResult();
    ui.updateTouchControlsVisibility(state);
    ui.updateStatusPanels(state);
    return;
  }

  if (message.type === 'state') {
    state.snapshot = message.snapshot;
    renderer.updateInterpolationStates(state, message.snapshot);
    for (const event of message.snapshot.events) {
      applyRuntimeEvent(state, event);
    }
    ui.updateHud(state);
    ui.updateStatusPanels(state);
    return;
  }

  if (message.type === 'game_over') {
    state.summary = message.summary;
    ui.showResult(state);
    ui.updateStatusPanels(state);
    return;
  }

  if (message.type === 'error') {
    pushLog(state, `ERROR: ${message.message}`);
  }
}

function cycleSpectatorTarget(delta = 1): void {
  if (!state.snapshot) {
    return;
  }

  const players = state.snapshot.players;
  if (players.length === 0) {
    return;
  }

  if (!state.followPlayerId) {
    const best = [...players].sort((a, b) => b.score - a.score)[0];
    state.followPlayerId = best?.id ?? null;
    ui.updateStatusPanels(state);
    return;
  }

  const idx = players.findIndex((player) => player.id === state.followPlayerId);
  const normalized = idx < 0 ? 0 : idx;
  const nextIndex = (normalized + delta + players.length) % players.length;
  const next = players[nextIndex];
  state.followPlayerId = next?.id ?? state.followPlayerId;
  ui.updateStatusPanels(state);
}

function mustElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`missing element: ${id}`);
  }
  return element as T;
}
