import type {
  ClientMessage,
  Difficulty,
  LobbyPlayer,
} from '../shared/types.js';
import {
  currentFollowName,
  escapeHtml,
  formatMs,
  normalizeNumber,
  resolveFocusPlayer,
} from './state.js';
import type { ClientState } from './state.js';

export interface UiElements {
  hud: HTMLElement;
  lobby: HTMLElement;
  result: HTMLElement;
  touchControls: HTMLElement;
  topStatus: HTMLElement;
  spectatorControls: HTMLElement;
}

export interface UiCallbacks {
  onSendInput: (message: ClientMessage) => void;
  onSendHello: () => void;
  onStartGame: (difficulty: Difficulty, aiPlayerCount: number, timeLimitMinutes: number) => void;
  onCycleSpectator: (delta: number) => void;
}

export class UiController {
  public constructor(
    private readonly elements: UiElements,
    private readonly callbacks: UiCallbacks,
  ) {}

  public init(state: ClientState): void {
    this.wireKeyboard(state);
    this.wireTouchControls(state);
    this.initSpectatorControls();
  }

  public hideLobby(): void {
    this.elements.lobby.classList.add('hidden');
  }

  public hideResult(): void {
    this.elements.result.classList.add('hidden');
  }

  public renderLobby(
    state: ClientState,
    players: LobbyPlayer[],
    running: boolean,
    canStart: boolean,
    spectatorCount: number,
  ): void {
    this.elements.lobby.classList.remove('hidden');

    const difficultyOptions: Array<{ value: Difficulty; label: string }> = [
      { value: 'casual', label: 'Casual' },
      { value: 'normal', label: 'Normal' },
      { value: 'hard', label: 'Hard' },
      { value: 'nightmare', label: 'Nightmare' },
    ];

    const activePlayers = players.filter((p) => !p.spectator).length;

    this.elements.lobby.innerHTML = `
      <div class="panel">
        <h1>MMO Packman Prototype</h1>
        <p class="muted">AI-onlyテスト対応 / 観戦モード対応</p>

        <label>名前
          <input id="name-input" value="${escapeHtml(state.playerName)}" maxlength="16" />
        </label>

        <label>参加モード
          <select id="mode-select">
            <option value="player" ${state.preferSpectator ? '' : 'selected'}>プレイヤー</option>
            <option value="spectator" ${state.preferSpectator ? 'selected' : ''}>観戦</option>
          </select>
        </label>

        <label>難易度
          <select id="difficulty-select">
            ${difficultyOptions.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}
          </select>
        </label>

        <label>AIプレイヤー数（0-100）
          <input id="ai-count" type="number" min="0" max="100" value="${state.requestedAiCount}" />
        </label>

        <label>テスト時間（分, 1-10）
          <input id="test-minutes" type="number" min="1" max="10" value="${state.requestedTestMinutes}" />
        </label>

        <button id="save-profile">設定を保存</button>
        <button id="start-game" ${state.isHost && canStart && !running ? '' : 'disabled'}>${running ? '進行中' : 'テスト開始'}</button>
        <p class="muted">${state.lobbyMessage || 'Host が開始します。観戦者は進行中でも接続可能です。'}</p>

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

      state.playerName = nameInput?.value.trim().slice(0, 16) || state.playerName;
      state.preferSpectator = modeSelect?.value === 'spectator';
      state.requestedAiCount = normalizeNumber(aiInput?.value ?? '', state.requestedAiCount, 0, 100);
      state.requestedTestMinutes = normalizeNumber(minutesInput?.value ?? '', state.requestedTestMinutes, 1, 10);

      localStorage.setItem('mmo-packman-name', state.playerName);
      localStorage.setItem('mmo-packman-spectator', state.preferSpectator ? '1' : '0');
      localStorage.setItem('mmo-packman-ai-count', String(state.requestedAiCount));
      localStorage.setItem('mmo-packman-test-minutes', String(state.requestedTestMinutes));

      this.callbacks.onSendHello();
    });

    startButton?.addEventListener('click', () => {
      const select = document.getElementById('difficulty-select') as HTMLSelectElement | null;
      const aiInput = document.getElementById('ai-count') as HTMLInputElement | null;
      const minutesInput = document.getElementById('test-minutes') as HTMLInputElement | null;

      const difficulty = (select?.value as Difficulty) ?? 'normal';
      state.requestedAiCount = normalizeNumber(aiInput?.value ?? '', state.requestedAiCount, 0, 100);
      state.requestedTestMinutes = normalizeNumber(minutesInput?.value ?? '', state.requestedTestMinutes, 1, 10);

      localStorage.setItem('mmo-packman-ai-count', String(state.requestedAiCount));
      localStorage.setItem('mmo-packman-test-minutes', String(state.requestedTestMinutes));

      this.callbacks.onStartGame(difficulty, state.requestedAiCount, state.requestedTestMinutes);
    });
  }

  public showResult(state: ClientState): void {
    if (!state.summary) {
      return;
    }

    this.elements.result.classList.remove('hidden');
    const ranking = state.summary.ranking
      .slice(0, 8)
      .map((entry, index) => {
        return `<li>${index + 1}. ${escapeHtml(entry.name)} - ${entry.score}pt (dot:${entry.dots}, ghost:${entry.ghosts}, rescue:${entry.rescues})</li>`;
      })
      .join('');

    this.elements.result.innerHTML = `
      <div class="panel">
        <h2>ゲーム終了: ${state.summary.reason}</h2>
        <p>制覇率: ${(state.summary.captureRatio * 100).toFixed(1)}%</p>
        <h3>ランキング</h3>
        <ol>${ranking}</ol>
        <h3>タイムライン</h3>
        <ul>${state.summary.timeline.slice(-12).map((t) => `<li>${formatMs(t.atMs)} ${escapeHtml(t.label)}</li>`).join('')}</ul>
        <button id="close-result">閉じる</button>
      </div>
    `;

    const close = document.getElementById('close-result');
    close?.addEventListener('click', () => {
      this.elements.result.classList.add('hidden');
    });
  }

  public updateTouchControlsVisibility(state: ClientState): void {
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (!isTouch || state.isSpectator) {
      this.elements.touchControls.classList.add('hidden');
    } else {
      this.elements.touchControls.classList.remove('hidden');
    }
  }

  public updateStatusPanels(state: ClientState): void {
    if (!this.elements.lobby.classList.contains('hidden')) {
      this.elements.topStatus.classList.add('hidden');
      this.elements.spectatorControls.classList.add('hidden');
      return;
    }
    this.updateTopStatus(state);
    this.updateSpectatorControls(state);
  }

  public updateHud(state: ClientState): void {
    if (!state.snapshot || !state.world) {
      this.elements.hud.innerHTML = '<div class="panel small">接続待機中...</div>';
      return;
    }

    const me = state.snapshot.players.find((player) => player.id === state.meId);
    const downCount = state.snapshot.players.filter((player) => player.state === 'down').length;
    const ghosts = state.snapshot.ghosts.length;
    const fruits = state.snapshot.fruits.length;
    const modeText = state.isSpectator ? '観戦' : 'プレイ';

    const meLine = state.isSpectator
      ? `<p>mode: ${modeText} | follow: ${escapeHtml(currentFollowName(state))}</p>`
      : me
        ? `<p>mode: ${modeText}</p><p>自分: ${escapeHtml(me.name)} | score ${me.score} | 状態: ${me.state}</p>`
        : '<p>自分の情報なし</p>';

    this.elements.hud.innerHTML = `
      <div class="panel small">
        <h3>HUD</h3>
        <p>制覇率: ${(state.snapshot.captureRatio * 100).toFixed(1)}%</p>
        <p>残り時間: ${formatMs(state.snapshot.timeLeftMs)}</p>
        <p>ゴースト: ${ghosts} / フルーツ: ${fruits}</p>
        <p>ダウン: ${downCount}</p>
        ${meLine}
        <h4>イベント</h4>
        <ul>${state.logs.slice(-8).map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
      </div>
    `;
  }

  private wireKeyboard(state: ClientState): void {
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

      if (state.isSpectator) {
        if (rawKey === 'Tab' || rawKey === ']' || key === 'e') {
          event.preventDefault();
          this.callbacks.onCycleSpectator(1);
        } else if (rawKey === '[' || key === 'q') {
          event.preventDefault();
          this.callbacks.onCycleSpectator(-1);
        }
        return;
      }

      const dir = dirMap[key];
      if (dir && dir !== state.currentDir) {
        state.currentDir = dir;
        this.callbacks.onSendInput({ type: 'input', dir });
      }

      if (key === ' ' || key === 'e' || key === 'Enter') {
        this.callbacks.onSendInput({ type: 'input', awaken: true });
      }
    });

    window.addEventListener('keyup', (event) => {
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (key in dirMap) {
        state.currentDir = 'none';
      }
    });
  }

  private wireTouchControls(state: ClientState): void {
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (!isTouch) {
      return;
    }

    this.elements.touchControls.addEventListener('click', (event) => {
      if (state.isSpectator) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }

      const dir = target.getAttribute('data-dir') as 'up' | 'down' | 'left' | 'right' | null;
      if (dir) {
        this.callbacks.onSendInput({ type: 'input', dir });
        return;
      }

      const action = target.getAttribute('data-action');
      if (action === 'awaken') {
        this.callbacks.onSendInput({ type: 'input', awaken: true });
      }
    });

    this.updateTouchControlsVisibility(state);
  }

  private initSpectatorControls(): void {
    this.elements.spectatorControls.innerHTML = `
      <div class="spec-title">観戦ターゲット</div>
      <div class="spec-row">
        <button id="spectator-prev" type="button">◀</button>
        <span id="spectator-target">auto</span>
        <button id="spectator-next" type="button">▶</button>
      </div>
      <div class="hint">Tab / ] / E: 次, [ / Q: 前</div>
    `;

    const prev = document.getElementById('spectator-prev');
    const next = document.getElementById('spectator-next');
    prev?.addEventListener('click', () => this.callbacks.onCycleSpectator(-1));
    next?.addEventListener('click', () => this.callbacks.onCycleSpectator(1));
  }

  private updateTopStatus(state: ClientState): void {
    if (!state.snapshot) {
      this.elements.topStatus.classList.add('hidden');
      return;
    }

    const focus = resolveFocusPlayer(state);
    if (!focus) {
      this.elements.topStatus.classList.add('hidden');
      return;
    }

    const ratio = focus.gaugeMax > 0 ? (focus.gauge / focus.gaugeMax) * 100 : 0;
    const safeStocks = Math.max(0, Math.min(20, Math.floor(focus.stocks)));
    const title = state.isSpectator ? `観戦: ${escapeHtml(focus.name)}` : `覚醒: ${escapeHtml(focus.name)}`;
    this.elements.topStatus.innerHTML = `
      <div class="status-title">${title}</div>
      <div class="stock-line">Stock ${'★'.repeat(safeStocks)}${'☆'.repeat(Math.max(0, 3 - safeStocks))}</div>
      <div class="gauge-wrap"><div class="gauge-fill" style="width:${ratio.toFixed(1)}%"></div></div>
      <div class="gauge-text">${focus.gauge}/${focus.gaugeMax}</div>
    `;
    this.elements.topStatus.classList.remove('hidden');
  }

  private updateSpectatorControls(state: ClientState): void {
    if (!state.isSpectator || !state.snapshot) {
      this.elements.spectatorControls.classList.add('hidden');
      return;
    }

    resolveFocusPlayer(state);
    this.elements.spectatorControls.classList.remove('hidden');
    const targetText = document.getElementById('spectator-target');
    if (targetText) {
      targetText.textContent = currentFollowName(state);
    }
  }
}
