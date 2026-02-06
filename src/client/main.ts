import type {
  ClientMessage,
  Difficulty,
  FruitView,
  GameConfig,
  GameSummary,
  GhostView,
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
const ctx = mustCanvasContext(canvas);

const dotSet = new Set<string>();
const pelletMap = new Map<string, { x: number; y: number; active: boolean }>();

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let reconnectToken = localStorage.getItem('mmo-packman-token') ?? '';
let playerName = localStorage.getItem('mmo-packman-name') ?? `Player-${Math.floor(Math.random() * 1000)}`;
let meId = '';
let isHost = false;
let world: WorldInit | null = null;
let config: GameConfig | null = null;
let snapshot: Snapshot | null = null;
let summary: GameSummary | null = null;
let lobbyMessage = '';
let logs: string[] = [];
let currentDir: 'up' | 'down' | 'left' | 'right' | 'none' = 'none';

start();

function start(): void {
  resize();
  connect();
  wireKeyboard();
  wireTouchControls();
  window.addEventListener('resize', resize);
  requestAnimationFrame(renderFrame);
}

function connect(): void {
  const url = wsUrl();
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    const hello: ClientMessage = {
      type: 'hello',
      name: playerName,
      reconnectToken: reconnectToken || undefined,
    };
    send(hello);
  });

  ws.addEventListener('message', (event) => {
    const msg = safeParse(event.data.toString());
    if (!msg) {
      return;
    }
    handleServerMessage(msg);
  });

  ws.addEventListener('close', () => {
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
    }
    reconnectTimer = window.setTimeout(() => {
      connect();
    }, 1500);
  });
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
    meId = message.playerId;
    isHost = message.isHost;
    reconnectToken = message.reconnectToken;
    localStorage.setItem('mmo-packman-token', reconnectToken);
    return;
  }

  if (message.type === 'lobby') {
    isHost = message.hostId === meId;
    lobbyMessage = message.note ?? '';
    renderLobby(message.players, message.running);
    return;
  }

  if (message.type === 'game_init') {
    meId = message.meId;
    world = message.world;
    config = message.config;
    summary = null;
    logs = [];
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
    return;
  }

  if (message.type === 'state') {
    snapshot = message.snapshot;
    for (const event of message.snapshot.events) {
      applyEvent(event);
    }
    updateHud();
    return;
  }

  if (message.type === 'game_over') {
    summary = message.summary;
    showResult();
    return;
  }

  if (message.type === 'error') {
    pushLog(`ERROR: ${message.message}`);
  }
}

function applyEvent(event: RuntimeEvent): void {
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
    pushLog(`ボスにヒット (${event.hp}/3)`);
  } else if (event.type === 'toast') {
    pushLog(event.message);
  }
}

function renderLobby(players: Array<{ id: string; name: string; connected: boolean; ai: boolean; isHost: boolean }>, running: boolean): void {
  lobby.classList.remove('hidden');

  const difficultyOptions: Array<{ value: Difficulty; label: string }> = [
    { value: 'casual', label: 'Casual' },
    { value: 'normal', label: 'Normal' },
    { value: 'hard', label: 'Hard' },
    { value: 'nightmare', label: 'Nightmare' },
  ];

  lobby.innerHTML = `
    <div class="panel">
      <h1>MMO Packman Prototype</h1>
      <p class="muted">サーバー権威 / 20Hz / 協力攻略</p>
      <label>名前
        <input id="name-input" value="${escapeHtml(playerName)}" maxlength="16" />
      </label>
      <label>難易度
        <select id="difficulty-select">
          ${difficultyOptions.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}
        </select>
      </label>
      <button id="save-name">名前を保存</button>
      <button id="start-game" ${isHost && !running ? '' : 'disabled'}>${running ? '進行中' : 'ゲーム開始'}</button>
      <p class="muted">${lobbyMessage || 'Host が開始します。進行中は再接続のみ可能。'}</p>
      <h2>ロビー (${players.length})</h2>
      <ul>
        ${players
          .map(
            (p) => `<li>${p.name} ${p.isHost ? '👑' : ''} ${p.connected ? '' : '(切断)'} ${p.ai ? '[AI]' : ''}</li>`,
          )
          .join('')}
      </ul>
      <p class="hint">操作: 方向キー/WASD で移動, Space/E で覚醒</p>
    </div>
  `;

  const saveName = document.getElementById('save-name');
  const startButton = document.getElementById('start-game');

  saveName?.addEventListener('click', () => {
    const input = document.getElementById('name-input') as HTMLInputElement | null;
    if (!input) {
      return;
    }
    playerName = input.value.trim().slice(0, 16) || playerName;
    localStorage.setItem('mmo-packman-name', playerName);
    send({ type: 'hello', name: playerName, reconnectToken: reconnectToken || undefined });
  });

  startButton?.addEventListener('click', () => {
    const select = document.getElementById('difficulty-select') as HTMLSelectElement | null;
    const difficulty = (select?.value as Difficulty) ?? 'normal';
    send({ type: 'lobby_start', difficulty });
  });
}

