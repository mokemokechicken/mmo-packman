import type {
  AwardEntry,
  ClientMessage,
  Direction,
  Difficulty,
  FruitView,
  GameConfig,
  GameSummary,
  GhostView,
  LobbyPlayer,
  PersistentRankingEntry,
  PingType,
  PingView,
  PlayerView,
  RankingResponse,
  RuntimeEvent,
  ServerMessage,
  Snapshot,
  WorldInit,
} from '../shared/types.js';
import {
  DIRECTION_VECTORS,
  PLAYER_BASE_SPEED,
  PLAYER_CAPTURED_SPEED_MULTIPLIER,
} from '../shared/constants.js';
import { findReplayFrameIndex, parseReplayLog, type ReplayFrame, type ReplayLog } from './replay_parser.js';
import { cloneSnapshot, cloneWorld, normalizeSummary, normalizeSnapshot } from './replay_model.js';

const canvas = mustElement<HTMLCanvasElement>('game');
const hud = mustElement<HTMLElement>('hud');
const lobby = mustElement<HTMLElement>('lobby');
const result = mustElement<HTMLElement>('result');
const touchControls = mustElement<HTMLElement>('touch-controls');
const topStatus = mustElement<HTMLElement>('top-status');
const spectatorControls = mustElement<HTMLElement>('spectator-controls');
const audioSettingsPanel = mustElement<HTMLElement>('audio-settings');
const ctx = mustCanvasContext(canvas);

const dotSet = new Set<string>();
const pelletMap = new Map<string, { x: number; y: number; active: boolean }>();
const SOUND_VOLUME_KEY = 'mmo-packman-sound-volume';
const SOUND_MUTED_KEY = 'mmo-packman-sound-muted';

interface InterpolationState {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  updatedAtMs: number;
  durationMs: number;
  lastMoveAtMs: number;
}

interface LocalPlayerPredictionState {
  x: number;
  y: number;
  dir: Direction;
  desiredDir: Direction;
  moveBuffer: number;
  renderCorrectionX: number;
  renderCorrectionY: number;
  lastUpdateMs: number;
  lastSnapshotTick: number;
}

type SpectatorCameraMode = 'follow' | 'free';

interface ReplayPlaybackState {
  log: ReplayLog;
  frameOffsetsMs: number[];
  durationMs: number;
  frameIndex: number;
  cursorMs: number;
  speed: number;
  playing: boolean;
  lastPerfMs: number;
}

const REPLAY_SAMPLE_TICK_INTERVAL = 4;
const REPLAY_SPEED_OPTIONS = [0.5, 1, 2, 4] as const;

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let reconnectToken = localStorage.getItem('mmo-packman-token') ?? '';
let playerName = localStorage.getItem('mmo-packman-name') ?? `Player-${Math.floor(Math.random() * 1000)}`;
let roomId = localStorage.getItem('mmo-packman-room') ?? 'main';
let preferSpectator = localStorage.getItem('mmo-packman-spectator') === '1';
let requestedAiCount = normalizeNumber(localStorage.getItem('mmo-packman-ai-count'), 2, 0, 100);
let requestedTestMinutes = normalizeNumber(localStorage.getItem('mmo-packman-test-minutes'), 5, 1, 10);
let soundVolume = normalizeNumber(localStorage.getItem(SOUND_VOLUME_KEY), 70, 0, 100) / 100;
let soundMuted = localStorage.getItem(SOUND_MUTED_KEY) === '1';
let audioUnlocked = false;
let audioContext: AudioContext | null = null;
let audioMasterGain: GainNode | null = null;
let soundStatusElement: HTMLElement | null = null;
let soundVolumeLabelElement: HTMLElement | null = null;
let soundVolumeInputElement: HTMLInputElement | null = null;
let soundMuteInputElement: HTMLInputElement | null = null;

let sessionId = '';
let meId = '';
let isHost = false;
let isSpectator = preferSpectator;
let world: WorldInit | null = null;
let config: GameConfig | null = null;
let snapshot: Snapshot | null = null;
let summary: GameSummary | null = null;
let lobbyMessage = '';
let logs: string[] = [];
let rankingEntries: PersistentRankingEntry[] = [];
let rankingFetchError = '';
let rankingLastFetchedAtMs = 0;
const observedPingIds = new Set<string>();
let currentMatchSeed = 0;
let currentMatchStartedAtMs = 0;
let replayRecordingFrames: ReplayFrame[] = [];
let latestReplayLog: ReplayLog | null = null;
let replayPlayback: ReplayPlaybackState | null = null;
let replaySavedWorld: WorldInit | null = null;
let replaySavedSnapshot: Snapshot | null = null;
let replaySavedDots: string[] | null = null;
let replaySavedPellets: Array<{ key: string; x: number; y: number; active: boolean }> | null = null;
let replaySavedIsSpectator: boolean | null = null;
let replaySavedCameraMode: SpectatorCameraMode | null = null;
let replaySavedFollowPlayerId: string | null = null;
let currentDir: 'up' | 'down' | 'left' | 'right' | 'none' = 'none';
let followPlayerId: string | null = null;
let spectatorCameraMode: SpectatorCameraMode = 'follow';
let spectatorZoom = 1;
let freeCameraCenter: { x: number; y: number } | null = null;
let spectatorMinimapCanvas: HTMLCanvasElement | null = null;
let spectatorMinimapCtx: CanvasRenderingContext2D | null = null;
const playerInterpolation = new Map<string, InterpolationState>();
const ghostInterpolation = new Map<string, InterpolationState>();
let localPlayerPrediction: LocalPlayerPredictionState | null = null;

start();

function start(): void {
  resize();
  connect();
  void fetchRankingBoard(true);
  wireKeyboard();
  wireTouchControls();
  initSpectatorControls();
  initAudioSettingsPanel();
  wireAudioUnlock();
  window.addEventListener('resize', resize);
  requestAnimationFrame(renderFrame);
}

function connect(): void {
  const url = wsUrl();
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    currentDir = 'none';
    sendHello();
  });

  ws.addEventListener('message', (event) => {
    const msg = safeParse(event.data.toString());
    if (!msg) {
      return;
    }
    handleServerMessage(msg);
  });

  ws.addEventListener('close', (event) => {
    currentDir = 'none';
    if (event.code === 4001) {
      pushLog('このタブの接続は他の接続に置き換えられました');
      return;
    }

    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
    }
    reconnectTimer = window.setTimeout(() => {
      connect();
    }, 1500);
  });
}

function sendHello(): void {
  const hello: ClientMessage = {
    type: 'hello',
    name: playerName,
    reconnectToken: reconnectToken || undefined,
    spectator: preferSpectator,
    roomId,
  };
  send(hello);
}

function wsUrl(): string {
  const env = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env.VITE_WS_URL;
  if (env) {
    return env;
  }

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const frontendPorts = new Set(['5173', '4173']);
  const port = frontendPorts.has(window.location.port) ? '8080' : window.location.port;
  return `${proto}//${window.location.hostname}${port ? `:${port}` : ''}/ws`;
}

function safeParse(raw: string): ServerMessage | null {
  try {
    return JSON.parse(raw) as ServerMessage;
  } catch {
    return null;
  }
}

function handleServerMessage(message: ServerMessage): void {
  if (message.type === 'welcome') {
    sessionId = message.playerId;
    isHost = message.isHost;
    reconnectToken = message.reconnectToken;
    isSpectator = message.isSpectator;
    localStorage.setItem('mmo-packman-token', reconnectToken);
    updateTouchControlsVisibility();
    updateStatusPanels();
    return;
  }

  if (message.type === 'lobby') {
    isHost = message.hostId === sessionId;
    lobbyMessage = message.note ?? '';
    void fetchRankingBoard();
    const inRunningMatch = message.running && !!world && !!snapshot && meId.length > 0;
    if (inRunningMatch) {
      lobby.classList.add('hidden');
    } else {
      renderLobby(message.players, message.running, message.canStart, message.spectatorCount);
    }
    updateStatusPanels();
    return;
  }

  if (message.type === 'game_init') {
    if (replayPlayback) {
      closeReplay();
    }
    meId = message.meId;
    world = message.world;
    config = message.config;
    currentMatchSeed = Number.isFinite(message.seed) ? message.seed : 0;
    currentMatchStartedAtMs = message.startedAtMs;
    currentDir = 'none';
    isSpectator = message.isSpectator;
    summary = null;
    snapshot = null;
    logs = [];
    observedPingIds.clear();
    replayRecordingFrames = [];
    followPlayerId = null;
    spectatorCameraMode = 'follow';
    spectatorZoom = 1;
    freeCameraCenter = null;
    playerInterpolation.clear();
    ghostInterpolation.clear();
    localPlayerPrediction = null;
    dotSet.clear();
    pelletMap.clear();

    for (const [x, y] of world.dots) {
      dotSet.add(dotKey(x, y));
    }
    for (const pellet of world.powerPellets) {
      pelletMap.set(pellet.key, { x: pellet.x, y: pellet.y, active: pellet.active });
    }

    lobby.classList.add('hidden');
    result.classList.add('hidden');
    updateTouchControlsVisibility();
    updateStatusPanels();
    return;
  }

  if (message.type === 'state') {
    if (replayPlayback) {
      return;
    }
    const previousSnapshot = snapshot;
    snapshot = normalizeSnapshot(message.snapshot);
    syncLocalPlayerPredictionFromSnapshot(snapshot);
    syncPingLogs(snapshot.pings);
    playAwakenTransitions(previousSnapshot, snapshot);
    updateInterpolationStates(snapshot);
    for (const event of snapshot.events) {
      applyEvent(event);
    }
    recordReplayFrame(snapshot);
    updateHud();
    updateStatusPanels();
    return;
  }

  if (message.type === 'game_over') {
    summary = normalizeSummary(message.summary);
    finalizeReplayLog(summary);
    void fetchRankingBoard(true);
    playSoundForGameOver(summary.reason);
    showResult();
    updateStatusPanels();
    return;
  }

  if (message.type === 'error') {
    pushLog(`ERROR: ${message.message}`);
  }
}

function applyEvent(event: RuntimeEvent): void {
  playSoundForEvent(event);

  if (event.type === 'dot_eaten') {
    dotSet.delete(dotKey(event.x, event.y));
  } else if (event.type === 'dot_respawned') {
    dotSet.add(dotKey(event.x, event.y));
  } else if (event.type === 'pellet_taken') {
    const pellet = pelletMap.get(event.key);
    if (pellet) {
      pellet.active = false;
    }
  } else if (event.type === 'pellet_respawned') {
    const pellet = pelletMap.get(event.key);
    if (pellet) {
      pellet.active = true;
    }
  } else if (event.type === 'fruit_spawned') {
    pushLog(`フルーツ出現: ${fruitLabel(event.fruit.type)}`);
  } else if (event.type === 'fruit_taken') {
    pushLog(`${playerNameById(event.by)} が ${fruitLabel(event.fruitType)} を取得`);
  } else if (event.type === 'player_down') {
    pushLog(`${playerNameById(event.playerId)} がダウン`);
  } else if (event.type === 'player_revived') {
    if (event.auto) {
      pushLog(`${playerNameById(event.playerId)} が自動復活`);
    } else {
      pushLog(`${playerNameById(event.by)} が ${playerNameById(event.playerId)} を救出`);
    }
  } else if (event.type === 'sector_captured') {
    pushLog(`エリア ${event.sectorId} 制覇`);
  } else if (event.type === 'sector_lost') {
    pushLog(`エリア ${event.sectorId} が劣化`);
  } else if (event.type === 'boss_spawned') {
    pushLog('ボスゴースト出現');
  } else if (event.type === 'boss_hit') {
    pushLog(`ボスにヒット (残りHP: ${event.hp})`);
  } else if (event.type === 'toast') {
    pushLog(event.message);
  }
}

function syncPingLogs(pings: PingView[]): void {
  const nextObserved = new Set<string>();
  for (const ping of pings) {
    nextObserved.add(ping.id);
    if (observedPingIds.has(ping.id)) {
      continue;
    }
    const label = pingKindLabel(ping.kind);
    pushLog(`PING ${label}: ${ping.ownerName}`);
  }
  observedPingIds.clear();
  for (const id of nextObserved) {
    observedPingIds.add(id);
  }
}

