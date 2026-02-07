import type {
  AwardEntry,
  ClientMessage,
  Difficulty,
  FruitView,
  GameConfig,
  GameSummary,
  GhostView,
  LobbyPlayer,
  PlayerView,
  RuntimeEvent,
  ServerMessage,
  Snapshot,
  WorldInit,
} from '../shared/types.js';

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
}

type SpectatorCameraMode = 'follow' | 'free';

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let reconnectToken = localStorage.getItem('mmo-packman-token') ?? '';
let playerName = localStorage.getItem('mmo-packman-name') ?? `Player-${Math.floor(Math.random() * 1000)}`;
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
let currentDir: 'up' | 'down' | 'left' | 'right' | 'none' = 'none';
let followPlayerId: string | null = null;
let spectatorCameraMode: SpectatorCameraMode = 'follow';
let spectatorZoom = 1;
let freeCameraCenter: { x: number; y: number } | null = null;
let spectatorMinimapCanvas: HTMLCanvasElement | null = null;
let spectatorMinimapCtx: CanvasRenderingContext2D | null = null;
let latestSnapshotReceivedAtMs = performance.now();
const playerInterpolation = new Map<string, InterpolationState>();
const ghostInterpolation = new Map<string, InterpolationState>();

start();

function start(): void {
  resize();
  connect();
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
  };
  send(hello);
}

function wsUrl(): string {
  const env = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env.VITE_WS_URL;
  if (env) {
    return env;
  }

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const port = window.location.port === '5173' ? '8080' : window.location.port;
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
    renderLobby(message.players, message.running, message.canStart, message.spectatorCount);
    updateStatusPanels();
    return;
  }

  if (message.type === 'game_init') {
    meId = message.meId;
    world = message.world;
    config = message.config;
    currentDir = 'none';
    isSpectator = message.isSpectator;
    summary = null;
    snapshot = null;
    logs = [];
    followPlayerId = null;
    spectatorCameraMode = 'follow';
    spectatorZoom = 1;
    freeCameraCenter = null;
    playerInterpolation.clear();
    ghostInterpolation.clear();
    latestSnapshotReceivedAtMs = performance.now();
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
    const previousSnapshot = snapshot;
    snapshot = message.snapshot;
    playAwakenTransitions(previousSnapshot, message.snapshot);
    updateInterpolationStates(message.snapshot);
    for (const event of message.snapshot.events) {
      applyEvent(event);
    }
    updateHud();
    updateStatusPanels();
    return;
  }

  if (message.type === 'game_over') {
    summary = normalizeSummary(message.summary);
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

      <p class="hint">AI-onlyテスト: 観戦モード + AI人数(2/5など) で開始</p>
      <p class="hint">プレイヤー操作: 方向キー/WASD, 覚醒: Space/E/Enter</p>
    </div>
  `;

  const saveProfile = document.getElementById('save-profile');
  const startButton = document.getElementById('start-game');

  saveProfile?.addEventListener('click', () => {
    const nameInput = document.getElementById('name-input') as HTMLInputElement | null;
    const modeSelect = document.getElementById('mode-select') as HTMLSelectElement | null;
    const aiInput = document.getElementById('ai-count') as HTMLInputElement | null;
    const minutesInput = document.getElementById('test-minutes') as HTMLInputElement | null;

    playerName = nameInput?.value.trim().slice(0, 16) || playerName;
    preferSpectator = modeSelect?.value === 'spectator';
    requestedAiCount = normalizeNumber(aiInput?.value ?? '', requestedAiCount, 0, 100);
    requestedTestMinutes = normalizeNumber(minutesInput?.value ?? '', requestedTestMinutes, 1, 10);

    localStorage.setItem('mmo-packman-name', playerName);
    localStorage.setItem('mmo-packman-spectator', preferSpectator ? '1' : '0');
    localStorage.setItem('mmo-packman-ai-count', String(requestedAiCount));
    localStorage.setItem('mmo-packman-test-minutes', String(requestedTestMinutes));

    sendHello();
  });

  startButton?.addEventListener('click', () => {
    const select = document.getElementById('difficulty-select') as HTMLSelectElement | null;
    const aiInput = document.getElementById('ai-count') as HTMLInputElement | null;
    const minutesInput = document.getElementById('test-minutes') as HTMLInputElement | null;

    const difficulty = (select?.value as Difficulty) ?? 'normal';
    requestedAiCount = normalizeNumber(aiInput?.value ?? '', requestedAiCount, 0, 100);
    requestedTestMinutes = normalizeNumber(minutesInput?.value ?? '', requestedTestMinutes, 1, 10);

    localStorage.setItem('mmo-packman-ai-count', String(requestedAiCount));
    localStorage.setItem('mmo-packman-test-minutes', String(requestedTestMinutes));

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
      <button id="close-result">閉じる</button>
    </div>
  `;

  const close = document.getElementById('close-result');
  close?.addEventListener('click', () => {
    result.classList.add('hidden');
  });
}