function showResult(): void {
  if (!summary) {
    return;
  }

  result.classList.remove('hidden');
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
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
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

  touchControls.classList.remove('hidden');

  touchControls.addEventListener('click', (event) => {
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

  hud.innerHTML = `
    <div class="panel small">
      <h3>HUD</h3>
      <p>制覇率: ${(snapshot.captureRatio * 100).toFixed(1)}%</p>
      <p>残り時間: ${formatMs(snapshot.timeLeftMs)}</p>
      <p>ゴースト: ${ghosts} / フルーツ: ${fruits}</p>
      <p>ダウン: ${downCount}</p>
      ${
        me
          ? `<p>自分: ${escapeHtml(me.name)} | score ${me.score}</p>
      <p>状態: ${me.state} | 覚醒 ${'★'.repeat(me.stocks)}${'☆'.repeat(Math.max(0, 3 - me.stocks))}</p>
      <p>ゲージ: ${me.gauge}/${me.gaugeMax}</p>`
          : '<p>自分の情報なし</p>'
      }
      <h4>イベント</h4>
      <ul>${logs.slice(-8).map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
    </div>
  `;
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

  const me = snapshot.players.find((player) => player.id === meId);
  const centerX = me ? me.x + 0.5 : world.width / 2;
  const centerY = me ? me.y + 0.5 : world.height / 2;

  const tileSize = Math.max(12, Math.min(30, Math.floor(Math.min(canvas.width, canvas.height) / 26)));
  const originX = Math.floor(canvas.width / 2 - centerX * tileSize);
  const originY = Math.floor(canvas.height / 2 - centerY * tileSize);

  const visibleCols = Math.ceil(canvas.width / tileSize) + 4;
  const visibleRows = Math.ceil(canvas.height / tileSize) + 4;
  const minX = Math.max(0, Math.floor(centerX - visibleCols / 2));
  const minY = Math.max(0, Math.floor(centerY - visibleRows / 2));
  const maxX = Math.min(world.width - 1, Math.ceil(centerX + visibleCols / 2));
  const maxY = Math.min(world.height - 1, Math.ceil(centerY + visibleRows / 2));

  for (let y = minY; y <= maxY; y += 1) {
    const row = world.tiles[y];
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

  // dots
  ctx.fillStyle = '#ffd66a';
  for (const key of dotSet) {
    const [x, y] = key.split(',').map(Number);
    if (x < minX || x > maxX || y < minY || y > maxY) {
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

  // power pellets
  for (const pellet of pelletMap.values()) {
    if (!pellet.active) {
      continue;
    }
    if (pellet.x < minX || pellet.x > maxX || pellet.y < minY || pellet.y > maxY) {
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
  drawPlayers(snapshot.players, world, snapshot, originX, originY, tileSize, minX, minY, maxX, maxY);
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
): void {
  for (const ghost of ghosts) {
    if (ghost.x < minX || ghost.x > maxX || ghost.y < minY || ghost.y > maxY) {
      continue;
    }
    const sector = sectorAt(worldState, state, ghost.x, ghost.y);
    if (!sector?.discovered) {
      continue;
    }

    const sx = originX + ghost.x * tileSize + tileSize / 2;
    const sy = originY + ghost.y * tileSize + tileSize / 2;
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
): void {
  for (const player of players) {
    if (player.x < minX || player.x > maxX || player.y < minY || player.y > maxY) {
      continue;
    }
    const sector = sectorAt(worldState, state, player.x, player.y);
    if (!sector?.discovered) {
      continue;
    }

    const sx = originX + player.x * tileSize + tileSize / 2;
    const sy = originY + player.y * tileSize + tileSize / 2;
    const base = player.id === meId ? '#ffef8f' : '#f5b264';
    const color = player.state === 'down' ? 'rgba(189, 68, 68, 0.55)' : base;
    circle(sx, sy, Math.max(4, tileSize * 0.36), color);

    if (player.state === 'power') {
      circle(sx, sy, Math.max(6, tileSize * 0.48), 'rgba(88, 213, 255, 0.25)', false);
    }

    ctx.fillStyle = '#f7f9ff';
    ctx.font = `${Math.max(9, Math.floor(tileSize * 0.36))}px monospace`;
    ctx.fillText(player.name.slice(0, 7), sx - tileSize * 0.45, sy - tileSize * 0.45);
  }
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