function recordReplayFrame(state: Snapshot): void {
  if (replayPlayback) {
    return;
  }

  const shouldSample = replayRecordingFrames.length === 0 || state.tick % REPLAY_SAMPLE_TICK_INTERVAL === 0 || state.timeLeftMs <= 0;
  if (!shouldSample) {
    return;
  }

  const last = replayRecordingFrames[replayRecordingFrames.length - 1];
  if (last && last.snapshot.tick === state.tick) {
    return;
  }

  replayRecordingFrames.push(captureReplayFrame(state));
}

function finalizeReplayLog(finalSummary: GameSummary): void {
  if (!world || !config || replayRecordingFrames.length === 0) {
    latestReplayLog = null;
    return;
  }

  const lastFrame = replayRecordingFrames[replayRecordingFrames.length - 1];
  if (snapshot && lastFrame?.snapshot.tick !== snapshot.tick) {
    replayRecordingFrames.push(captureReplayFrame(snapshot));
  }

  latestReplayLog = {
    format: 'mmo-packman-replay-v1',
    recordedAtIso: new Date().toISOString(),
    seed: currentMatchSeed,
    config: { ...config },
    world: cloneWorld(world),
    startedAtMs: currentMatchStartedAtMs,
    summary: normalizeSummary(finalSummary),
    frames: replayRecordingFrames.map((frame) => cloneReplayFrame(frame)),
  };
}

async function fetchRankingBoard(force = false): Promise<void> {
  const nowMs = Date.now();
  if (!force && nowMs - rankingLastFetchedAtMs < 15_000) {
    return;
  }

  try {
    const response = await fetch('/api/ranking?limit=8');
    if (!response.ok) {
      rankingFetchError = `ランキング取得失敗: ${response.status}`;
      rerenderLobbyWithLatestRanking();
      return;
    }
    const payload = (await response.json()) as RankingResponse;
    rankingEntries = Array.isArray(payload.entries) ? payload.entries : [];
    rankingFetchError = '';
    rankingLastFetchedAtMs = nowMs;
    rerenderLobbyWithLatestRanking();
  } catch {
    rankingFetchError = 'ランキングAPI未接続';
    rerenderLobbyWithLatestRanking();
  }
}

function rerenderLobbyWithLatestRanking(): void {
  if (lobby.classList.contains('hidden')) {
    return;
  }
  const container = document.getElementById('ranking-board');
  if (!container) {
    return;
  }
  container.innerHTML = renderRankingBoard();
}

function renderRankingBoard(): string {
  if (rankingEntries.length === 0) {
    return `<p class=\"muted\">${escapeHtml(rankingFetchError || 'ランキングデータなし')}</p>`;
  }

  return `
    <ol>
      ${rankingEntries
        .slice(0, 8)
        .map((entry) => {
          return `<li>${escapeHtml(entry.name)} - 勝率 ${(entry.winRate * 100).toFixed(1)}% / 平均制覇 ${(entry.avgCaptureRatio * 100).toFixed(1)}% / 最高 ${entry.bestScore}</li>`;
        })
        .join('')}
    </ol>
  `;
}

function renderLobby(players: LobbyPlayer[], running: boolean, canStart: boolean, spectatorCount: number): void {
  lobby.classList.remove('hidden');

  const difficultyOptions: Array<{ value: Difficulty; label: string }> = [
    { value: 'casual', label: 'Casual' },
    { value: 'normal', label: 'Normal' },
    { value: 'hard', label: 'Hard' },
    { value: 'nightmare', label: 'Nightmare' },
  ];

  const activePlayers = players.filter((p) => !p.spectator).length;

  lobby.innerHTML = `
    <div class="panel">
      <h1>MMO Packman Prototype</h1>
      <p class="muted">AI-onlyテスト対応 / 観戦モード対応</p>

      <label>名前
        <input id="name-input" value="${escapeHtml(playerName)}" maxlength="16" />
      </label>

      <label>ルームID
        <input id="room-input" value="${escapeHtml(roomId)}" maxlength="24" />
      </label>

      <label>参加モード
        <select id="mode-select">
          <option value="player" ${preferSpectator ? '' : 'selected'}>プレイヤー</option>
          <option value="spectator" ${preferSpectator ? 'selected' : ''}>観戦</option>
        </select>
      </label>

      <label>難易度
        <select id="difficulty-select">
          ${difficultyOptions.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}
        </select>
      </label>

      <label>AIプレイヤー数（0-100）
        <input id="ai-count" type="number" min="0" max="100" value="${requestedAiCount}" />
      </label>

      <label>テスト時間（分, 1-10）
        <input id="test-minutes" type="number" min="1" max="10" value="${requestedTestMinutes}" />
      </label>

      <button id="save-profile">設定を保存</button>
      <button id="start-game" ${isHost && canStart && !running ? '' : 'disabled'}>${running ? '進行中' : 'テスト開始'}</button>
      <p class="muted">room: ${escapeHtml(roomId)}</p>
      <p class="muted">${lobbyMessage || 'Host が開始します。観戦者は進行中でも接続可能です。'}</p>

      <h2>ロビー</h2>
      <p class="muted">member:${players.length} / player:${activePlayers} / spectator:${spectatorCount}</p>
      <ul>
        ${players
          .map((p) => {
            const tags = [
              p.isHost ? '👑' : '',
              p.spectator ? '[観戦]' : '[参加]',
              p.connected ? '' : '(切断)',
              p.ai ? '[AI代行]' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return `<li>${escapeHtml(p.name)} ${tags}</li>`;
          })
          .join('')}
      </ul>

      <h2>永続ランキング</h2>
      <div id="ranking-board">${renderRankingBoard()}</div>

      <p class="hint">AI-onlyテスト: 観戦モード + AI人数(2/5など) で開始</p>
      <p class="hint">プレイヤー操作: 方向キー/WASD, 覚醒: Space/E/Enter, ピン: G(注目)/V(危険)/B(救助)</p>
    </div>
  `;

  const saveProfile = document.getElementById('save-profile');
  const startButton = document.getElementById('start-game');

  saveProfile?.addEventListener('click', () => {
    const nameInput = document.getElementById('name-input') as HTMLInputElement | null;
    const roomInput = document.getElementById('room-input') as HTMLInputElement | null;
    const modeSelect = document.getElementById('mode-select') as HTMLSelectElement | null;
    const aiInput = document.getElementById('ai-count') as HTMLInputElement | null;
    const minutesInput = document.getElementById('test-minutes') as HTMLInputElement | null;

    playerName = nameInput?.value.trim().slice(0, 16) || playerName;
    roomId = (roomInput?.value.trim().slice(0, 24) || roomId).replace(/[^a-zA-Z0-9_-]/g, '') || 'main';
    preferSpectator = modeSelect?.value === 'spectator';
    requestedAiCount = normalizeNumber(aiInput?.value ?? '', requestedAiCount, 0, 100);
    requestedTestMinutes = normalizeNumber(minutesInput?.value ?? '', requestedTestMinutes, 1, 10);

    localStorage.setItem('mmo-packman-name', playerName);
    localStorage.setItem('mmo-packman-room', roomId);
    localStorage.setItem('mmo-packman-spectator', preferSpectator ? '1' : '0');
    localStorage.setItem('mmo-packman-ai-count', String(requestedAiCount));
    localStorage.setItem('mmo-packman-test-minutes', String(requestedTestMinutes));

    sendHello();
  });

  startButton?.addEventListener('click', () => {
    const select = document.getElementById('difficulty-select') as HTMLSelectElement | null;
    const modeSelect = document.getElementById('mode-select') as HTMLSelectElement | null;
    const aiInput = document.getElementById('ai-count') as HTMLInputElement | null;
    const minutesInput = document.getElementById('test-minutes') as HTMLInputElement | null;

    const difficulty = (select?.value as Difficulty) ?? 'normal';
    preferSpectator = modeSelect?.value === 'spectator';
    requestedAiCount = normalizeNumber(aiInput?.value ?? '', requestedAiCount, 0, 100);
    requestedTestMinutes = normalizeNumber(minutesInput?.value ?? '', requestedTestMinutes, 1, 10);

    localStorage.setItem('mmo-packman-spectator', preferSpectator ? '1' : '0');
    localStorage.setItem('mmo-packman-ai-count', String(requestedAiCount));
    localStorage.setItem('mmo-packman-test-minutes', String(requestedTestMinutes));

    // Ensure mode changes are reflected server-side even when the user presses start directly.
    sendHello();
    send({
      type: 'lobby_start',
      difficulty,
      aiPlayerCount: requestedAiCount,
      timeLimitMinutes: requestedTestMinutes,
    });
  });
}

function showResult(): void {
  if (!summary) {
    return;
  }

  result.classList.remove('hidden');
  const awards = renderAwards(summary.awards);
  const ranking = summary.ranking
    .slice(0, 8)
    .map((entry, index) => {
      return `<li>${index + 1}. ${escapeHtml(entry.name)} - ${entry.score}pt (dot:${entry.dots}, ghost:${entry.ghosts}, rescue:${entry.rescues})</li>`;
    })
    .join('');
  const replaySection = latestReplayLog
    ? `
      <p class="muted">seed: ${latestReplayLog.seed} / frame: ${latestReplayLog.frames.length}</p>
      <div class="replay-inline">
        <button id="replay-open-latest" type="button">リプレイ再生</button>
        <button id="replay-export" type="button">JSON保存</button>
      </div>
    `
    : '<p class="muted">この試合のリプレイはまだ生成されていません。</p>';

  result.innerHTML = `
    <div class="panel">
      <h2>ゲーム終了: ${summary.reason}</h2>
      <p>制覇率: ${(summary.captureRatio * 100).toFixed(1)}%</p>
      <h3>表彰</h3>
      ${awards}
      <h3>ランキング</h3>
      <ol>${ranking}</ol>
      <h3>タイムライン</h3>
      <ul>${summary.timeline.slice(-12).map((t) => `<li>${formatMs(t.atMs)} ${escapeHtml(t.label)}</li>`).join('')}</ul>
      <h3>リプレイ</h3>
      ${replaySection}
      <label class="replay-file">リプレイJSON読込
        <input id="replay-import" type="file" accept=\".json,application/json\" />
      </label>
      <button id="close-result">閉じる</button>
    </div>
  `;

  const close = document.getElementById('close-result');
  const openReplayButton = document.getElementById('replay-open-latest');
  const exportReplayButton = document.getElementById('replay-export');
  const importReplayInput = document.getElementById('replay-import') as HTMLInputElement | null;

  close?.addEventListener('click', () => {
    result.classList.add('hidden');
  });
  openReplayButton?.addEventListener('click', () => {
    if (!latestReplayLog) {
      return;
    }
    openReplay(latestReplayLog);
  });
  exportReplayButton?.addEventListener('click', () => {
    if (!latestReplayLog) {
      return;
    }
    exportReplay(latestReplayLog);
  });
  importReplayInput?.addEventListener('change', () => {
    const file = importReplayInput.files?.[0];
    if (!file) {
      return;
    }
    void importReplayFromFile(file);
    importReplayInput.value = '';
  });
}

function captureReplayFrame(state: Snapshot): ReplayFrame {
  return {
    snapshot: cloneSnapshot(state),
    dots: Array.from(dotSet.values()),
    pellets: Array.from(pelletMap.values()).map((pellet) => ({
      key: dotKey(pellet.x, pellet.y),
      x: pellet.x,
      y: pellet.y,
      active: pellet.active,
    })),
  };
}

function cloneReplayFrame(raw: ReplayFrame): ReplayFrame {
  return {
    snapshot: cloneSnapshot(raw.snapshot),
    dots: [...raw.dots],
    pellets: raw.pellets.map((pellet) => ({ ...pellet })),
  };
}

function restoreReplayBoardState(frame: ReplayFrame): void {
  dotSet.clear();
  for (const key of frame.dots) {
    dotSet.add(key);
  }

  pelletMap.clear();
  const pellets =
    frame.pellets.length > 0
      ? frame.pellets
      : (world?.powerPellets.map((pellet) => ({
          key: pellet.key,
          x: pellet.x,
          y: pellet.y,
          active: pellet.active,
        })) ?? []);
  for (const pellet of pellets) {
    pelletMap.set(pellet.key, {
      x: pellet.x,
      y: pellet.y,
      active: pellet.active,
    });
  }
}

