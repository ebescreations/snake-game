(() => {
  'use strict';

  // --- Configuration ---------------------------------------------------
  const COLS = 20;
  const ROWS = 20;
  const CELL = 24;                 // logical pixels per grid cell
  const MAX_QUEUED_TURNS = 2;      // room to tap two turns in quick succession
  const SWIPE_THRESHOLD = 24;      // px before a touch counts as a swipe
  const FLASH_MS = 180;            // eat-ring lifetime

  // start/floor are ms per move, so lower is faster. step is how much each
  // food shaves off, points is what one food is worth.
  //
  // Easy/Medium/Advanced sit at 200/100/60 and stay there. Classic is the
  // only one that moves: 170 down to 60, with points scaled to match so a
  // late food beats an early one.
  // blurb goes on the ready overlay. The dropdown only fits the names.
  const LEVELS = {
    easy: {
      label: 'Easy', start: 200, step: 0, floor: 200, points: 5,
      blurb: 'slow and steady, a good place to learn'
    },
    medium: {
      label: 'Medium', start: 100, step: 0, floor: 100, points: 15,
      blurb: 'quick, and it stays that way'
    },
    advanced: {
      label: 'Advanced', start: 60, step: 0, floor: 60, points: 25,
      blurb: 'very quick from the very first move'
    },
    classic: {
      label: 'Classic', start: 170, step: 5, floor: 60, points: 8,
      scalePoints: true,
      blurb: 'starts gently and speeds up as you go'
    }
  };

  const MODES = { keyboard: 1, mouse: 1, both: 1 };

  // Same query styles.css uses to swap the guide text, so the overlay can't
  // end up saying "click" while the guide right below it says "tap". Touch
  // devices don't get the Mode select at all: swiping is the only input
  // there, so all three options would behave the same.
  const TOUCH_FIRST = window.matchMedia('(hover: none) and (pointer: coarse)');
  const isTouch = () => TOUCH_FIRST.matches;

  const DEFAULT_LEVEL = 'classic';
  const DEFAULT_MODE = 'both';

  const LEVEL_KEY = 'snake.level';
  const MODE_KEY = 'snake.mode';
  // v2 because the speeds were retuned. Old bests aren't comparable.
  const bestKeyFor = (lvl) => `snake.v2.best.${lvl}`;

  const DIRS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 }
  };

  const KEY_TO_DIR = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', a: 'left', s: 'down', d: 'right',
    W: 'up', A: 'left', S: 'down', D: 'right'
  };

  const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

  const STATE = {
    READY: 'ready',
    RUNNING: 'running',
    PAUSED: 'paused',
    OVER: 'over',
    WON: 'won'
  };

  // --- DOM -------------------------------------------------------------
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const bestEl = document.getElementById('best');
  const bestLevelEl = document.getElementById('best-level');
  const perFoodEl = document.getElementById('per-food');
  const statusEl = document.getElementById('status');
  const overlayEl = document.getElementById('overlay');
  const overlayTitleEl = document.getElementById('overlay-title');
  const overlayGoalEl = document.getElementById('overlay-goal');
  const overlayLevelEl = document.getElementById('overlay-level');
  const overlayTextEl = document.getElementById('overlay-text');
  const levelSelect = document.getElementById('level');
  const modeSelect = document.getElementById('mode');
  const newGameBtn = document.getElementById('new-game');

  // --- Game state ------------------------------------------------------
  let snake;          // array of {x, y}; snake[0] is the head
  let occupied;       // Set of cell keys the snake currently fills
  let direction;      // current heading, e.g. 'right'
  let queued;         // buffered direction changes
  let food;           // {x, y} or null
  let score;
  let interval;       // ms between moves
  let accumulator;    // ms carried over between frames
  let lastFrame;
  let state;
  let overMessage;    // why the last run ended
  let newBest;        // did this run set a record
  let flash;          // {x, y, life} ring drawn where food was eaten
  let controlMode = 'keys';  // 'keys' | 'mouse', whichever was used last
  let target = null;         // grid cell under the mouse, or null if off board

  let levelKey = readPref(LEVEL_KEY, LEVELS, DEFAULT_LEVEL);
  let inputMode = readPref(MODE_KEY, MODES, DEFAULT_MODE);
  let best = loadBest(levelKey);

  const level = () => LEVELS[levelKey];
  const key = (x, y) => y * COLS + x;
  const inBounds = (x, y) => x >= 0 && x < COLS && y >= 0 && y < ROWS;

  // localStorage throws in some private-browsing setups. Nothing stored here
  // matters enough to fuss over, so swallow it and move on.
  function readStorage(name) {
    try {
      return window.localStorage.getItem(name);
    } catch (err) {
      return null;
    }
  }

  function writeStorage(name, value) {
    try {
      window.localStorage.setItem(name, String(value));
    } catch (err) {
      /* ignore */
    }
  }

  function readPref(name, allowed, fallback) {
    const raw = readStorage(name);
    return raw && Object.prototype.hasOwnProperty.call(allowed, raw) ? raw : fallback;
  }

  // One best per level, or an Easy run would clobber an Advanced one.
  function loadBest(forLevel) {
    const value = Number.parseInt(readStorage(bestKeyFor(forLevel)), 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function saveBest(value) {
    writeStorage(bestKeyFor(levelKey), value);
  }

  // Classic pays at whatever speed you were doing when you ate, so there's
  // no point farming the slow opening.
  function pointsForFood() {
    const cfg = level();
    if (!cfg.scalePoints) return cfg.points;
    return Math.max(1, Math.round(cfg.points * cfg.start / interval));
  }

  // --- Setup -----------------------------------------------------------
  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(COLS * CELL * dpr);
    canvas.height = Math.round(ROWS * CELL * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function reset() {
    const midY = Math.floor(ROWS / 2);
    snake = [
      { x: 3, y: midY },
      { x: 2, y: midY },
      { x: 1, y: midY }
    ];
    occupied = new Set(snake.map(s => key(s.x, s.y)));
    direction = 'right';
    queued = [];
    score = 0;
    interval = level().start;
    accumulator = 0;
    food = spawnFood();
    overMessage = '';
    newBest = false;
    flash = null;
    state = STATE.READY;
    render();
  }

  function spawnFood() {
    const free = [];
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (!occupied.has(key(x, y))) free.push({ x, y });
      }
    }
    if (free.length === 0) return null; // board is full
    return free[Math.floor(Math.random() * free.length)];
  }

  // --- Input -----------------------------------------------------------
  function turn(name) {
    if (state === STATE.OVER || state === STATE.WON) return;
    if (state === STATE.READY) state = STATE.RUNNING;
    if (state === STATE.PAUSED) state = STATE.RUNNING;

    const last = queued.length ? queued[queued.length - 1] : direction;
    if (name === last || name === OPPOSITE[last]) return;
    if (queued.length >= MAX_QUEUED_TURNS) return;
    queued.push(name);
    render();
  }

  function togglePause() {
    if (state === STATE.RUNNING) {
      state = STATE.PAUSED;
    } else if (state === STATE.PAUSED) {
      state = STATE.RUNNING;
    } else if (state === STATE.READY) {
      state = STATE.RUNNING;
    }
    render();
  }

  // Keep our hands off keys meant for a focused control. Space on a
  // <summary> was pausing the game instead of opening the section.
  function isControlTarget(node) {
    return node instanceof Element &&
      node.closest('a, button, input, select, summary, textarea') !== null;
  }

  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isControlTarget(event.target)) return;

    const dir = KEY_TO_DIR[event.key];
    if (dir) {
      event.preventDefault(); // no page scroll, even if we ignore the key
      if (inputMode !== 'mouse') {
        controlMode = 'keys';
        turn(dir);
      }
      return;
    }

    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      togglePause();
      return;
    }

    if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      reset();
      return;
    }

    if (event.key === 'Enter' && (state === STATE.OVER || state === STATE.WON)) {
      event.preventDefault();
      reset();
    }
  });

  // Swipe to steer, tap to pause. Swipes use the same queue as keys, and
  // work in every mode: Mouse mode means nothing on a touchscreen.
  let touchStart = null;

  canvas.addEventListener('touchstart', (event) => {
    const t = event.changedTouches[0];
    touchStart = { x: t.clientX, y: t.clientY, moved: false };
  }, { passive: true });

  canvas.addEventListener('touchmove', (event) => {
    if (!touchStart) return;
    event.preventDefault();
    const t = event.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_THRESHOLD) return;

    controlMode = 'keys';
    turn(Math.abs(dx) > Math.abs(dy)
      ? (dx > 0 ? 'right' : 'left')
      : (dy > 0 ? 'down' : 'up'));

    // Re-anchor here so one long drag can chain turns.
    touchStart = { x: t.clientX, y: t.clientY, moved: true };
  }, { passive: false });

  canvas.addEventListener('touchend', () => {
    if (touchStart && !touchStart.moved) {
      if (state === STATE.OVER || state === STATE.WON) reset();
      else togglePause();
    }
    touchStart = null;
  }, { passive: true });

  canvas.addEventListener('pointerdown', () => canvas.focus());

  // --- Mouse steering --------------------------------------------------
  // Go through the element rect, not the pixel buffer. The canvas is both
  // DPR-scaled and stretched by CSS, so the two don't match.
  function cellFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = Math.floor((event.clientX - rect.left) / rect.width * COLS);
    const y = Math.floor((event.clientY - rect.top) / rect.height * ROWS);
    return {
      x: Math.min(COLS - 1, Math.max(0, x)),
      y: Math.min(ROWS - 1, Math.max(0, y))
    };
  }

  function useMouse() {
    if (controlMode !== 'mouse') {
      controlMode = 'mouse';
      queued = []; // bin buffered keypresses, they'd fire out of nowhere
    }
  }

  canvas.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse' || inputMode === 'keyboard') return;
    useMouse();
    target = cellFromEvent(event);
    if (state !== STATE.RUNNING) render(); // reticle still tracks when idle
  });

  canvas.addEventListener('pointerleave', (event) => {
    if (event.pointerType !== 'mouse') return;
    // Cursor off the board means no input. Carry straight on.
    target = null;
    if (state !== STATE.RUNNING) render();
  });

  canvas.addEventListener('pointerup', (event) => {
    if (event.pointerType !== 'mouse') return;

    // Clicks still start and pause in Keyboard mode. They just don't steer.
    if (inputMode !== 'keyboard') {
      useMouse();
      target = cellFromEvent(event);
    }

    if (state === STATE.OVER || state === STATE.WON) {
      reset();
    } else if (state === STATE.READY) {
      state = STATE.RUNNING;
      render();
    } else {
      togglePause();
    }
  });

  // --- Level and mode selection ----------------------------------------
  function applyLevel(next) {
    if (!LEVELS[next] || next === levelKey) return;

    // Ask before binning a run in progress, and pause while the dialog is up.
    if (score > 0 && (state === STATE.RUNNING || state === STATE.PAUSED)) {
      state = STATE.PAUSED;
      render();
      const ok = window.confirm(
        `Switch to ${LEVELS[next].label}? That ends your current run.`);
      if (!ok) {
        levelSelect.value = levelKey;
        canvas.focus();
        return;
      }
    }

    levelKey = next;
    writeStorage(LEVEL_KEY, next);
    best = loadBest(levelKey);
    reset(); // speed and scoring both change, so the run can't continue
    canvas.focus();
  }

  function applyInputMode(next) {
    if (!MODES[next]) return;
    inputMode = next;
    writeStorage(MODE_KEY, next);

    if (inputMode === 'mouse') {
      controlMode = 'mouse';
      queued = [];
    } else if (inputMode === 'keyboard') {
      controlMode = 'keys';
      target = null;
    }
    // 'both' keeps whichever source was used last.

    // Switching controls mid-run is a free death. Pause instead.
    if (state === STATE.RUNNING) state = STATE.PAUSED;
    render();
    canvas.focus();
  }

  levelSelect.value = levelKey;
  modeSelect.value = inputMode;
  levelSelect.addEventListener('change', () => applyLevel(levelSelect.value));
  modeSelect.addEventListener('change', () => applyInputMode(modeSelect.value));
  newGameBtn.addEventListener('click', () => { reset(); canvas.focus(); });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state === STATE.RUNNING) {
      state = STATE.PAUSED;
      render();
    }
  });

  window.addEventListener('resize', sizeCanvas);

  // Plugging in a keyboard flips this mid-session, and the hints change
  // wording with it. Nothing repaints on its own while we're idle.
  TOUCH_FIRST.addEventListener('change', render);

  // --- Simulation ------------------------------------------------------
  // Input only ever picks a heading. Mouse and keyboard both stop here and
  // everything past this point treats them identically, dying included.
  function nextDirection() {
    if (controlMode === 'mouse') return directionTowardTarget();

    if (!queued.length) return null;
    const next = queued.shift();
    return next === OPPOSITE[direction] ? null : next;
  }

  // Turn toward the cursor on whichever axis it's further away on. A cursor
  // asking for a 180 gets ignored, same as a reverse keypress.
  function directionTowardTarget() {
    if (!target) return null;

    const head = snake[0];
    const dx = target.x - head.x;
    const dy = target.y - head.y;

    const candidates = [];
    if (dx !== 0) candidates.push({ dir: dx > 0 ? 'right' : 'left', mag: Math.abs(dx) });
    if (dy !== 0) candidates.push({ dir: dy > 0 ? 'down' : 'up', mag: Math.abs(dy) });
    candidates.sort((a, b) => b.mag - a.mag);

    for (const candidate of candidates) {
      // Already on the dominant axis, so hold. The other axis gets fixed on
      // a later tick, which is why a diagonal cursor gives you a staircase.
      if (candidate.dir === direction) return null;
      if (candidate.dir === OPPOSITE[direction]) continue;
      return candidate.dir;
    }
    return null;
  }

  function step() {
    const next = nextDirection();
    if (next) direction = next;

    const delta = DIRS[direction];
    const head = { x: snake[0].x + delta.x, y: snake[0].y + delta.y };

    if (!inBounds(head.x, head.y)) {
      gameOver('You hit the wall.');
      return;
    }

    const grow = food !== null && head.x === food.x && head.y === food.y;
    const tail = snake[snake.length - 1];
    const headKey = key(head.x, head.y);

    // The tail vacates its cell on this same move, so moving into it is
    // legal, unless we're growing and the tail stays put.
    const hitsSelf = occupied.has(headKey) &&
      !(!grow && headKey === key(tail.x, tail.y));

    if (hitsSelf) {
      gameOver('You ran into yourself.');
      return;
    }

    snake.unshift(head);
    occupied.add(headKey);

    if (grow) {
      score += pointsForFood();
      interval = Math.max(level().floor, interval - level().step);
      flash = { x: head.x, y: head.y, life: FLASH_MS };
      food = spawnFood();
      if (food === null) {
        state = STATE.WON;
        commitBest();
        render();
        return;
      }
    } else {
      snake.pop();
      // Watch the tail-follow case above: if the head took the tail's cell,
      // this key is the head's now and deleting it leaves a gap we could
      // later drive straight through.
      const tailKey = key(tail.x, tail.y);
      if (tailKey !== headKey) occupied.delete(tailKey);
    }
  }

  function gameOver(reason) {
    state = STATE.OVER;
    queued = [];
    overMessage = reason;
    commitBest();
    render();
  }

  function commitBest() {
    if (score > best) {
      best = score;
      newBest = true;
      saveBest(best);
    }
  }

  function frame(timestamp) {
    if (lastFrame === undefined) lastFrame = timestamp;
    const elapsed = timestamp - lastFrame;
    lastFrame = timestamp;

    if (state === STATE.RUNNING) {
      // Clamped, or a backgrounded tab comes back and replays a burst.
      const dt = Math.min(elapsed, 250);

      if (flash) {
        flash.life -= dt;
        if (flash.life <= 0) flash = null;
      }

      accumulator += dt;
      while (state === STATE.RUNNING && accumulator >= interval) {
        accumulator -= interval;
        step();
      }
      render();
    }

    window.requestAnimationFrame(frame);
  }

  // --- Rendering -------------------------------------------------------
  // render() runs every frame, so don't write unless the text changed.
  // Rewriting the live region 60 times a second spams screen readers.
  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function render() {
    setText(scoreEl, String(score));
    setText(bestEl, String(best));
    setText(bestLevelEl, level().label);
    setText(perFoodEl, `+${pointsForFood()}`);
    updateOverlay();
    draw();
  }

  function startHint() {
    if (isTouch()) return 'Tap the board to start';
    // Arrow keys are dead in Mouse mode, but a click always starts.
    return inputMode === 'mouse'
      ? 'Click the board to start'
      : 'Click the board or press an arrow key to start';
  }

  // Also goes into the live region, so a screen reader reads it out. Naming
  // the R key to someone on a phone is worse than saying nothing.
  function againHint() {
    return isTouch() ? 'Tap to play again' : 'Click or press R to play again';
  }

  function updateOverlay() {
    const label = level().label;

    switch (state) {
      case STATE.READY:
        showOverlay('Ready?',
          'Eat the food, avoid the walls and your own tail.',
          `${label} \u2014 ${level().blurb}`,
          startHint());
        setText(statusEl, '');
        break;

      case STATE.RUNNING:
        hideOverlay();
        setText(statusEl, '');
        break;

      case STATE.PAUSED:
        showOverlay('Paused', '', '',
          isTouch() ? 'Tap to resume' : 'Click or press space to resume');
        setText(statusEl, 'Paused.');
        break;

      case STATE.OVER:
        if (newBest) {
          showOverlay('New best!', `${score} on ${label}`, '', againHint());
          setText(statusEl,
            `${overMessage} New best of ${score} on ${label}. ` +
            `${againHint()}.`);
        } else {
          showOverlay('Game over', `Score ${score} on ${label} \u00b7 best ${best}`, '',
            againHint());
          setText(statusEl,
            `${overMessage} Scored ${score} on ${label}. Best ${best}. ` +
            `${againHint()}.`);
        }
        break;

      case STATE.WON:
        showOverlay('You filled the board!',
          newBest ? `New best of ${score} on ${label}` : `Score ${score} on ${label}`,
          '',
          againHint());
        setText(statusEl,
          `You filled the board and scored ${score} on ${label}. ` +
          `${againHint()}.`);
        break;
    }
  }

  // Pass '' for a slot you don't want. The CSS collapses empty ones.
  function showOverlay(title, goal, levelNote, hint) {
    setText(overlayTitleEl, title);
    setText(overlayGoalEl, goal);
    setText(overlayLevelEl, levelNote);
    setText(overlayTextEl, hint);
    if (overlayEl.hidden) overlayEl.hidden = false;
  }

  function hideOverlay() {
    if (!overlayEl.hidden) overlayEl.hidden = true;
  }

  function draw() {
    const w = COLS * CELL;
    const h = ROWS * CELL;

    ctx.clearRect(0, 0, w, h);

    // Faint checkerboard. Makes the movement much easier to follow.
    ctx.fillStyle = '#1a1f29';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#1d222d';
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if ((x + y) % 2 === 0) ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }

    if (food) drawFood(food);
    drawSnake();
    if (flash) drawFlash();

    if (controlMode === 'mouse' && target &&
        (state === STATE.READY || state === STATE.RUNNING)) {
      drawTarget(target);
    }
  }

  function drawFood(cell) {
    const cx = cell.x * CELL + CELL / 2;
    const cy = cell.y * CELL + CELL / 2;
    const r = CELL * 0.3;

    ctx.fillStyle = '#fbbf24';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    // Pale rim and a round shape, so the food stands out by more than just
    // colour. The red dot I started with vanished against the green.
    ctx.strokeStyle = '#fffbeb';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.beginPath();
    ctx.arc(cx - r * 0.3, cy - r * 0.35, r * 0.26, 0, Math.PI * 2);
    ctx.fill();
  }

  // Ring expanding out of the cell you just ate, so the score counter isn't
  // the only sign anything happened.
  function drawFlash() {
    const t = 1 - Math.max(0, flash.life) / FLASH_MS;
    const cx = flash.x * CELL + CELL / 2;
    const cy = flash.y * CELL + CELL / 2;

    ctx.strokeStyle = `rgba(251, 191, 36, ${(1 - t) * 0.6})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, CELL * (0.3 + t * 0.6), 0, Math.PI * 2);
    ctx.stroke();
  }

  // Shows the cell the snake is actually aiming at. Mouse mode is baffling
  // without it.
  function drawTarget(cell) {
    ctx.strokeStyle = 'rgba(230, 233, 239, 0.4)';
    ctx.lineWidth = 1.5;
    roundRect(cell.x * CELL + 2.5, cell.y * CELL + 2.5, CELL - 5, CELL - 5, 5);
    ctx.stroke();
  }

  function drawSnake() {
    const pad = 1.5;
    const size = CELL - pad * 2;

    for (let i = snake.length - 1; i >= 0; i--) {
      const seg = snake[i];
      // Brightest at the head, fading off toward the tail.
      const t = snake.length === 1 ? 0 : i / (snake.length - 1);
      ctx.fillStyle = mixColor([74, 222, 128], [22, 125, 85], t * 0.85);
      roundRect(seg.x * CELL + pad, seg.y * CELL + pad, size, size, i === 0 ? 7 : 5);
      ctx.fill();
    }

    drawEyes(snake[0]);
  }

  function drawEyes(head) {
    const d = DIRS[direction];
    const cx = head.x * CELL + CELL / 2;
    const cy = head.y * CELL + CELL / 2;
    const forward = CELL * 0.17;
    const side = CELL * 0.19;
    const r = CELL * 0.085;

    // Perpendicular to travel, so the eyes sit side by side.
    const px = -d.y;
    const py = d.x;

    ctx.fillStyle = '#11141a';
    for (const sign of [1, -1]) {
      ctx.beginPath();
      ctx.arc(
        cx + d.x * forward + px * side * sign,
        cy + d.y * forward + py * side * sign,
        r, 0, Math.PI * 2
      );
      ctx.fill();
    }
  }

  function roundRect(x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, radius);
      return;
    }
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function mixColor(from, to, t) {
    const c = from.map((v, i) => Math.round(v + (to[i] - v) * t));
    return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  }

  // --- Boot ------------------------------------------------------------
  reset();
  sizeCanvas();
  canvas.focus();
  window.requestAnimationFrame(frame);
})();
