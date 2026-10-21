'use strict';

// Minesweeper: the board, its timer, and the list of finished games.
//
// The board is drawn from this file into the screen in index.html. Games the
// viewer finishes are posted to /api/games; the list under the board is read
// from it. ?demo=1 (staging only) shows a board part-way through and made-up
// finished games, and keeps everything from that visit in the page alone.

(function () {
  const SIZES = {
    small: { label: 'Small', rows: 8, cols: 8, mines: 10 },
    medium: { label: 'Medium', rows: 12, cols: 8, mines: 18 },
    large: { label: 'Large', rows: 16, cols: 8, mines: 28 },
  };
  const PAGE_SIZE = 20;
  const DEMO = new URLSearchParams(location.search).get('demo') === '1';

  const ICON_FLAG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V4"/><path d="M6 4h12l-3 4 3 4H6"/></svg>';
  const ICON_MINE = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="5"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>';
  const ICON_WIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>';
  const BEST_SKELETON = '<span class="skeleton inline-block h-5 w-14 align-middle"></span>';

  // The board the ?demo=1 preview opens on: the mines, the squares already
  // opened and the three correct flags.
  const DEMO_MINES = [[0, 6], [1, 7], [2, 1], [2, 7], [3, 5], [4, 0], [5, 6], [6, 3], [7, 0], [7, 7]];
  const DEMO_OPENS = [[0, 2], [4, 3], [6, 6]];
  const DEMO_FLAGS = [[0, 6], [2, 1], [3, 5]];
  const DEMO_START_SECONDS = 134;

  const $ = (sel) => document.querySelector(sel);
  const els = {
    board: $('[data-board]'),
    sizePicker: $('[data-size-picker]'),
    mode: $('[data-mode]'),
    reveal: $('[data-mode-reveal]'),
    flag: $('[data-mode-flag]'),
    playAgain: $('[data-play-again]'),
    newGame: $('[data-new-game]'),
    minesLeft: $('[data-mines-left]'),
    time: $('[data-time]'),
    best: $('[data-best]'),
    status: $('[data-status]'),
    statusDot: $('[data-status-dot]'),
    statusText: $('[data-status-text]'),
    list: $('[data-list]'),
    listLoading: $('[data-list-loading]'),
    listEmpty: $('[data-list-empty]'),
    listError: $('[data-list-error]'),
    listRetry: $('[data-list-retry]'),
    showMore: $('[data-show-more]'),
    saveNote: $('[data-save-note]'),
    saveRetry: $('[data-save-retry]'),
    demoNote: $('[data-usernode-demo-note]'),
  };

  // ── Game state ────────────────────────────────────────────────────────────
  let sizeKey = 'small';
  let rows = 0;
  let cols = 0;
  let mineCount = 0;
  let grid = [];
  let cells = [];
  let phase = 'ready'; // ready | playing | won | lost
  let flags = 0;
  let revealedSafe = 0;
  let totalSafe = 0;
  let elapsedMs = 0;
  let startedAt = 0;
  let timerId = null;
  let mode = 'reveal';

  // ── List state ────────────────────────────────────────────────────────────
  let best = {};
  let games = [];
  let nextBefore = null;
  let listState = 'loading'; // loading | ready | error
  let isGuest = false;
  let pendingSave = null;

  // ── Helpers ───────────────────────────────────────────────────────────────
  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return pad(Math.floor(s / 60)) + ':' + pad(s % 60);
  }

  function formatWhen(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const now = window.usernode && window.usernode.now ? window.usernode.now() : new Date();
    const clock = d.getHours() + ':' + pad(d.getMinutes());
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Math.round((today - start) / 86400000);
    if (days === 0) return 'Today, ' + clock;
    if (days === 1) return 'Yesterday, ' + clock;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ', ' + clock;
  }

  function getToken() {
    const fromUrl = new URLSearchParams(location.search).get('token');
    if (fromUrl) return fromUrl;
    return (window.usernode && window.usernode.token) || '';
  }

  function api(path, options) {
    const opts = options || {};
    const headers = { 'content-type': 'application/json' };
    const token = getToken();
    if (token) headers['x-usernode-token'] = token;
    if (window.usernode && window.usernode.previewNow) {
      headers['x-usernode-now'] = window.usernode.now().toISOString();
    }
    const url = DEMO ? path + (path.indexOf('?') === -1 ? '?' : '&') + 'demo=1' : path;
    return fetch(url, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body,
      credentials: 'same-origin',
    }).then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  // ── Board ─────────────────────────────────────────────────────────────────
  function newGame(key) {
    sizeKey = key && SIZES[key] ? key : sizeKey;
    const spec = SIZES[sizeKey];
    rows = spec.rows;
    cols = spec.cols;
    mineCount = spec.mines;
    grid = [];
    cells = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      const rowOfButtons = [];
      for (let c = 0; c < cols; c++) {
        row.push({ mine: false, open: false, flagged: false, count: 0 });
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'c';
        btn.dataset.i = String(r * cols + c);
        rowOfButtons.push(btn);
      }
      grid.push(row);
      cells.push(rowOfButtons);
    }
    phase = 'ready';
    flags = 0;
    revealedSafe = 0;
    totalSafe = rows * cols - mineCount;
    elapsedMs = 0;
    startedAt = 0;
    stopTimer();
    setMode('reveal');
    setPickerLocked(false);
    buildBoard();
    renderStats();
    renderTime();
    renderStatus(safeLeftText(), '');
    renderModeControls();
    renderBoard();
  }

  function buildBoard() {
    const frag = document.createDocumentFragment();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) frag.appendChild(cells[r][c]);
    }
    els.board.replaceChildren(frag);
  }

  function placeMines(safeR, safeC) {
    const forbidden = new Set();
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const r = safeR + dr;
        const c = safeC + dc;
        if (r >= 0 && r < rows && c >= 0 && c < cols) forbidden.add(r * cols + c);
      }
    }
    const pool = [];
    for (let i = 0; i < rows * cols; i++) if (!forbidden.has(i)) pool.push(i);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = pool[i];
      pool[i] = pool[j];
      pool[j] = t;
    }
    for (let i = 0; i < mineCount && i < pool.length; i++) {
      const r = Math.floor(pool[i] / cols);
      const c = pool[i] % cols;
      grid[r][c].mine = true;
    }
    computeCounts();
  }

  function computeCounts() {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (grid[r][c].mine) continue;
        let n = 0;
        forEachNeighbour(r, c, (rr, cc) => {
          if (grid[rr][cc].mine) n++;
        });
        grid[r][c].count = n;
      }
    }
  }

  function forEachNeighbour(r, c, fn) {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const rr = r + dr;
        const cc = c + dc;
        if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) fn(rr, cc);
      }
    }
  }

  function squareLabel(r, c) {
    const cell = grid[r][c];
    const at = 'Row ' + (r + 1) + ', column ' + (c + 1) + ', ';
    if (phase === 'lost' && cell.mine && !cell.flagged) {
      return at + (cell.open ? 'the mine you hit' : 'mine');
    }
    if (cell.flagged) return at + 'flagged';
    if (cell.open) {
      if (cell.count === 0) return at + 'empty';
      return at + cell.count + (cell.count === 1 ? ' mine nearby' : ' mines nearby');
    }
    return at + 'covered';
  }

  function renderCell(r, c) {
    const cell = grid[r][c];
    const btn = cells[r][c];
    let cls = 'c';
    let html = '';
    if (phase === 'lost' && cell.mine && !cell.flagged) {
      cls += cell.open ? ' m hit' : ' m';
      html = ICON_MINE;
    } else if (cell.flagged) {
      cls += ' f';
      html = ICON_FLAG;
    } else if (cell.open) {
      if (cell.count > 0) {
        cls += ' n' + (cell.count > 1 ? ' n' + cell.count : '');
        html = String(cell.count);
      } else {
        cls += ' o';
      }
    }
    btn.className = cls;
    btn.innerHTML = html;
    btn.setAttribute('aria-label', squareLabel(r, c));
  }

  function renderBoard() {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) renderCell(r, c);
  }

  function safeLeftText() {
    return (totalSafe - revealedSafe) + ' of ' + totalSafe + ' safe squares left. Tap to reveal.';
  }

  // ── Playing ───────────────────────────────────────────────────────────────
  function reveal(r, c) {
    if (phase === 'won' || phase === 'lost') return;
    const first = grid[r][c];
    if (first.open || first.flagged) return;
    if (phase === 'ready') {
      placeMines(r, c);
      phase = 'playing';
      setPickerLocked(true);
      startTimer();
    }
    if (first.mine) {
      first.open = true;
      lose();
      return;
    }
    const stack = [[r, c]];
    while (stack.length) {
      const pair = stack.pop();
      const rr = pair[0];
      const cc = pair[1];
      const cell = grid[rr][cc];
      if (cell.open || cell.flagged || cell.mine) continue;
      cell.open = true;
      revealedSafe++;
      renderCell(rr, cc);
      if (cell.count === 0) {
        forEachNeighbour(rr, cc, (nr, nc) => {
          const n = grid[nr][nc];
          if (!n.open && !n.flagged) stack.push([nr, nc]);
        });
      }
    }
    if (revealedSafe === totalSafe) {
      win();
      return;
    }
    renderStatus(safeLeftText(), '');
  }

  function toggleFlag(r, c) {
    if (phase === 'won' || phase === 'lost') return;
    const cell = grid[r][c];
    if (cell.open) return;
    cell.flagged = !cell.flagged;
    flags += cell.flagged ? 1 : -1;
    renderCell(r, c);
    renderStats();
  }

  function startTimer() {
    stopTimer();
    startedAt = performance.now() - elapsedMs;
    timerId = setInterval(() => {
      elapsedMs = performance.now() - startedAt;
      renderTime();
    }, 250);
  }

  function stopTimer() {
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
    if (startedAt) {
      elapsedMs = performance.now() - startedAt;
      startedAt = 0;
    }
  }

  function currentSeconds() {
    return Math.min(86400, Math.floor(elapsedMs / 1000));
  }

  function lose() {
    phase = 'lost';
    stopTimer();
    renderTime();
    renderBoard();
    renderStatus('You hit a mine.', 'lose');
    setPickerLocked(false);
    renderModeControls();
    finish(false, currentSeconds(), false);
  }

  function win() {
    phase = 'won';
    stopTimer();
    renderTime();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = grid[r][c];
        if (cell.mine && !cell.flagged) {
          cell.flagged = true;
          flags++;
        }
      }
    }
    renderBoard();
    renderStats();
    const seconds = currentSeconds();
    const isBest = !isGuest && (best[sizeKey] == null || seconds < best[sizeKey]);
    renderStatus('Cleared in ' + formatTime(seconds) + '.' + (isBest ? ' New best!' : ''), 'win');
    setPickerLocked(false);
    renderModeControls();
    finish(true, seconds, isBest);
  }

  // ── Screen ────────────────────────────────────────────────────────────────
  function renderStats() {
    els.minesLeft.textContent = String(mineCount - flags);
  }

  function renderTime() {
    els.time.textContent = formatTime(currentSeconds());
  }

  function renderStatus(text, tone) {
    els.statusText.textContent = text;
    els.statusDot.className = 'dot' + (tone ? ' ' + tone : '');
    els.status.className = 'status' + (tone ? ' ' + tone : '');
  }

  function setMode(next) {
    mode = next;
    renderModeControls();
  }

  function renderModeControls() {
    const over = phase === 'won' || phase === 'lost';
    els.reveal.disabled = over;
    els.flag.disabled = over;
    els.reveal.classList.toggle('btn-primary', !over && mode === 'reveal');
    els.flag.classList.toggle('btn-primary', !over && mode === 'flag');
    els.playAgain.hidden = !over;
  }

  function setPickerLocked(locked) {
    els.sizePicker.querySelectorAll('button').forEach((btn) => {
      btn.disabled = locked;
      btn.classList.toggle('on', btn.dataset.size === sizeKey);
    });
  }

  function renderBest() {
    if (listState === 'loading') {
      els.best.innerHTML = BEST_SKELETON;
      return;
    }
    if (listState === 'error') {
      els.best.textContent = '—';
      return;
    }
    const seconds = best[sizeKey];
    els.best.textContent = typeof seconds === 'number' ? formatTime(seconds) : 'None yet';
  }

  // ── Your boards ───────────────────────────────────────────────────────────
  function rowHtml(game) {
    const size = SIZES[game.size] ? SIZES[game.size].label : game.size;
    const title = (game.won ? 'Cleared' : 'Hit a mine') + ', ' + size;
    const icon = game.won
      ? '<span class="ico w">' + ICON_WIN + '</span>'
      : '<span class="ico l">' + ICON_MINE + '</span>';
    const time = '<span class="tm' + (game.won ? '' : ' x') + '">' + formatTime(game.seconds) + '</span>';
    return '<li class="list-row">' + icon +
      '<div class="rt"><p>' + title + '</p><small>' + formatWhen(game.finished_at) + '</small></div>' +
      time + '</li>';
  }

  function renderList() {
    const loading = listState === 'loading';
    els.listLoading.hidden = !loading;
    els.list.hidden = listState !== 'ready' || games.length === 0;
    els.listEmpty.hidden = !(listState === 'ready' && games.length === 0);
    els.listError.hidden = listState !== 'error';
    els.showMore.hidden = !(listState === 'ready' && !!nextBefore);
    if (listState === 'ready' && games.length) {
      els.list.innerHTML = games.map(rowHtml).join('');
    } else {
      els.list.innerHTML = '';
    }
  }

  function loadGames() {
    listState = 'loading';
    renderBest();
    renderList();
    return api('/api/games')
      .then((data) => {
        isGuest = !!data.guest;
        best = data.best || {};
        games = data.games || [];
        nextBefore = data.nextBefore || null;
        listState = 'ready';
      })
      .catch(() => {
        listState = 'error';
        nextBefore = null;
      })
      .then(() => {
        renderBest();
        renderList();
      });
  }

  function loadMore() {
    if (!nextBefore || els.showMore.disabled) return;
    els.showMore.disabled = true;
    api('/api/games?before=' + encodeURIComponent(nextBefore))
      .then((data) => {
        games = games.concat(data.games || []);
        nextBefore = data.nextBefore || null;
        renderList();
      })
      .catch(() => {})
      .then(() => {
        els.showMore.disabled = false;
      });
  }

  // ── Saving a finished game ────────────────────────────────────────────────
  function finish(won, seconds, isBest) {
    if (DEMO) {
      const now = window.usernode && window.usernode.now ? window.usernode.now() : new Date();
      games.unshift({
        id: 'demo-' + now.getTime(),
        size: sizeKey,
        won: won,
        seconds: seconds,
        finished_at: now.toISOString(),
      });
      if (listState === 'ready') renderList();
      if (isBest) {
        best[sizeKey] = seconds;
        renderBest();
      }
      return;
    }
    if (isGuest) return;
    attemptSave({ size: sizeKey, won: won, seconds: seconds });
  }

  function attemptSave(payload) {
    els.saveNote.hidden = true;
    const body = JSON.stringify({ size: payload.size, won: payload.won, seconds: payload.seconds });
    api('/api/games', { method: 'POST', body: body })
      .then((row) => {
        pendingSave = null;
        if (payload.won && (best[payload.size] == null || payload.seconds < best[payload.size])) {
          best[payload.size] = payload.seconds;
          renderBest();
        }
        if (listState === 'ready') {
          games.unshift(row);
          renderList();
        } else {
          loadGames();
        }
      })
      .catch(() => {
        pendingSave = payload;
        els.saveNote.hidden = false;
      });
  }

  // ── Wiring ────────────────────────────────────────────────────────────────
  els.board.addEventListener('click', (event) => {
    const btn = event.target.closest('button');
    if (!btn) return;
    const i = Number(btn.dataset.i);
    const r = Math.floor(i / cols);
    const c = i % cols;
    if (mode === 'flag') toggleFlag(r, c);
    else reveal(r, c);
  });

  els.board.addEventListener('contextmenu', (event) => {
    const btn = event.target.closest('button');
    if (!btn) return;
    event.preventDefault();
    const i = Number(btn.dataset.i);
    toggleFlag(Math.floor(i / cols), i % cols);
  });

  els.sizePicker.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-size]');
    if (!btn || btn.disabled) return;
    if (btn.dataset.size === sizeKey && phase === 'ready' && !flags && !revealedSafe) return;
    newGame(btn.dataset.size);
    renderBest();
  });

  els.mode.addEventListener('click', (event) => {
    const btn = event.target.closest('button');
    if (!btn || btn.disabled) return;
    if (btn === els.reveal) setMode('reveal');
    else if (btn === els.flag) setMode('flag');
    else if (btn === els.playAgain) {
      newGame(sizeKey);
      renderBest();
    }
  });

  els.newGame.addEventListener('click', () => {
    newGame(sizeKey);
    renderBest();
  });

  els.listRetry.addEventListener('click', loadGames);

  els.showMore.addEventListener('click', loadMore);

  els.saveRetry.addEventListener('click', () => {
    if (pendingSave) attemptSave(pendingSave);
  });

  // ── The ?demo=1 board ─────────────────────────────────────────────────────
  function setupDemoBoard() {
    newGame('small');
    DEMO_MINES.forEach((pair) => {
      grid[pair[0]][pair[1]].mine = true;
    });
    computeCounts();
    DEMO_FLAGS.forEach((pair) => {
      grid[pair[0]][pair[1]].flagged = true;
      flags++;
    });
    phase = 'playing';
    setPickerLocked(true);
    DEMO_OPENS.forEach((pair) => reveal(pair[0], pair[1]));
    startedAt = performance.now() - DEMO_START_SECONDS * 1000;
    elapsedMs = DEMO_START_SECONDS * 1000;
    timerId = setInterval(() => {
      elapsedMs = performance.now() - startedAt;
      renderTime();
    }, 250);
    renderTime();
    renderStats();
    renderBoard();
    renderStatus(safeLeftText(), '');
  }

  function init() {
    newGame('small');
    if (DEMO) {
      els.demoNote.hidden = false;
      setupDemoBoard();
    }
    loadGames();
  }

  init();
})();