function renderAwards(awards: AwardEntry[]): string {
  if (awards.length === 0) {
    return '<p class="muted">該当する表彰はありません。</p>';
  }

  return `
    <ul>
      ${awards
        .map((award) => {
          const winnerNames = award.winners.map((winner) => escapeHtml(winner.name)).join(', ');
          return `<li><strong>${escapeHtml(award.title)}</strong> (${escapeHtml(award.metricLabel)}: ${award.value}) - ${winnerNames}</li>`;
        })
        .join('')}
    </ul>
  `;
}

function wireKeyboard(): void {
  const dirMap: Record<string, 'up' | 'down' | 'left' | 'right'> = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    w: 'up',
    s: 'down',
    a: 'left',
    d: 'right',
  };
  const pingMap: Record<string, PingType> = {
    g: 'focus',
    v: 'danger',
    b: 'help',
  };
  const pressedDirs: Array<'up' | 'down' | 'left' | 'right'> = [];

  const syncDirectionInput = (): void => {
    if (pressedDirs.length === 0) {
      return;
    }
    const nextDir = pressedDirs[pressedDirs.length - 1];
    if (nextDir !== currentDir) {
      currentDir = nextDir;
      if (localPlayerPrediction) {
        localPlayerPrediction.desiredDir = nextDir;
      }
      send({ type: 'input', dir: nextDir });
    }
  };

  window.addEventListener('keydown', (event) => {
    const rawKey = event.key;
    const key = rawKey.length === 1 ? rawKey.toLowerCase() : rawKey;
    const typingInForm = isTypingInFormElement(event.target);

    if (isSpectator) {
      if (typingInForm) {
        return;
      }
      const pingKind = pingMap[key];
      if (pingKind) {
        event.preventDefault();
        placePing(pingKind);
        return;
      }
      if (rawKey === 'Tab' || rawKey === ']' || key === 'e') {
        event.preventDefault();
        cycleSpectatorTarget(1);
      } else if (rawKey === '[' || key === 'q') {
        event.preventDefault();
        cycleSpectatorTarget(-1);
      } else if (key === '+' || key === '=' || rawKey === 'PageUp') {
        event.preventDefault();
        adjustSpectatorZoom(1);
      } else if (key === '-' || rawKey === 'PageDown') {
        event.preventDefault();
        adjustSpectatorZoom(-1);
      } else {
        const panDir = dirMap[key];
        if (panDir) {
          event.preventDefault();
          panSpectatorCamera(panDir);
        }
      }
      return;
    }

    const pingKind = pingMap[key];
    if (pingKind) {
      event.preventDefault();
      placePing(pingKind);
      return;
    }

    const dir = dirMap[key];
    if (dir) {
      if (!pressedDirs.includes(dir)) {
        pressedDirs.push(dir);
      }
      syncDirectionInput();
    }

    if (key === ' ' || key === 'e' || key === 'Enter') {
      send({ type: 'input', awaken: true });
    }
  });

  window.addEventListener('keyup', (event) => {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const dir = dirMap[key];
    if (dir) {
      const nextPressed = pressedDirs.filter((value) => value !== dir);
      pressedDirs.length = 0;
      pressedDirs.push(...nextPressed);
    }
  });

  window.addEventListener('blur', () => {
    if (pressedDirs.length === 0) {
      return;
    }
    pressedDirs.length = 0;
  });
}

function wireTouchControls(): void {
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (!isTouch) {
    return;
  }

  touchControls.addEventListener('click', (event) => {
    if (isSpectator) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (!target) {
      return;
    }

    const dir = target.getAttribute('data-dir') as 'up' | 'down' | 'left' | 'right' | null;
    if (dir) {
      currentDir = dir;
      if (localPlayerPrediction) {
        localPlayerPrediction.desiredDir = dir;
      }
      send({ type: 'input', dir });
      return;
    }

    const action = target.getAttribute('data-action');
    if (action === 'awaken') {
      send({ type: 'input', awaken: true });
    }
  });

  updateTouchControlsVisibility();
}

function updateTouchControlsVisibility(): void {
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (!isTouch || isSpectator) {
    touchControls.classList.add('hidden');
  } else {
    touchControls.classList.remove('hidden');
  }
}

function placePing(kind: PingType): void {
  if (isSpectator) {
    pushLog('観戦モードではピン送信できません');
    return;
  }
  if (!snapshot) {
    return;
  }
  const me = snapshot.players.find((player) => player.id === meId);
  if (!me) {
    return;
  }

  send({
    type: 'place_ping',
    kind,
  });
}

function cycleSpectatorTarget(delta = 1): void {
  if (!snapshot) {
    return;
  }

  const players = snapshot.players;
  if (players.length === 0) {
    return;
  }

  if (!followPlayerId) {
    const best = [...players].sort((a, b) => b.score - a.score)[0];
    followPlayerId = best?.id ?? null;
    spectatorCameraMode = 'follow';
    freeCameraCenter = null;
    updateStatusPanels();
    return;
  }

  const idx = players.findIndex((player) => player.id === followPlayerId);
  const normalized = idx < 0 ? 0 : idx;
  const nextIndex = (normalized + delta + players.length) % players.length;
  const next = players[nextIndex];
  followPlayerId = next?.id ?? followPlayerId;
  spectatorCameraMode = 'follow';
  freeCameraCenter = null;
  updateStatusPanels();
}

function initSpectatorControls(): void {
  spectatorControls.innerHTML = `
    <div id="minimap-title" class="spec-title">ミニマップ</div>
    <div id="spectator-toolbar">
      <div class="spec-row">
        <button id="spectator-prev" type="button">◀</button>
        <span id="spectator-target">auto</span>
        <button id="spectator-next" type="button">▶</button>
      </div>
      <div class="spec-row">
        <button id="spectator-mode" type="button">追従モード</button>
        <button id="spectator-zoom-out" type="button">-</button>
        <span id="spectator-zoom">100%</span>
        <button id="spectator-zoom-in" type="button">+</button>
      </div>
      <div class="hint spectator-hint">Tab / ] / E: 次, [ / Q: 前, WASD/矢印: パン, +/-: ズーム</div>
      <div class="hint spectator-hint">ミニマップをクリックでフォーカス切替/自由カメラ移動</div>
    </div>
    <canvas id="spectator-minimap" width="220" height="220"></canvas>
    <div id="minimap-legend" class="hint"></div>
  `;

  const prev = document.getElementById('spectator-prev');
  const next = document.getElementById('spectator-next');
  prev?.addEventListener('click', () => cycleSpectatorTarget(-1));
  next?.addEventListener('click', () => cycleSpectatorTarget(1));

  const modeButton = document.getElementById('spectator-mode');
  modeButton?.addEventListener('click', () => toggleSpectatorCameraMode());

  const zoomOut = document.getElementById('spectator-zoom-out');
  const zoomIn = document.getElementById('spectator-zoom-in');
  zoomOut?.addEventListener('click', () => adjustSpectatorZoom(-1));
  zoomIn?.addEventListener('click', () => adjustSpectatorZoom(1));

  spectatorMinimapCanvas = document.getElementById('spectator-minimap') as HTMLCanvasElement | null;
  spectatorMinimapCtx = spectatorMinimapCanvas?.getContext('2d') ?? null;
  spectatorMinimapCanvas?.addEventListener('click', (event) => handleMinimapClick(event));

  canvas.addEventListener(
    'wheel',
    (event) => {
      if (!isSpectator) {
        return;
      }
      event.preventDefault();
      adjustSpectatorZoom(event.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );
}

function toggleSpectatorCameraMode(): void {
  if (!isSpectator || !world || !snapshot) {
    return;
  }
  if (spectatorCameraMode === 'follow') {
    spectatorCameraMode = 'free';
    const center = resolveCameraCenter(world, snapshot);
    freeCameraCenter = { x: center.x, y: center.y };
  } else {
    spectatorCameraMode = 'follow';
    freeCameraCenter = null;
  }
  updateStatusPanels();
}

function panSpectatorCamera(dir: 'up' | 'down' | 'left' | 'right'): void {
  if (!isSpectator || !world || !snapshot) {
    return;
  }
  if (spectatorCameraMode !== 'free') {
    spectatorCameraMode = 'free';
    const center = resolveCameraCenter(world, snapshot);
    freeCameraCenter = { x: center.x, y: center.y };
  }
  const step = Math.max(1, Math.round(2 / spectatorZoom));
  const current = freeCameraCenter ?? { x: world.width / 2, y: world.height / 2 };
  const next = { ...current };
  if (dir === 'up') {
    next.y -= step;
  } else if (dir === 'down') {
    next.y += step;
  } else if (dir === 'left') {
    next.x -= step;
  } else if (dir === 'right') {
    next.x += step;
  }
  freeCameraCenter = clampCameraCenter(world, next.x, next.y);
  updateStatusPanels();
}

function adjustSpectatorZoom(direction: 1 | -1): void {
  if (!isSpectator) {
    return;
  }
  spectatorZoom = clampNumber(spectatorZoom + direction * 0.1, 0.6, 2.4);
  updateStatusPanels();
}

function handleMinimapClick(event: MouseEvent): void {
  if (!isSpectator || !world || !snapshot || !spectatorMinimapCanvas) {
    return;
  }
  const rect = spectatorMinimapCanvas.getBoundingClientRect();
  const ratioX = clampNumber((event.clientX - rect.left) / rect.width, 0, 1);
  const ratioY = clampNumber((event.clientY - rect.top) / rect.height, 0, 1);
  const worldX = ratioX * Math.max(1, world.width - 1) + 0.5;
  const worldY = ratioY * Math.max(1, world.height - 1) + 0.5;

  let nearest: PlayerView | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const player of snapshot.players) {
    const distance = Math.hypot(player.x + 0.5 - worldX, player.y + 0.5 - worldY);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = player;
    }
  }

  if (nearest && nearestDistance <= 4) {
    followPlayerId = nearest.id;
    spectatorCameraMode = 'follow';
    freeCameraCenter = null;
  } else {
    spectatorCameraMode = 'free';
    freeCameraCenter = clampCameraCenter(world, worldX, worldY);
  }
  updateStatusPanels();
}