function normalizeSummary(raw: GameSummary): GameSummary {
  return {
    ...raw,
    awards: raw.awards ?? [],
  };
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

  window.addEventListener('keydown', (event) => {
    const rawKey = event.key;
    const key = rawKey.length === 1 ? rawKey.toLowerCase() : rawKey;
    const typingInForm = isTypingInFormElement(event.target);

    if (isSpectator) {
      if (typingInForm) {
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

    const dir = dirMap[key];
    if (dir && dir !== currentDir) {
      currentDir = dir;
      send({ type: 'input', dir });
    }

    if (key === ' ' || key === 'e' || key === 'Enter') {
      send({ type: 'input', awaken: true });
    }
  });

  window.addEventListener('keyup', (event) => {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key in dirMap) {
      currentDir = 'none';
    }
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
    <div class="spec-title">観戦ターゲット</div>
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
    <canvas id="spectator-minimap" width="220" height="220"></canvas>
    <div class="hint">Tab / ] / E: 次, [ / Q: 前, WASD/矢印: パン, +/-: ズーム</div>
    <div class="hint">ミニマップをクリックでフォーカス切替/自由カメラ移動</div>
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
  if (!isSpectator || !spectatorMinimapCanvas || !spectatorMinimapCtx) {
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

  for (const sector of state.sectors) {
    const x = sector.x * mapScaleX;
    const y = sector.y * mapScaleY;
    const width = Math.max(1, sector.size * mapScaleX);
    const height = Math.max(1, sector.size * mapScaleY);
    if (!sector.discovered) {
      miniCtx.fillStyle = '#090b12';
    } else if (sector.captured) {
      miniCtx.fillStyle = '#184b66';
    } else {
      miniCtx.fillStyle = '#13213b';
    }
    miniCtx.fillRect(x, y, width, height);
  }

  for (const player of state.players) {
    const px = (player.x + 0.5) * mapScaleX;
    const py = (player.y + 0.5) * mapScaleY;
    miniCtx.beginPath();
    miniCtx.arc(px, py, 3.2, 0, Math.PI * 2);
    miniCtx.fillStyle = player.id === followPlayerId ? '#ffe784' : '#ffb36c';
    miniCtx.fill();
    if (player.id === followPlayerId) {
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
  if (!isSpectator || !snapshot) {
    spectatorControls.classList.add('hidden');
    return;
  }

  spectatorControls.classList.remove('hidden');
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

  hud.innerHTML = `
    <div class="panel small">
      <h3>HUD</h3>
      <p>制覇率: ${(snapshot.captureRatio * 100).toFixed(1)}%</p>
      <p>残り時間: ${formatMs(snapshot.timeLeftMs)}</p>
      <p>ゴースト: ${ghosts} / フルーツ: ${fruits}</p>
      <p>ダウン: ${downCount}</p>
      ${meLine}
      <h4>イベント</h4>
      <ul>${logs.slice(-8).map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
    </div>
  `;
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
  draw();
}

function draw(): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#07090f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!world || !snapshot) {
    drawCenteredText('サーバー接続中...', '#f5f7ff');
    return;
  }

  const camera = resolveCameraCenter(world, snapshot);
  const centerX = camera.x;
  const centerY = camera.y;
  const interpolationAlpha = getInterpolationAlpha();

  const baseTileSize = Math.floor(Math.min(canvas.width, canvas.height) / 26);
  const tileSize = isSpectator
    ? clampNumber(Math.floor(baseTileSize * spectatorZoom), 10, 54)
    : Math.max(12, Math.min(30, baseTileSize));
  const originX = Math.floor(canvas.width / 2 - centerX * tileSize);
  const originY = Math.floor(canvas.height / 2 - centerY * tileSize);

  const visibleCols = Math.ceil(canvas.width / tileSize) + 4;
  const visibleRows = Math.ceil(canvas.height / tileSize) + 4;
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
        ctx.fillStyle = discovered ? '#2d4a8a' : '#0d0f17';
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
  drawGhosts(snapshot.ghosts, world, snapshot, originX, originY, tileSize, minX, minY, maxX, maxY, interpolationAlpha);
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
    interpolationAlpha,
  );
  drawSpectatorMinimap(world, snapshot, minX, minY, maxX, maxY);
}

function resolveCameraCenter(worldState: WorldInit, state: Snapshot): { x: number; y: number } {
  if (isSpectator && spectatorCameraMode === 'free' && freeCameraCenter) {
    return clampCameraCenter(worldState, freeCameraCenter.x, freeCameraCenter.y);
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
  return members.find((player) => player.id === followPlayerId) ?? null;
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
      circle(sx, sy, Math.max(3, tileSize * 0.16), '#ffcb6b');
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
  interpolationAlpha: number,
): void {
  for (const ghost of ghosts) {
    const renderPos = getInterpolatedPosition(ghost.id, ghost.x, ghost.y, ghostInterpolation, interpolationAlpha);
    if (renderPos.x < minX || renderPos.x > maxX || renderPos.y < minY || renderPos.y > maxY) {
      continue;
    }
    const sector = sectorAt(worldState, state, Math.floor(renderPos.x), Math.floor(renderPos.y));
    if (!sector?.discovered) {
      continue;
    }

    const sx = originX + renderPos.x * tileSize + tileSize / 2;
    const sy = originY + renderPos.y * tileSize + tileSize / 2;
    circle(sx, sy, Math.max(4, tileSize * 0.34), ghostColor(ghost.type));

    if (ghost.type === 'boss') {
      ctx.fillStyle = '#ffffff';
      ctx.font = `${Math.max(10, Math.floor(tileSize * 0.4))}px monospace`;
      ctx.fillText(`${ghost.hp}`, sx - tileSize * 0.1, sy - tileSize * 0.45);
    }
  }
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
  interpolationAlpha: number,
): void {
  for (const player of players) {
    const renderPos = getInterpolatedPosition(player.id, player.x, player.y, playerInterpolation, interpolationAlpha);
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
      drawPowerEffect(sx, sy, tileSize, nowMs, player.id === meId);
    }

    ctx.fillStyle = '#f7f9ff';
    ctx.font = `${Math.max(9, Math.floor(tileSize * 0.36))}px monospace`;
    ctx.fillText(player.name.slice(0, 7), sx - tileSize * 0.45, sy - tileSize * 0.45);
  }
}

function drawPowerEffect(x: number, y: number, tileSize: number, nowMs: number, isMe: boolean): void {
  const base = tileSize * 0.52;
  const phase = (nowMs % 1200) / 1200;

  for (let ring = 0; ring < 3; ring += 1) {
    const p = (phase + ring * 0.22) % 1;
    const radius = base + tileSize * (0.18 + p * 0.75);
    const alpha = (1 - p) * (isMe ? 0.52 : 0.42);
    circle(x, y, radius, `rgba(95, 238, 255, ${alpha.toFixed(3)})`, false);
  }

  circle(x, y, base * 1.18, `rgba(82, 175, 255, ${isMe ? '0.26' : '0.18'})`);

  const sparks = 8;
  for (let i = 0; i < sparks; i += 1) {
    const angle = ((Math.PI * 2) / sparks) * i + phase * Math.PI * 2;
    const rr = base * (1.2 + ((i % 2 === 0 ? phase : 1 - phase) * 0.7));
    const sx = x + Math.cos(angle) * rr;
    const sy = y + Math.sin(angle) * rr;
    circle(sx, sy, Math.max(1.8, tileSize * 0.07), 'rgba(165, 249, 255, 0.88)');
  }
}

function updateInterpolationStates(nextSnapshot: Snapshot): void {
  const nowMs = performance.now();
  latestSnapshotReceivedAtMs = nowMs;

  updateEntityInterpolationMap(
    playerInterpolation,
    nextSnapshot.players.map((player) => ({ id: player.id, x: player.x, y: player.y })),
    nowMs,
    3,
  );
  updateEntityInterpolationMap(
    ghostInterpolation,
    nextSnapshot.ghosts.map((ghost) => ({ id: ghost.id, x: ghost.x, y: ghost.y })),
    nowMs,
    4,
  );
}

function updateEntityInterpolationMap(
  map: Map<string, InterpolationState>,
  entities: Array<{ id: string; x: number; y: number }>,
  nowMs: number,
  teleportThreshold: number,
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
      });
      continue;
    }

    let fromX = previous.toX;
    let fromY = previous.toY;
    const jumpDistance = Math.abs(fromX - entity.x) + Math.abs(fromY - entity.y);
    if (jumpDistance > teleportThreshold) {
      fromX = entity.x;
      fromY = entity.y;
    }

    map.set(entity.id, {
      fromX,
      fromY,
      toX: entity.x,
      toY: entity.y,
      updatedAtMs: nowMs,
    });
  }

  for (const existingId of map.keys()) {
    if (!aliveIds.has(existingId)) {
      map.delete(existingId);
    }
  }
}

function getInterpolationAlpha(): number {
  const tickRate = config?.tickRate ?? 20;
  const frameMs = 1000 / Math.max(1, tickRate);
  const elapsedMs = performance.now() - latestSnapshotReceivedAtMs;
  return clampNumber(elapsedMs / frameMs, 0, 1);
}

function getInterpolatedPosition(
  entityId: string,
  currentX: number,
  currentY: number,
  map: Map<string, InterpolationState>,
  alpha: number,
): { x: number; y: number } {
  const item = map.get(entityId);
  if (!item) {
    return { x: currentX, y: currentY };
  }

  return {
    x: item.fromX + (item.toX - item.fromX) * alpha,
    y: item.fromY + (item.toY - item.fromY) * alpha,
  };
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