function drawSpectatorMinimap(
  worldState: WorldInit,
  state: Snapshot,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): void {
  if (!spectatorMinimapCanvas || !spectatorMinimapCtx) {
    return;
  }
  const miniWidth = spectatorMinimapCanvas.width;
  const miniHeight = spectatorMinimapCanvas.height;
  const mapScaleX = miniWidth / worldState.width;
  const mapScaleY = miniHeight / worldState.height;
  const miniCtx = spectatorMinimapCtx;

  miniCtx.clearRect(0, 0, miniWidth, miniHeight);
  miniCtx.fillStyle = 'rgba(4, 8, 16, 0.96)';
  miniCtx.fillRect(0, 0, miniWidth, miniHeight);
  miniCtx.strokeStyle = 'rgba(160, 198, 255, 0.28)';
  miniCtx.strokeRect(0, 0, miniWidth, miniHeight);

  const blinkOn = Math.floor(performance.now() / 320) % 2 === 0;
  for (const sector of state.sectors) {
    const x = sector.x * mapScaleX;
    const y = sector.y * mapScaleY;
    const width = Math.max(1, sector.size * mapScaleX);
    const height = Math.max(1, sector.size * mapScaleY);
    if (!sector.discovered) {
      miniCtx.fillStyle = '#1a1f29';
    } else if (sector.captured) {
      miniCtx.fillStyle = sector.dotCount > 0
        ? blinkOn
          ? '#f4c649'
          : '#5f94e0'
        : '#54b8ff';
    } else {
      miniCtx.fillStyle = '#2c3138';
    }
    miniCtx.fillRect(x, y, width, height);

    if (!sector.discovered && width >= 10 && height >= 10) {
      miniCtx.fillStyle = 'rgba(235, 241, 255, 0.85)';
      miniCtx.font = `${Math.max(8, Math.floor(Math.min(width, height) * 0.42))}px monospace`;
      miniCtx.fillText('?', x + width * 0.34, y + height * 0.64);
    }
  }

  miniCtx.lineWidth = 1.2;
  for (const sector of state.sectors) {
    const x = sector.x * mapScaleX;
    const y = sector.y * mapScaleY;
    const width = Math.max(1, sector.size * mapScaleX);
    const height = Math.max(1, sector.size * mapScaleY);
    miniCtx.strokeStyle = sector.discovered ? 'rgba(228, 239, 255, 0.58)' : 'rgba(118, 132, 156, 0.6)';
    miniCtx.strokeRect(x + 0.5, y + 0.5, Math.max(0, width - 1), Math.max(0, height - 1));
  }

  for (const ghost of state.ghosts) {
    const sector = sectorAt(worldState, state, ghost.x, ghost.y);
    if (!sector?.captured) {
      continue;
    }
    const gx = (ghost.x + 0.5) * mapScaleX;
    const gy = (ghost.y + 0.5) * mapScaleY;
    miniCtx.beginPath();
    miniCtx.arc(gx, gy, ghost.type === 'boss' ? 3.8 : 2.2, 0, Math.PI * 2);
    miniCtx.fillStyle = ghost.type === 'boss' ? '#ff4052' : '#ff7480';
    miniCtx.fill();
  }

  for (const gate of worldState.gates) {
    const ax = (gate.a.x + 0.5) * mapScaleX;
    const ay = (gate.a.y + 0.5) * mapScaleY;
    const bx = (gate.b.x + 0.5) * mapScaleX;
    const by = (gate.b.y + 0.5) * mapScaleY;
    const cx = (ax + bx) * 0.5;
    const cy = (ay + by) * 0.5;
    const gateColor = gate.open ? 'rgba(92, 228, 148, 0.98)' : 'rgba(255, 112, 112, 0.98)';

    miniCtx.strokeStyle = gateColor;
    miniCtx.lineWidth = gate.open ? 2.1 : 2.4;
    miniCtx.lineCap = 'round';
    miniCtx.beginPath();
    miniCtx.moveTo(ax, ay);
    miniCtx.lineTo(bx, by);
    miniCtx.stroke();

    miniCtx.fillStyle = gateColor;
    miniCtx.beginPath();
    miniCtx.arc(cx, cy, gate.open ? 1.8 : 2.1, 0, Math.PI * 2);
    miniCtx.fill();

    if (gate.open) {
      miniCtx.strokeStyle = 'rgba(220, 255, 233, 0.94)';
      miniCtx.lineWidth = 1.1;
      miniCtx.beginPath();
      miniCtx.arc(cx, cy, 3.2, 0, Math.PI * 2);
      miniCtx.stroke();
      continue;
    }

    miniCtx.strokeStyle = 'rgba(255, 214, 122, 0.95)';
    miniCtx.lineWidth = 1;
    miniCtx.beginPath();
    miniCtx.arc(cx, cy - 1.2, 1.8, Math.PI, 0);
    miniCtx.stroke();
    miniCtx.fillStyle = 'rgba(255, 214, 122, 0.95)';
    miniCtx.fillRect(cx - 1.5, cy - 1, 3, 3);
  }

  for (const player of state.players) {
    const px = (player.x + 0.5) * mapScaleX;
    const py = (player.y + 0.5) * mapScaleY;
    if (player.state === 'down') {
      miniCtx.beginPath();
      miniCtx.arc(px, py, Math.floor(performance.now() / 250) % 2 === 0 ? 3.8 : 2.2, 0, Math.PI * 2);
      miniCtx.fillStyle = '#ff4e57';
      miniCtx.fill();
      miniCtx.fillStyle = 'rgba(255, 239, 184, 0.95)';
      miniCtx.font = '8px monospace';
      miniCtx.fillText('★'.repeat(Math.max(1, Math.min(3, player.stocks))), px + 2.8, py - 2.2);
      continue;
    }

    const isMe = player.id === meId;
    const highlight = isSpectator && player.id === followPlayerId;
    miniCtx.beginPath();
    miniCtx.arc(px, py, isMe ? 3.6 : 2.9, 0, Math.PI * 2);
    miniCtx.fillStyle = isMe ? '#f6fbff' : '#ffd667';
    miniCtx.fill();
    if (highlight) {
      miniCtx.beginPath();
      miniCtx.arc(px, py, 5.2, 0, Math.PI * 2);
      miniCtx.strokeStyle = 'rgba(255, 240, 174, 0.9)';
      miniCtx.stroke();
    }
  }

  const viewportX = minX * mapScaleX;
  const viewportY = minY * mapScaleY;
  const viewportWidth = Math.max(2, (maxX - minX + 1) * mapScaleX);
  const viewportHeight = Math.max(2, (maxY - minY + 1) * mapScaleY);
  miniCtx.strokeStyle = 'rgba(113, 236, 255, 0.88)';
  miniCtx.lineWidth = 1.2;
  miniCtx.strokeRect(viewportX, viewportY, viewportWidth, viewportHeight);
}

function initAudioSettingsPanel(): void {
  audioSettingsPanel.innerHTML = `
    <div class="sound-title">サウンド設定</div>
    <div class="sound-row">
      <input id="sound-mute" type="checkbox" />
      <label for="sound-mute">ミュート</label>
    </div>
    <label><span id="sound-volume-label">音量</span>
      <input id="sound-volume" type="range" min="0" max="100" />
    </label>
    <div id="sound-status" class="hint"></div>
  `;

  soundMuteInputElement = document.getElementById('sound-mute') as HTMLInputElement | null;
  soundVolumeInputElement = document.getElementById('sound-volume') as HTMLInputElement | null;
  soundStatusElement = document.getElementById('sound-status');
  soundVolumeLabelElement = document.getElementById('sound-volume-label');

  soundMuteInputElement?.addEventListener('change', () => {
    soundMuted = !!soundMuteInputElement?.checked;
    localStorage.setItem(SOUND_MUTED_KEY, soundMuted ? '1' : '0');
    updateAudioGain();
    refreshAudioSettingsPanel();
  });

  soundVolumeInputElement?.addEventListener('input', () => {
    const currentPercent = Math.round(soundVolume * 100);
    const value = normalizeNumber(soundVolumeInputElement?.value ?? '', currentPercent, 0, 100);
    soundVolume = value / 100;
    localStorage.setItem(SOUND_VOLUME_KEY, String(value));
    updateAudioGain();
    refreshAudioSettingsPanel();
  });

  refreshAudioSettingsPanel();
}

function refreshAudioSettingsPanel(): void {
  const volumePercent = Math.round(soundVolume * 100);
  const statusText = audioUnlocked
    ? 'サウンド有効'
    : '初回操作（タップ/キー入力）後に再生されます';

  if (soundMuteInputElement) {
    soundMuteInputElement.checked = soundMuted;
  }
  if (soundVolumeInputElement) {
    soundVolumeInputElement.value = String(volumePercent);
  }
  if (soundStatusElement) {
    soundStatusElement.textContent = statusText;
  }
  if (soundVolumeLabelElement) {
    soundVolumeLabelElement.textContent = `音量 (${volumePercent}%)`;
  }
}

function wireAudioUnlock(): void {
  const unlock = () => {
    void ensureAudioUnlocked();
  };

  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);
  window.addEventListener('touchstart', unlock, { passive: true });
}

async function ensureAudioUnlocked(): Promise<void> {
  const audio = ensureAudioContext();
  if (!audio) {
    return;
  }
  if (audio.state === 'running') {
    audioUnlocked = true;
    refreshAudioSettingsPanel();
    return;
  }
  try {
    await audio.resume();
  } catch {
    return;
  }
  const resumedState = ensureAudioContext()?.state ?? audio.state;
  audioUnlocked = resumedState === 'running';
  refreshAudioSettingsPanel();
}

function ensureAudioContext(): AudioContext | null {
  const AudioContextCtor = (window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!AudioContextCtor) {
    return null;
  }
  if (!audioContext) {
    audioContext = new AudioContextCtor();
    audioMasterGain = audioContext.createGain();
    audioMasterGain.connect(audioContext.destination);
    updateAudioGain();
  }
  return audioContext;
}

function updateAudioGain(): void {
  if (!audioContext || !audioMasterGain) {
    return;
  }
  const volume = soundMuted ? 0 : soundVolume;
  audioMasterGain.gain.setTargetAtTime(volume, audioContext.currentTime, 0.01);
}

function playSoundForEvent(event: RuntimeEvent): void {
  if (event.type === 'sector_captured') {
    playTonePattern([
      { frequency: 660, durationMs: 90, type: 'triangle' },
      { frequency: 920, durationMs: 120, type: 'triangle' },
    ]);
    return;
  }
  if (event.type === 'player_down') {
    playTonePattern([{ frequency: 190, durationMs: 200, type: 'sawtooth' }]);
    return;
  }
  if (event.type === 'boss_spawned') {
    playTonePattern([
      { frequency: 220, durationMs: 120, type: 'sawtooth' },
      { frequency: 180, durationMs: 130, type: 'sawtooth' },
      { frequency: 140, durationMs: 170, type: 'sawtooth' },
    ]);
  }
}

function playAwakenTransitions(previous: Snapshot | null, next: Snapshot): void {
  if (!previous) {
    return;
  }

  const previousStateByPlayerId = new Map(previous.players.map((player) => [player.id, player.state] as const));
  const awakened = next.players.some((player) => previousStateByPlayerId.get(player.id) !== 'power' && player.state === 'power');
  if (awakened) {
    playAwakenSound();
  }
}

function playAwakenSound(): void {
  playTonePattern([
    { frequency: 760, durationMs: 80, type: 'triangle' },
    { frequency: 1020, durationMs: 80, type: 'triangle' },
    { frequency: 1360, durationMs: 110, type: 'triangle' },
  ]);
}

function playSoundForGameOver(reason: GameSummary['reason']): void {
  if (reason === 'victory') {
    playTonePattern([
      { frequency: 740, durationMs: 100, type: 'triangle' },
      { frequency: 980, durationMs: 110, type: 'triangle' },
      { frequency: 1320, durationMs: 160, type: 'triangle' },
    ]);
    return;
  }
  playTonePattern([
    { frequency: 280, durationMs: 120, type: 'square' },
    { frequency: 220, durationMs: 120, type: 'square' },
    { frequency: 180, durationMs: 170, type: 'square' },
  ]);
}

function playTonePattern(
  tones: Array<{ frequency: number; durationMs: number; type?: OscillatorType }>,
): void {
  if (soundMuted || soundVolume <= 0) {
    return;
  }

  const audio = ensureAudioContext();
  const master = audioMasterGain;
  if (!audio || !master) {
    return;
  }
  if (audio.state !== 'running') {
    audioUnlocked = false;
    refreshAudioSettingsPanel();
    void ensureAudioUnlocked();
    return;
  }
  if (!audioUnlocked) {
    audioUnlocked = true;
    refreshAudioSettingsPanel();
  }

  let offsetMs = 0;
  for (const tone of tones) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const startAt = audio.currentTime + offsetMs / 1000;
    const durationSec = tone.durationMs / 1000;
    const type = tone.type ?? 'sine';

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(tone.frequency, startAt);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.linearRampToValueAtTime(0.65, startAt + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationSec);

    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start(startAt);
    oscillator.stop(startAt + durationSec + 0.02);

    offsetMs += tone.durationMs + 24;
  }
}

function updateStatusPanels(): void {
  if (!lobby.classList.contains('hidden')) {
    topStatus.classList.add('hidden');
    spectatorControls.classList.add('hidden');
    return;
  }
  updateTopStatus();
  updateSpectatorControls();
}

function updateTopStatus(): void {
  if (!snapshot) {
    topStatus.classList.add('hidden');
    return;
  }

  const focus = isSpectator
    ? resolveFocusPlayer(snapshot)
    : snapshot.players.find((player) => player.id === meId) ?? null;
  if (!focus) {
    topStatus.classList.add('hidden');
    return;
  }

  const ratio = focus.gaugeMax > 0 ? (focus.gauge / focus.gaugeMax) * 100 : 0;
  const title = isSpectator ? `観戦: ${escapeHtml(focus.name)}` : `覚醒: ${escapeHtml(focus.name)}`;
  topStatus.innerHTML = `
    <div class="status-title">${title}</div>
    <div class="stock-line">Stock ${'★'.repeat(focus.stocks)}${'☆'.repeat(Math.max(0, 3 - focus.stocks))}</div>
    <div class="gauge-wrap"><div class="gauge-fill" style="width:${ratio.toFixed(1)}%"></div></div>
    <div class="gauge-text">${focus.gauge}/${focus.gaugeMax}</div>
  `;
  topStatus.classList.remove('hidden');
}

function updateSpectatorControls(): void {
  if (!snapshot || !world) {
    spectatorControls.classList.add('hidden');
    return;
  }

  spectatorControls.classList.remove('hidden');
  spectatorControls.classList.toggle('spectator-mode', isSpectator);

  const title = document.getElementById('minimap-title');
  if (title) {
    title.textContent = isSpectator ? '観戦ミニマップ' : 'ミニマップ';
  }

  const toolbar = document.getElementById('spectator-toolbar');
  toolbar?.classList.toggle('hidden', !isSpectator);

  const legend = document.getElementById('minimap-legend');
  if (legend) {
    legend.textContent = isSpectator
      ? '白:自分  黄:プレイヤー  赤:ダウン  赤点:ゴースト(制覇エリア)  黄点滅:劣化中  門:緑(開)/赤(閉)'
      : '白:自分  黄:味方  赤点滅:ダウン  赤点:ゴースト(制覇エリア)  黄点滅:劣化中  門:緑(開)/赤(閉)';
  }

  if (!isSpectator) {
    return;
  }

  const targetText = document.getElementById('spectator-target');
  if (targetText) {
    targetText.textContent = currentFollowName(snapshot.players);
  }

  const modeButton = document.getElementById('spectator-mode');
  if (modeButton) {
    modeButton.textContent = spectatorCameraMode === 'follow' ? '追従モード' : '自由カメラ';
  }

  const zoomText = document.getElementById('spectator-zoom');
  if (zoomText) {
    zoomText.textContent = `${Math.round(spectatorZoom * 100)}%`;
  }
}

function updateHud(): void {
  if (!snapshot || !world) {
    hud.innerHTML = '<div class="panel small">接続待機中...</div>';
    return;
  }

  const me = snapshot.players.find((player) => player.id === meId);
  const downCount = snapshot.players.filter((player) => player.state === 'down').length;
  const ghosts = snapshot.ghosts.length;
  const fruits = snapshot.fruits.length;
  const modeText = isSpectator ? '観戦' : 'プレイ';
  const cameraModeText = spectatorCameraMode === 'follow' ? '追従' : '自由';

  const meLine = isSpectator
    ? `<p>mode: ${modeText} | cam: ${cameraModeText} (${Math.round(spectatorZoom * 100)}%) | follow: ${escapeHtml(currentFollowName(snapshot.players))}</p>`
    : me
      ? `<p>mode: ${modeText}</p><p>自分: ${escapeHtml(me.name)} | score ${me.score} | 状態: ${me.state}</p>`
      : '<p>自分の情報なし</p>';
  const replayControls = replayPlayback
    ? `
      <h4>Replay</h4>
      <p>seed: ${replayPlayback.log.seed} / speed: x${replayPlayback.speed.toFixed(1)} / frame: ${replayPlayback.frameIndex + 1}/${replayPlayback.log.frames.length}</p>
      <div class="replay-inline">
        <button id="replay-toggle" type="button">${replayPlayback.playing ? '一時停止' : '再生'}</button>
        <button id="replay-slower" type="button">-速度</button>
        <button id="replay-faster" type="button">+速度</button>
        <button id="replay-exit" type="button">終了</button>
      </div>
      <input id="replay-seek" type="range" min="0" max="1000" value="${Math.round(
        replayPlayback.durationMs > 0 ? (replayPlayback.cursorMs / replayPlayback.durationMs) * 1000 : 0,
      )}" />
    `
    : '';

  hud.innerHTML = `
    <div class="panel small">
      <h3>HUD</h3>
      <p>制覇率: ${(snapshot.captureRatio * 100).toFixed(1)}%</p>
      <p>残り時間: ${formatMs(snapshot.timeLeftMs)}</p>
      <p>ゴースト: ${ghosts} / フルーツ: ${fruits}</p>
      <p>ダウン: ${downCount}</p>
      <p>ピン: ${snapshot.pings.length} (G:注目 / V:危険 / B:救助)</p>
      ${meLine}
      <h4>イベント</h4>
      <ul>${logs.slice(-8).map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
      ${replayControls}
    </div>
  `;
  wireReplayHudControls();
}

function currentFollowName(players: PlayerView[]): string {
  if (!followPlayerId) {
    return 'auto';
  }
  const found = players.find((player) => player.id === followPlayerId);
  return found?.name ?? 'auto';
}

function renderFrame(): void {
  requestAnimationFrame(renderFrame);
  advanceReplayPlayback();
  draw();
}

function wireReplayHudControls(): void {
  if (!replayPlayback) {
    return;
  }

  const toggle = document.getElementById('replay-toggle');
  const slower = document.getElementById('replay-slower');
  const faster = document.getElementById('replay-faster');
  const exit = document.getElementById('replay-exit');
  const seek = document.getElementById('replay-seek') as HTMLInputElement | null;

  toggle?.addEventListener('click', () => {
    if (!replayPlayback) {
      return;
    }
    replayPlayback.playing = !replayPlayback.playing;
    replayPlayback.lastPerfMs = performance.now();
    updateHud();
  });
  slower?.addEventListener('click', () => changeReplaySpeed(-1));
  faster?.addEventListener('click', () => changeReplaySpeed(1));
  exit?.addEventListener('click', () => closeReplay());
  seek?.addEventListener('input', () => {
    if (!replayPlayback) {
      return;
    }
    const ratio = clampNumber(Number(seek.value) / 1000, 0, 1);
    replayPlayback.cursorMs = replayPlayback.durationMs * ratio;
    const index = findReplayFrameIndex(replayPlayback.frameOffsetsMs, replayPlayback.cursorMs);
    setReplayFrameIndex(index);
    replayPlayback.playing = false;
    replayPlayback.lastPerfMs = performance.now();
    updateHud();
  });
}

function advanceReplayPlayback(): void {
  if (!replayPlayback) {
    return;
  }
  if (!replayPlayback.playing) {
    replayPlayback.lastPerfMs = performance.now();
    return;
  }
  if (replayPlayback.durationMs <= 0) {
    replayPlayback.playing = false;
    return;
  }

  const now = performance.now();
  const deltaMs = Math.max(0, now - replayPlayback.lastPerfMs);
  replayPlayback.lastPerfMs = now;
  replayPlayback.cursorMs = clampNumber(replayPlayback.cursorMs + deltaMs * replayPlayback.speed, 0, replayPlayback.durationMs);

  const nextIndex = findReplayFrameIndex(replayPlayback.frameOffsetsMs, replayPlayback.cursorMs);
  setReplayFrameIndex(nextIndex);

  if (replayPlayback.cursorMs >= replayPlayback.durationMs) {
    replayPlayback.playing = false;
    updateHud();
  }
}

function setReplayFrameIndex(index: number): void {
  if (!replayPlayback) {
    return;
  }
  const safeIndex = clampNumber(index, 0, replayPlayback.log.frames.length - 1);
  const frame = replayPlayback.log.frames[safeIndex];
  if (!frame) {
    return;
  }
  if (safeIndex === replayPlayback.frameIndex && snapshot?.tick === frame.snapshot.tick) {
    return;
  }
  replayPlayback.frameIndex = safeIndex;
  snapshot = cloneSnapshot(frame.snapshot);
  restoreReplayBoardState(frame);
  playerInterpolation.clear();
  ghostInterpolation.clear();
  updateStatusPanels();
  updateHud();
}

function changeReplaySpeed(direction: 1 | -1): void {
  if (!replayPlayback) {
    return;
  }
  const currentIndex = REPLAY_SPEED_OPTIONS.findIndex((speed) => speed === replayPlayback?.speed);
  const start = currentIndex >= 0 ? currentIndex : 1;
  const next = clampNumber(start + direction, 0, REPLAY_SPEED_OPTIONS.length - 1);
  replayPlayback.speed = REPLAY_SPEED_OPTIONS[next] as number;
  updateHud();
}

function openReplay(log: ReplayLog): void {
  if (log.frames.length === 0) {
    pushLog('リプレイに再生可能フレームがありません');
    return;
  }

  if (replayPlayback) {
    closeReplay();
  }

  replaySavedWorld = world ? cloneWorld(world) : null;
  replaySavedSnapshot = snapshot ? cloneSnapshot(snapshot) : null;
  replaySavedDots = Array.from(dotSet.values());
  replaySavedPellets = Array.from(pelletMap.values()).map((pellet) => ({
    key: dotKey(pellet.x, pellet.y),
    x: pellet.x,
    y: pellet.y,
    active: pellet.active,
  }));
  replaySavedIsSpectator = isSpectator;
  replaySavedCameraMode = spectatorCameraMode;
  replaySavedFollowPlayerId = followPlayerId;

  const firstNow = log.frames[0]?.snapshot.nowMs ?? 0;
  const offsets = log.frames.map((frame) => Math.max(0, frame.snapshot.nowMs - firstNow));
  const durationMs = offsets[offsets.length - 1] ?? 0;

  replayPlayback = {
    log,
    frameOffsetsMs: offsets,
    durationMs,
    frameIndex: -1,
    cursorMs: 0,
    speed: 1,
    playing: true,
    lastPerfMs: performance.now(),
  };
  isSpectator = true;
  spectatorCameraMode = 'follow';
  followPlayerId = null;
  localPlayerPrediction = null;
  updateTouchControlsVisibility();
  world = cloneWorld(log.world);
  result.classList.add('hidden');
  setReplayFrameIndex(0);
  pushLog(`Replay loaded: seed=${log.seed}, frame=${log.frames.length}`);
}

function closeReplay(): void {
  if (!replayPlayback) {
    return;
  }

  replayPlayback = null;
  world = replaySavedWorld ? cloneWorld(replaySavedWorld) : world;
  snapshot = replaySavedSnapshot ? cloneSnapshot(replaySavedSnapshot) : snapshot;
  dotSet.clear();
  for (const key of replaySavedDots ?? []) {
    dotSet.add(key);
  }
  pelletMap.clear();
  for (const pellet of replaySavedPellets ?? []) {
    pelletMap.set(pellet.key, {
      x: pellet.x,
      y: pellet.y,
      active: pellet.active,
    });
  }
  replaySavedWorld = null;
  replaySavedSnapshot = null;
  replaySavedDots = null;
  replaySavedPellets = null;
  isSpectator = replaySavedIsSpectator ?? isSpectator;
  spectatorCameraMode = replaySavedCameraMode ?? spectatorCameraMode;
  followPlayerId = replaySavedFollowPlayerId ?? followPlayerId;
  replaySavedIsSpectator = null;
  replaySavedCameraMode = null;
  replaySavedFollowPlayerId = null;
  updateTouchControlsVisibility();
  playerInterpolation.clear();
  ghostInterpolation.clear();
  localPlayerPrediction = null;
  updateStatusPanels();
  updateHud();
}

function exportReplay(log: ReplayLog): void {
  const payload = JSON.stringify(log);
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `mmo-packman-replay-${log.seed}-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function importReplayFromFile(file: File): Promise<void> {
  try {
    const raw = await file.text();
    const parsed = parseReplayLog(JSON.parse(raw) as unknown);
    if (!parsed) {
      pushLog('リプレイ形式を解釈できませんでした');
      return;
    }
    latestReplayLog = parsed;
    openReplay(parsed);
  } catch {
    pushLog('リプレイ読込に失敗しました');
  }
}

function draw(): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#07090f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!world || !snapshot) {
    drawCenteredText('サーバー接続中...', '#f5f7ff');
    return;
  }

  updateLocalPlayerPrediction(performance.now());
  const camera = resolveCameraCenter(world, snapshot);
  const centerX = camera.x;
  const centerY = camera.y;

  const baseTileSize = Math.floor(Math.min(canvas.width, canvas.height) / 26);
  const tileSize = isSpectator
    ? clampNumber(Math.floor(baseTileSize * spectatorZoom), 10, 54)
    : Math.max(12, Math.min(30, baseTileSize));
  const originX = Math.floor(canvas.width / 2 - centerX * tileSize);
  const originY = Math.floor(canvas.height / 2 - centerY * tileSize);

  const viewportCols = Math.ceil(canvas.width / tileSize) + 4;
  const viewportRows = Math.ceil(canvas.height / tileSize) + 4;
  const viewportMinX = Math.max(0, Math.floor(centerX - viewportCols / 2));
  const viewportMinY = Math.max(0, Math.floor(centerY - viewportRows / 2));
  const viewportMaxX = Math.min(world.width - 1, Math.ceil(centerX + viewportCols / 2));
  const viewportMaxY = Math.min(world.height - 1, Math.ceil(centerY + viewportRows / 2));

  const renderRangeScale = isSpectator ? 1 : 1.5;
  const visibleCols = Math.ceil(viewportCols * renderRangeScale);
  const visibleRows = Math.ceil(viewportRows * renderRangeScale);
  const minX = Math.max(0, Math.floor(centerX - visibleCols / 2));
  const minY = Math.max(0, Math.floor(centerY - visibleRows / 2));
  const maxX = Math.min(world.width - 1, Math.ceil(centerX + visibleCols / 2));
  const maxY = Math.min(world.height - 1, Math.ceil(centerY + visibleRows / 2));

  for (let y = minY; y <= maxY; y += 1) {
    const row = world.tiles[y] as string;
    for (let x = minX; x <= maxX; x += 1) {
      const sx = originX + x * tileSize;
      const sy = originY + y * tileSize;
      const sector = sectorAt(world, snapshot, x, y);
      const discovered = !!sector?.discovered;

      if (row[x] === '#') {
        if (!discovered) {
          ctx.fillStyle = '#0d0f17';
        } else if (sector?.captured) {
          ctx.fillStyle = '#10293c';
        } else if (sector?.type === 'dark') {
          ctx.fillStyle = '#101524';
        } else {
          ctx.fillStyle = '#0b1120';
        }
        ctx.fillRect(sx, sy, tileSize, tileSize);
      } else {
        if (!discovered) {
          ctx.fillStyle = '#090b12';
          ctx.fillRect(sx, sy, tileSize, tileSize);
          continue;
        }

        if (sector?.captured) {
          ctx.fillStyle = '#113044';
        } else if (sector?.type === 'dark') {
          ctx.fillStyle = '#131417';
        } else {
          ctx.fillStyle = '#0d1322';
        }
        ctx.fillRect(sx, sy, tileSize, tileSize);
      }
    }
  }
  drawWallOutlines(world, snapshot, originX, originY, tileSize, minX, minY, maxX, maxY);

  ctx.fillStyle = '#ffd66a';
  for (const key of dotSet) {
    const [x, y] = key.split(',').map(Number);
    if (x < minX || x > maxX || y < minY || y > maxY) {
      continue;
    }
    const row = world.tiles[y] as string | undefined;
    if (!row || row[x] !== '.') {
      continue;
    }
    const sector = sectorAt(world, snapshot, x, y);
    if (!sector?.discovered) {
      continue;
    }
    const sx = originX + x * tileSize + tileSize / 2;
    const sy = originY + y * tileSize + tileSize / 2;
    circle(sx, sy, Math.max(1.5, tileSize * 0.1), '#ffd66a');
  }

  for (const pellet of pelletMap.values()) {
    if (!pellet.active) {
      continue;
    }
    if (pellet.x < minX || pellet.x > maxX || pellet.y < minY || pellet.y > maxY) {
      continue;
    }
    const row = world.tiles[pellet.y] as string | undefined;
    if (!row || row[pellet.x] !== '.') {
      continue;
    }
    const sector = sectorAt(world, snapshot, pellet.x, pellet.y);
    if (!sector?.discovered) {
      continue;
    }
    const sx = originX + pellet.x * tileSize + tileSize / 2;
    const sy = originY + pellet.y * tileSize + tileSize / 2;
    circle(sx, sy, Math.max(3, tileSize * 0.22), '#7af0ff');
  }

  drawGates(world, snapshot, originX, originY, tileSize, minX, minY, maxX, maxY);
  drawFruits(snapshot.fruits, world, snapshot, originX, originY, tileSize, minX, minY, maxX, maxY);
  drawGhosts(snapshot.ghosts, world, snapshot, originX, originY, tileSize, minX, minY, maxX, maxY);
  drawPlayers(
    snapshot.players,
    world,
    snapshot,
    originX,
    originY,
    tileSize,
    minX,
    minY,
    maxX,
    maxY,
    snapshot.nowMs,
  );
  drawPings(snapshot.pings, world, snapshot, originX, originY, tileSize, minX, minY, maxX, maxY, snapshot.nowMs);
  drawSpectatorMinimap(world, snapshot, viewportMinX, viewportMinY, viewportMaxX, viewportMaxY);
}

function drawWallOutlines(
  worldState: WorldInit,
  state: Snapshot,
  originX: number,
  originY: number,
  tileSize: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): void {
  const baseStroke = clampNumber(tileSize * 0.2, 1.4, 7.5);
  const cornerRadius = clampNumber(tileSize * 0.22, 1.4, tileSize * 0.36);

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (let y = minY; y <= maxY; y += 1) {
    const row = worldState.tiles[y] as string;
    for (let x = minX; x <= maxX; x += 1) {
      if (row[x] !== '#') {
        continue;
      }

      const sector = sectorAt(worldState, state, x, y);
      if (!sector || !sector.discovered) {
        continue;
      }
      const sx = originX + x * tileSize;
      const sy = originY + y * tileSize;
      const wallPath = buildWallTilePath(worldState, x, y, sx, sy, tileSize, baseStroke, cornerRadius);
      if (!wallPath) {
        continue;
      }

      ctx.strokeStyle = wallOutlineOuterColor();
      ctx.lineWidth = baseStroke * 1.25;
      ctx.stroke(wallPath);
      ctx.strokeStyle = wallOutlineColor(sector);
      ctx.lineWidth = baseStroke * 0.78;
      ctx.stroke(wallPath);
    }
  }

  ctx.restore();
}

function buildWallTilePath(
  worldState: WorldInit,
  x: number,
  y: number,
  sx: number,
  sy: number,
  tileSize: number,
  strokeWidth: number,
  cornerRadius: number,
): Path2D | null {
  const topOpen = !isWallTile(worldState, x, y - 1);
  const rightOpen = !isWallTile(worldState, x + 1, y);
  const bottomOpen = !isWallTile(worldState, x, y + 1);
  const leftOpen = !isWallTile(worldState, x - 1, y);
  if (!topOpen && !rightOpen && !bottomOpen && !leftOpen) {
    return null;
  }

  const inset = strokeWidth * 0.5 + 0.9;
  const left = sx + (leftOpen ? inset : 0);
  const right = sx + tileSize - (rightOpen ? inset : 0);
  const top = sy + (topOpen ? inset : 0);
  const bottom = sy + tileSize - (bottomOpen ? inset : 0);
  const radius = Math.min(cornerRadius, Math.max(1.2, (right - left) * 0.5), Math.max(1.2, (bottom - top) * 0.5));

  const path = new Path2D();
  if (topOpen) {
    path.moveTo(left + (leftOpen ? radius : 0), top);
    path.lineTo(right - (rightOpen ? radius : 0), top);
  }
  if (rightOpen) {
    path.moveTo(right, top + (topOpen ? radius : 0));
    path.lineTo(right, bottom - (bottomOpen ? radius : 0));
  }
  if (bottomOpen) {
    path.moveTo(right - (rightOpen ? radius : 0), bottom);
    path.lineTo(left + (leftOpen ? radius : 0), bottom);
  }
  if (leftOpen) {
    path.moveTo(left, bottom - (bottomOpen ? radius : 0));
    path.lineTo(left, top + (topOpen ? radius : 0));
  }

  if (topOpen && rightOpen) {
    path.moveTo(right - radius, top);
    path.arc(right - radius, top + radius, radius, -Math.PI / 2, 0);
  }
  if (rightOpen && bottomOpen) {
    path.moveTo(right, bottom - radius);
    path.arc(right - radius, bottom - radius, radius, 0, Math.PI / 2);
  }
  if (bottomOpen && leftOpen) {
    path.moveTo(left + radius, bottom);
    path.arc(left + radius, bottom - radius, radius, Math.PI / 2, Math.PI);
  }
  if (leftOpen && topOpen) {
    path.moveTo(left, top + radius);
    path.arc(left + radius, top + radius, radius, Math.PI, Math.PI * 1.5);
  }
  return path;
}

function isWallTile(worldState: WorldInit, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= worldState.width || y >= worldState.height) {
    return false;
  }
  const row = worldState.tiles[y];
  if (!row) {
    return false;
  }
  return row[x] === '#';
}

function wallOutlineColor(sector: Snapshot['sectors'][number]): string {
  if (sector.captured) {
    return '#79d8ff';
  }
  if (sector.type === 'dark') {
    return '#5f8dbf';
  }
  return '#7bb8ff';
}

function wallOutlineOuterColor(): string {
  return 'rgba(11, 24, 52, 0.86)';
}

function resolveCameraCenter(worldState: WorldInit, state: Snapshot): { x: number; y: number } {
  if (isSpectator && spectatorCameraMode === 'free' && freeCameraCenter) {
    return clampCameraCenter(worldState, freeCameraCenter.x, freeCameraCenter.y);
  }

  if (!isSpectator) {
    const me = state.players.find((player) => player.id === meId);
    if (!me) {
      return clampCameraCenter(worldState, worldState.width / 2, worldState.height / 2);
    }
    const renderPos = getRenderPositionForPlayer(me, worldState, state);
    const sector = sectorAt(worldState, state, Math.floor(renderPos.x), Math.floor(renderPos.y));
    if (!sector) {
      return clampCameraCenter(worldState, renderPos.x + 0.5, renderPos.y + 0.5);
    }
    return clampCameraCenter(worldState, sector.x + sector.size / 2, sector.y + sector.size / 2);
  }

  const focus = resolveFocusPlayer(state);
  if (!focus) {
    return clampCameraCenter(worldState, worldState.width / 2, worldState.height / 2);
  }

  const sector = sectorAt(worldState, state, focus.x, focus.y);
  if (!sector) {
    return clampCameraCenter(worldState, focus.x + 0.5, focus.y + 0.5);
  }

  return clampCameraCenter(worldState, sector.x + sector.size / 2, sector.y + sector.size / 2);
}

function clampCameraCenter(worldState: WorldInit, x: number, y: number): { x: number; y: number } {
  const maxX = Math.max(0.5, worldState.width - 0.5);
  const maxY = Math.max(0.5, worldState.height - 0.5);
  return {
    x: clampNumber(x, 0.5, maxX),
    y: clampNumber(y, 0.5, maxY),
  };
}

function resolveFocusPlayer(state: Snapshot): PlayerView | null {
  if (!isSpectator) {
    return state.players.find((player) => player.id === meId) ?? null;
  }

  const members = state.players;
  if (members.length === 0) {
    return null;
  }

  if (!followPlayerId) {
    return [...members].sort((a, b) => b.score - a.score)[0] ?? null;
  }
  const followed = members.find((player) => player.id === followPlayerId);
  if (followed) {
    return followed;
  }

  const fallback = [...members].sort((a, b) => b.score - a.score)[0] ?? null;
  if (spectatorCameraMode === 'follow') {
    followPlayerId = fallback?.id ?? null;
  }
  return fallback;
}

function drawGates(
  worldState: WorldInit,
  state: Snapshot,
  originX: number,
  originY: number,
  tileSize: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): void {
  for (const gate of state.gates) {
    for (const p of [gate.a, gate.b]) {
      if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) {
        continue;
      }
      const sector = sectorAt(worldState, state, p.x, p.y);
      if (!sector?.discovered) {
        continue;
      }

      const sx = originX + p.x * tileSize;
      const sy = originY + p.y * tileSize;
      ctx.fillStyle = gate.open ? 'rgba(92, 211, 130, 0.7)' : 'rgba(255, 110, 110, 0.8)';
      ctx.fillRect(sx + 2, sy + 2, tileSize - 4, tileSize - 4);
    }

    for (const sw of [gate.switchA, gate.switchB]) {
      if (sw.x < minX || sw.x > maxX || sw.y < minY || sw.y > maxY) {
        continue;
      }
      const sx = originX + sw.x * tileSize + tileSize / 2;
      const sy = originY + sw.y * tileSize + tileSize / 2;
      drawGateSwitchIcon(sx, sy, tileSize);
    }
  }
}

function drawFruits(
  fruits: FruitView[],
  worldState: WorldInit,
  state: Snapshot,
  originX: number,
  originY: number,
  tileSize: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): void {
  for (const fruit of fruits) {
    if (fruit.x < minX || fruit.x > maxX || fruit.y < minY || fruit.y > maxY) {
      continue;
    }
    const sector = sectorAt(worldState, state, fruit.x, fruit.y);
    if (!sector?.discovered) {
      continue;
    }
    const sx = originX + fruit.x * tileSize + tileSize / 2;
    const sy = originY + fruit.y * tileSize + tileSize / 2;
    circle(sx, sy, Math.max(3, tileSize * 0.24), fruitColor(fruit.type));
  }
}

function drawGhosts(
  ghosts: GhostView[],
  worldState: WorldInit,
  state: Snapshot,
  originX: number,
  originY: number,
  tileSize: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): void {
  for (const ghost of ghosts) {
    const renderPos = getInterpolatedPosition(ghost.id, ghost.x, ghost.y, ghostInterpolation);
    if (renderPos.x < minX || renderPos.x > maxX || renderPos.y < minY || renderPos.y > maxY) {
      continue;
    }
    const sector = sectorAt(worldState, state, Math.floor(renderPos.x), Math.floor(renderPos.y));
    if (!sector?.discovered) {
      continue;
    }

    const sx = originX + renderPos.x * tileSize + tileSize / 2;
    const sy = originY + renderPos.y * tileSize + tileSize / 2;
    drawGhostIcon(sx, sy, tileSize, ghostColor(ghost.type), ghost.type === 'boss');

    if (ghost.type === 'boss') {
      ctx.fillStyle = '#ffffff';
      ctx.font = `${Math.max(10, Math.floor(tileSize * 0.4))}px monospace`;
      ctx.fillText(`${ghost.hp}`, sx - tileSize * 0.1, sy - tileSize * 0.45);
    }
  }
}

function drawGateSwitchIcon(x: number, y: number, tileSize: number): void {
  const outer = Math.max(4, tileSize * 0.22);
  const inner = Math.max(2, outer * 0.45);

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = '#ffd16e';
  ctx.fillRect(-outer, -outer, outer * 2, outer * 2);
  ctx.fillStyle = '#071321';
  ctx.fillRect(-inner, -inner, inner * 2, inner * 2);
  ctx.restore();
}

function drawGhostIcon(x: number, y: number, tileSize: number, color: string, boss: boolean): void {
  const outerRadius = Math.max(4.8, tileSize * (boss ? 0.42 : 0.34));
  const innerRadius = outerRadius * 0.6;
  const spikes = boss ? 11 : 9;

  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i += 1) {
    const angle = (-Math.PI / 2) + (Math.PI * i) / spikes;
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    const px = x + Math.cos(angle) * radius;
    const py = y + Math.sin(angle) * radius;
    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  ctx.lineWidth = boss ? 2.1 : 1.4;
  ctx.strokeStyle = boss ? '#ffe8b3' : 'rgba(10, 20, 34, 0.9)';
  ctx.stroke();
}

function drawPlayers(
  players: PlayerView[],
  worldState: WorldInit,
  state: Snapshot,
  originX: number,
  originY: number,
  tileSize: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  nowMs: number,
): void {
  for (const player of players) {
    const renderPos = getRenderPositionForPlayer(player, worldState, state);
    if (renderPos.x < minX || renderPos.x > maxX || renderPos.y < minY || renderPos.y > maxY) {
      continue;
    }
    const sector = sectorAt(worldState, state, Math.floor(renderPos.x), Math.floor(renderPos.y));
    if (!sector?.discovered) {
      continue;
    }

    const sx = originX + renderPos.x * tileSize + tileSize / 2;
    const sy = originY + renderPos.y * tileSize + tileSize / 2;
    const base = player.id === meId ? '#ffef8f' : '#f5b264';
    const color = player.state === 'down' ? 'rgba(189, 68, 68, 0.55)' : base;
    circle(sx, sy, Math.max(4, tileSize * 0.36), color);

    if (player.state === 'power') {
      const remainingMs = Math.max(0, player.powerUntil - nowMs);
      drawPowerEffect(sx, sy, tileSize, nowMs, remainingMs, player.id === meId);
    }

    ctx.fillStyle = '#f7f9ff';
    ctx.font = `${Math.max(9, Math.floor(tileSize * 0.36))}px monospace`;
    ctx.fillText(player.name.slice(0, 7), sx - tileSize * 0.45, sy - tileSize * 0.45);
  }
}

function drawPings(
  pings: PingView[],
  worldState: WorldInit,
  state: Snapshot,
  originX: number,
  originY: number,
  tileSize: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  nowMs: number,
): void {
  for (const ping of pings) {
    if (ping.x < minX || ping.x > maxX || ping.y < minY || ping.y > maxY) {
      continue;
    }
    const sector = sectorAt(worldState, state, ping.x, ping.y);
    if (!sector?.discovered) {
      continue;
    }

    const px = originX + ping.x * tileSize + tileSize / 2;
    const py = originY + ping.y * tileSize + tileSize / 2;
    const remainRatio = clampNumber((ping.expiresAtMs - nowMs) / Math.max(1, ping.expiresAtMs - ping.createdAtMs), 0, 1);
    const pulse = 1 + 0.12 * Math.sin((nowMs / 180) % (Math.PI * 2));
    const baseRadius = Math.max(5, tileSize * 0.35) * pulse;
    const color = pingKindColor(ping.kind);

    circle(px, py, baseRadius, `rgba(${color.r}, ${color.g}, ${color.b}, ${(0.25 + remainRatio * 0.45).toFixed(3)})`);
    circle(px, py, Math.max(3, tileSize * 0.18), `rgb(${color.r}, ${color.g}, ${color.b})`);

    ctx.fillStyle = `rgba(240, 248, 255, ${(0.55 + remainRatio * 0.45).toFixed(3)})`;
    ctx.font = `${Math.max(9, Math.floor(tileSize * 0.28))}px monospace`;
    ctx.fillText(`${pingKindLabel(ping.kind)} ${ping.ownerName.slice(0, 8)}`, px - tileSize * 0.55, py - tileSize * 0.58);
  }
}

function drawPowerEffect(x: number, y: number, tileSize: number, nowMs: number, remainingMs: number, isMe: boolean): void {
  const base = tileSize * 0.52;
  const phase = (nowMs % 1200) / 1200;
  const warningWindowMs = 3_000;
  const dangerWindowMs = 1_000;
  const inWarning = remainingMs <= warningWindowMs;
  const inDanger = remainingMs <= dangerWindowMs;
  const blinkPeriodMs = inDanger ? 140 : 220;
  const blinkOn = !inWarning || Math.floor(nowMs / blinkPeriodMs) % 2 === 0;

  const ringColor = inDanger ? { r: 255, g: 106, b: 96 } : { r: 95, g: 238, b: 255 };
  const auraColor = inDanger ? { r: 255, g: 84, b: 110 } : { r: 82, g: 175, b: 255 };
  const sparkColor = inDanger ? { r: 255, g: 209, b: 118 } : { r: 165, g: 249, b: 255 };

  if (!blinkOn) {
    circle(x, y, base * 1.05, `rgba(${auraColor.r}, ${auraColor.g}, ${auraColor.b}, 0.08)`);
    return;
  }

  for (let ring = 0; ring < 3; ring += 1) {
    const p = (phase + ring * 0.22) % 1;
    const radius = base + tileSize * (0.18 + p * 0.75);
    const alpha = (1 - p) * (isMe ? 0.52 : 0.42);
    circle(x, y, radius, `rgba(${ringColor.r}, ${ringColor.g}, ${ringColor.b}, ${alpha.toFixed(3)})`, false);
  }

  circle(x, y, base * 1.18, `rgba(${auraColor.r}, ${auraColor.g}, ${auraColor.b}, ${isMe ? '0.30' : '0.22'})`);

  const sparks = 8;
  for (let i = 0; i < sparks; i += 1) {
    const angle = ((Math.PI * 2) / sparks) * i + phase * Math.PI * 2;
    const rr = base * (1.2 + ((i % 2 === 0 ? phase : 1 - phase) * 0.7));
    const sx = x + Math.cos(angle) * rr;
    const sy = y + Math.sin(angle) * rr;
    circle(
      sx,
      sy,
      Math.max(1.8, tileSize * 0.07),
      `rgba(${sparkColor.r}, ${sparkColor.g}, ${sparkColor.b}, ${inDanger ? '0.92' : '0.88'})`,
    );
  }
}

function updateInterpolationStates(nextSnapshot: Snapshot): void {
  const nowMs = performance.now();
  const tickRate = config?.tickRate ?? 20;
  const frameMs = 1000 / Math.max(1, tickRate);
  const durationFloorMs = Math.max(16, frameMs);
  const durationCeilingMs = Math.max(180, frameMs * 8);

  updateEntityInterpolationMap(
    playerInterpolation,
    nextSnapshot.players.map((player) => ({ id: player.id, x: player.x, y: player.y })),
    nowMs,
    3,
    durationFloorMs,
    durationCeilingMs,
  );
  updateEntityInterpolationMap(
    ghostInterpolation,
    nextSnapshot.ghosts.map((ghost) => ({ id: ghost.id, x: ghost.x, y: ghost.y })),
    nowMs,
    4,
    durationFloorMs,
    durationCeilingMs,
  );
}

function updateEntityInterpolationMap(
  map: Map<string, InterpolationState>,
  entities: Array<{ id: string; x: number; y: number }>,
  nowMs: number,
  teleportThreshold: number,
  durationFloorMs: number,
  durationCeilingMs: number,
): void {
  const aliveIds = new Set<string>();

  for (const entity of entities) {
    aliveIds.add(entity.id);

    const previous = map.get(entity.id);
    if (!previous) {
      map.set(entity.id, {
        fromX: entity.x,
        fromY: entity.y,
        toX: entity.x,
        toY: entity.y,
        updatedAtMs: nowMs,
        durationMs: durationFloorMs,
        lastMoveAtMs: nowMs,
      });
      continue;
    }

    const moved = previous.toX !== entity.x || previous.toY !== entity.y;
    if (!moved) {
      continue;
    }

    const previousDurationMs = Math.max(1, previous.durationMs);
    const previousAlpha = clampNumber((nowMs - previous.updatedAtMs) / previousDurationMs, 0, 1);
    let fromX = previous.fromX + (previous.toX - previous.fromX) * previousAlpha;
    let fromY = previous.fromY + (previous.toY - previous.fromY) * previousAlpha;
    const jumpDistance = Math.abs(previous.toX - entity.x) + Math.abs(previous.toY - entity.y);
    if (jumpDistance > teleportThreshold) {
      fromX = entity.x;
      fromY = entity.y;
    }
    const rawMoveIntervalMs = nowMs - previous.lastMoveAtMs;
    // Avoid very slow interpolation right after a long idle period.
    const fallbackIntervalMs = Math.max(previous.durationMs, durationFloorMs * 3);
    const moveIntervalMs = rawMoveIntervalMs > durationCeilingMs ? fallbackIntervalMs : rawMoveIntervalMs;
    const targetDurationMs = clampNumber(moveIntervalMs, durationFloorMs, durationCeilingMs);
    const durationMs = clampNumber(previous.durationMs * 0.35 + targetDurationMs * 0.65, durationFloorMs, durationCeilingMs);

    map.set(entity.id, {
      fromX,
      fromY,
      toX: entity.x,
      toY: entity.y,
      updatedAtMs: nowMs,
      durationMs,
      lastMoveAtMs: nowMs,
    });
  }

  for (const existingId of map.keys()) {
    if (!aliveIds.has(existingId)) {
      map.delete(existingId);
    }
  }
}

function getInterpolatedPosition(
  entityId: string,
  currentX: number,
  currentY: number,
  map: Map<string, InterpolationState>,
): { x: number; y: number } {
  const item = map.get(entityId);
  if (!item) {
    return { x: currentX, y: currentY };
  }
  const alpha = clampNumber((performance.now() - item.updatedAtMs) / Math.max(1, item.durationMs), 0, 1);

  return {
    x: item.fromX + (item.toX - item.fromX) * alpha,
    y: item.fromY + (item.toY - item.fromY) * alpha,
  };
}

function syncLocalPlayerPredictionFromSnapshot(nextSnapshot: Snapshot): void {
  if (isSpectator || replayPlayback || !world || meId.length === 0) {
    localPlayerPrediction = null;
    return;
  }
  const me = nextSnapshot.players.find((player) => player.id === meId);
  if (!me) {
    localPlayerPrediction = null;
    return;
  }

  const nowMs = performance.now();
  const desiredDir = currentDir !== 'none' ? currentDir : me.dir;
  if (!localPlayerPrediction) {
    localPlayerPrediction = {
      x: me.x,
      y: me.y,
      dir: me.dir,
      desiredDir,
      moveBuffer: 0,
      renderCorrectionX: 0,
      renderCorrectionY: 0,
      lastUpdateMs: nowMs,
      lastSnapshotTick: nextSnapshot.tick,
    };
    return;
  }

  const previousVisual = renderPositionFromPrediction(localPlayerPrediction, world, nextSnapshot);
  localPlayerPrediction.desiredDir = desiredDir;
  localPlayerPrediction.lastUpdateMs = nowMs;
  localPlayerPrediction.lastSnapshotTick = nextSnapshot.tick;

  const drift = Math.abs(localPlayerPrediction.x - me.x) + Math.abs(localPlayerPrediction.y - me.y);
  const shouldHardSnap = drift >= 2 || me.state === 'down';
  if (shouldHardSnap) {
    localPlayerPrediction.x = me.x;
    localPlayerPrediction.y = me.y;
    localPlayerPrediction.dir = me.dir;
    localPlayerPrediction.moveBuffer = 0;
  }

  const nextVisual = renderPositionFromPrediction(localPlayerPrediction, world, nextSnapshot);
  localPlayerPrediction.renderCorrectionX = clampNumber(
    localPlayerPrediction.renderCorrectionX + (previousVisual.x - nextVisual.x),
    -1.2,
    1.2,
  );
  localPlayerPrediction.renderCorrectionY = clampNumber(
    localPlayerPrediction.renderCorrectionY + (previousVisual.y - nextVisual.y),
    -1.2,
    1.2,
  );
}

function updateLocalPlayerPrediction(nowMs: number): void {
  if (!world || !snapshot || isSpectator || replayPlayback || !localPlayerPrediction) {
    return;
  }
  const me = snapshot.players.find((player) => player.id === meId);
  if (!me) {
    localPlayerPrediction = null;
    return;
  }

  if (me.state === 'down') {
    localPlayerPrediction.x = me.x;
    localPlayerPrediction.y = me.y;
    localPlayerPrediction.dir = 'none';
    localPlayerPrediction.moveBuffer = 0;
    localPlayerPrediction.renderCorrectionX = 0;
    localPlayerPrediction.renderCorrectionY = 0;
    localPlayerPrediction.lastUpdateMs = nowMs;
    return;
  }

  const dtSec = clampNumber((nowMs - localPlayerPrediction.lastUpdateMs) / 1000, 0, 0.1);
  localPlayerPrediction.lastUpdateMs = nowMs;
  localPlayerPrediction.desiredDir = currentDir !== 'none' ? currentDir : localPlayerPrediction.desiredDir;
  localPlayerPrediction.moveBuffer += resolvePredictedPlayerSpeed(me, localPlayerPrediction.x, localPlayerPrediction.y) * dtSec;
  const correctionDecay = clampNumber(1 - dtSec * 12, 0, 1);
  localPlayerPrediction.renderCorrectionX *= correctionDecay;
  localPlayerPrediction.renderCorrectionY *= correctionDecay;
  if (Math.abs(localPlayerPrediction.renderCorrectionX) < 0.001) {
    localPlayerPrediction.renderCorrectionX = 0;
  }
  if (Math.abs(localPlayerPrediction.renderCorrectionY) < 0.001) {
    localPlayerPrediction.renderCorrectionY = 0;
  }

  let safety = 0;
  while (localPlayerPrediction.moveBuffer >= 1 && safety < 6) {
    localPlayerPrediction.moveBuffer -= 1;
    safety += 1;

    const nextDir = resolveStepDirectionForPosition(
      localPlayerPrediction.x,
      localPlayerPrediction.y,
      localPlayerPrediction.desiredDir,
      localPlayerPrediction.dir,
      world,
      snapshot.gates,
    );
    if (nextDir === 'none') {
      localPlayerPrediction.dir = 'none';
      localPlayerPrediction.moveBuffer = 0;
      break;
    }

    const vector = DIRECTION_VECTORS[nextDir];
    localPlayerPrediction.x += vector.x;
    localPlayerPrediction.y += vector.y;
    localPlayerPrediction.dir = nextDir;
  }
}

function getRenderPositionForPlayer(player: PlayerView, worldState: WorldInit, state: Snapshot): { x: number; y: number } {
  if (player.id === meId && !isSpectator && !replayPlayback) {
    const predicted = getLocalPlayerRenderPosition(worldState, state);
    if (predicted) {
      return predicted;
    }
  }
  return getInterpolatedPosition(player.id, player.x, player.y, playerInterpolation);
}

function getLocalPlayerRenderPosition(worldState: WorldInit, state: Snapshot): { x: number; y: number } | null {
  if (!localPlayerPrediction) {
    return null;
  }
  const me = state.players.find((player) => player.id === meId);
  if (!me) {
    return null;
  }
  if (me.state === 'down') {
    return { x: me.x, y: me.y };
  }

  return renderPositionFromPrediction(localPlayerPrediction, worldState, state);
}

function renderPositionFromPrediction(
  prediction: LocalPlayerPredictionState,
  worldState: WorldInit,
  state: Snapshot,
): { x: number; y: number } {
  const nextDir = resolveStepDirectionForPosition(
    prediction.x,
    prediction.y,
    prediction.desiredDir,
    prediction.dir,
    worldState,
    state.gates,
  );
  if (nextDir === 'none') {
    return {
      x: prediction.x + prediction.renderCorrectionX,
      y: prediction.y + prediction.renderCorrectionY,
    };
  }

  const vector = DIRECTION_VECTORS[nextDir];
  const progress = clampNumber(prediction.moveBuffer, 0, 0.999);
  return {
    x: prediction.x + vector.x * progress + prediction.renderCorrectionX,
    y: prediction.y + vector.y * progress + prediction.renderCorrectionY,
  };
}

function resolvePredictedPlayerSpeed(player: PlayerView, atX: number, atY: number): number {
  if (!world || !snapshot) {
    return PLAYER_BASE_SPEED;
  }

  let speed = PLAYER_BASE_SPEED;
  const playerCount = snapshot.players.length;
  if (playerCount >= 80 && playerCount <= 100) {
    speed *= 1.5;
  } else if (playerCount === 5 && config?.difficulty === 'casual' && snapshot.captureRatio >= 0.4) {
    speed *= 1.12;
  }

  const sector = sectorAt(world, snapshot, atX, atY);
  if (sector?.captured) {
    speed *= PLAYER_CAPTURED_SPEED_MULTIPLIER;
  }
  if (snapshot.nowMs < player.speedBuffUntil) {
    speed *= 1.3;
  }
  return speed;
}

function resolveStepDirectionForPosition(
  fromX: number,
  fromY: number,
  desiredDir: Direction,
  currentDir: Direction,
  worldState: WorldInit,
  gates: Snapshot['gates'],
): Direction {
  if (desiredDir !== 'none') {
    const desired = DIRECTION_VECTORS[desiredDir];
    const dx = fromX + desired.x;
    const dy = fromY + desired.y;
    if (canMoveBetweenCells(worldState, gates, fromX, fromY, dx, dy)) {
      return desiredDir;
    }
  }

  if (currentDir !== 'none') {
    const current = DIRECTION_VECTORS[currentDir];
    const cx = fromX + current.x;
    const cy = fromY + current.y;
    if (canMoveBetweenCells(worldState, gates, fromX, fromY, cx, cy)) {
      return currentDir;
    }
  }
  return 'none';
}

function canMoveBetweenCells(
  worldState: WorldInit,
  gates: Snapshot['gates'],
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): boolean {
  if (!isWalkableTile(worldState, toX, toY)) {
    return false;
  }

  for (const gate of gates) {
    if (gate.open) {
      continue;
    }
    const crossesClosedGate =
      (gate.a.x === fromX && gate.a.y === fromY && gate.b.x === toX && gate.b.y === toY)
      || (gate.b.x === fromX && gate.b.y === fromY && gate.a.x === toX && gate.a.y === toY);
    if (crossesClosedGate) {
      return false;
    }
  }
  return true;
}

function isWalkableTile(worldState: WorldInit, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= worldState.width || y >= worldState.height) {
    return false;
  }
  const row = worldState.tiles[y];
  return typeof row === 'string' && row[x] === '.';
}

function sectorAt(worldState: WorldInit, state: Snapshot, x: number, y: number) {
  const col = Math.floor(x / worldState.sectorSize);
  const row = Math.floor(y / worldState.sectorSize);
  const id = row * worldState.side + col;
  return state.sectors[id] ?? null;
}

function circle(x: number, y: number, radius: number, color: string, fill = true): void {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  if (fill) {
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawCenteredText(text: string, color: string): void {
  ctx.fillStyle = color;
  ctx.font = '20px monospace';
  const width = ctx.measureText(text).width;
  ctx.fillText(text, (canvas.width - width) / 2, canvas.height / 2);
}

function pushLog(line: string): void {
  logs.push(line);
  if (logs.length > 32) {
    logs = logs.slice(logs.length - 32);
  }
}

function send(message: ClientMessage): void {
  if (!ws || ws.readyState !== ws.OPEN) {
    return;
  }
  ws.send(JSON.stringify(message));
}

function resize(): void {
  const hudWidth = window.innerWidth > 1080 ? 330 : 0;
  canvas.width = window.innerWidth - hudWidth;
  canvas.height = window.innerHeight;
}

function dotKey(x: number, y: number): string {
  return `${x},${y}`;
}

function mustElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`missing element: ${id}`);
  }
  return element as T;
}

function mustCanvasContext(target: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = target.getContext('2d');
  if (!context) {
    throw new Error('canvas context not available');
  }
  return context;
}

function formatMs(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const mm = Math.floor(sec / 60)
    .toString()
    .padStart(2, '0');
  const ss = Math.floor(sec % 60)
    .toString()
    .padStart(2, '0');
  return `${mm}:${ss}`;
}

function playerNameById(playerId: string): string {
  const found = snapshot?.players.find((player) => player.id === playerId);
  return found?.name ?? playerId.slice(0, 5);
}

function fruitLabel(type: FruitView['type']): string {
  if (type === 'cherry') {
    return 'チェリー';
  }
  if (type === 'strawberry') {
    return 'ストロベリー';
  }
  if (type === 'orange') {
    return 'オレンジ';
  }
  if (type === 'apple') {
    return 'アップル';
  }
  if (type === 'key') {
    return 'キー';
  }
  return 'グレープ';
}

function pingKindLabel(kind: PingType): string {
  if (kind === 'focus') {
    return '注目';
  }
  if (kind === 'danger') {
    return '危険';
  }
  if (kind === 'help') {
    return '救助';
  }
  return kind;
}

function pingKindColor(kind: PingType): { r: number; g: number; b: number } {
  if (kind === 'focus') {
    return { r: 104, g: 215, b: 255 };
  }
  if (kind === 'danger') {
    return { r: 255, g: 124, b: 124 };
  }
  if (kind === 'help') {
    return { r: 146, g: 255, b: 170 };
  }
  return { r: 218, g: 222, b: 233 };
}

function fruitColor(type: FruitView['type']): string {
  if (type === 'cherry') {
    return '#ff4f7b';
  }
  if (type === 'strawberry') {
    return '#ff3366';
  }
  if (type === 'orange') {
    return '#ff9a3d';
  }
  if (type === 'apple') {
    return '#9ff16f';
  }
  if (type === 'key') {
    return '#ffd86f';
  }
  return '#9b7dff';
}

function ghostColor(type: GhostView['type']): string {
  if (type === 'random') {
    return '#ef556b';
  }
  if (type === 'chaser') {
    return '#ff7ec0';
  }
  if (type === 'patrol') {
    return '#6fd9ff';
  }
  if (type === 'pincer') {
    return '#ffac6f';
  }
  if (type === 'invader') {
    return '#9c62ff';
  }
  return '#121212';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeNumber(input: string | null, fallback: number, min: number, max: number): number {
  const n = Number(input ?? '');
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return clampNumber(Math.floor(n), min, max);
}

function isTypingInFormElement(target: EventTarget | null): boolean {
  const candidates = [document.activeElement, target instanceof HTMLElement ? target : null];
  return candidates.some((candidate) => {
    if (!(candidate instanceof HTMLElement)) {
      return false;
    }
    if (candidate.isContentEditable) {
      return true;
    }
    const tag = candidate.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  });
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
