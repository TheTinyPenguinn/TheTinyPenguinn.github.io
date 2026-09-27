/* game.js: Mate in Three, the board, the input and the run of play.

   The rules live in engine.js, the starting pool in puzzles.js, and maker.js
   makes fresh positions in a worker while you play. No dependencies, no build
   step, nothing loaded from the network.

   The sky behind the page is the site's own, drawn by ../main.js. Everything
   here is wrapped in one function so nothing collides with that script.

   Sections:
     1. Config
     2. Helpers
     3. Board renderer
     4. Where puzzles come from
     5. The run of play
     6. Input
     7. Interface
     8. Frame loop */

(function () {
"use strict";

/* 1. Config: every tunable lives here. */

const BOARD = {
  maxDpr: 2,               // devicePixelRatio cap
  margin: 0.055,           // room for the coordinates, as a share of the canvas
  // The board is lighter than the page, or dark pieces cannot read as dark.
  backdrop: 0.72,
  light: 0.15,
  dark: 0.055,
  glyph: 0.78,             // piece size, as a share of a square
  glyphLift: 0.035,
  dot: 0.105,              // "you may move here" dot, share of a square
  ring: 0.39,              // "you may take this" ring, share of a square

  // Motion. Everything below is in seconds and is driven by delta time, so the
  // feel does not change with the refresh rate.
  slideSec: 0.26,          // a piece moving from square to square
  fadeSec: 0.16,           // highlights coming and going
  hintSec: 0.14,           // one legal-move marker appearing
  hintStagger: 0.026,      // gap between them, so they ripple out
  enterSec: 0.40,          // one piece arriving on a new position
  enterStagger: 0.04,      // per square of distance from the middle
  enterLead: 0.04,         // head start for the old position to clear
  leaveSec: 0.28,          // the old position fading out under the new one
  checkSec: 0.22,
  winSec: 0.8,
  pulseSec: 2.8,           // the slow breath on a king in check

  accentRgb: "169, 189, 255", // the site's --accent
};

const STORE_KEY = "mateinthree.v2";
const MOVES_ALLOWED = 3;
const TIERS = ["Gentle", "Regular", "Tough"];
const TAU = Math.PI * 2;
const FONT_STACK = '-apple-system, "SF Pro Text", BlinkMacSystemFont, ' +
  '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
// Chess glyphs come from whatever symbol font the system has. If none of them
// has one, drawPiece falls back to letters.
const GLYPH_FONT = '"Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols 2", ' +
  '"DejaVu Sans", ' + FONT_STACK;
const GLYPHS = ["", "\u265F", "\u265E", "\u265D", "\u265C", "\u265B", "\u265A"];
const LETTERS = ["", "P", "N", "B", "R", "Q", "K"];
const PIECE_WORDS = ["", "pawn", "knight", "bishop", "rook", "queen", "king"];

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/* 2. Helpers */

function readJson(store, key) {
  try {
    return JSON.parse(store.getItem(key));
  } catch (e) {
    return null;
  }
}

function writeJson(store, key, value) {
  try {
    store.setItem(key, JSON.stringify(value));
  } catch (e) {
    /* private mode, or a full quota: the game simply forgets */
  }
}

/* Frame-rate independent approach to a target: `tau` is the time constant. */
function ease(current, target, dt, tau) {
  const k = 1 - Math.exp(-dt / tau);
  const next = current + (target - current) * k;
  return Math.abs(target - next) < 0.001 ? target : next;
}

/* A soft star: bright core fading out into a wide faint halo. */
function starSprite(corePx, rgb, peak, glow) {
  const radius = Math.max(2, Math.ceil(corePx * glow));
  const size = radius * 2;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(radius, radius, 0, radius, radius, radius);
  const stop = Math.min(0.9, 1 / glow);
  grad.addColorStop(0, "rgba(" + rgb + ", " + peak + ")");
  grad.addColorStop(stop * 0.6, "rgba(" + rgb + ", " + peak * 0.85 + ")");
  grad.addColorStop(stop, "rgba(" + rgb + ", " + peak * 0.22 + ")");
  grad.addColorStop(Math.min(1, stop * 2.2), "rgba(" + rgb + ", " + peak * 0.06 + ")");
  grad.addColorStop(1, "rgba(" + rgb + ", 0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return { canvas: c, radius: radius };
}

/* 3. Board renderer */

const board = (function () {
  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");
  let dpr = 1, cssSize = 0, sq = 40, x0 = 0, pad = 0;
  let glyphFont = "", coordFont = "", useGlyphs = true;
  let bloom = null, dirty = true, pulse = 0;

  // animation state, allocated once
  const enter = new Float32Array(120);      // 0..1 as a piece arrives
  const enterDelay = new Float32Array(120);
  const lastGlow = new Float32Array(120);   // the two squares of the last move
  const pickGlow = new Float32Array(120);   // the square you have picked up
  const hint = new Float32Array(120);       // legal-move markers
  const outgoing = new Int8Array(120);      // the position being replaced
  let outFade = 0, checkGlow = 0, winGlow = 0;

  // colour strings, built on layout so no frame ever builds one
  let cBackdrop = "", cLight = "", cDark = "", cEdge = "", cCoord = "";
  let cWhite = "", cWhiteGlow = "", cWhiteEdge = "", cBlack = "", cBlackEdge = "";
  const accent = BOARD.accentRgb;

  function colours() {
    cBackdrop = "rgba(8, 8, 10, " + BOARD.backdrop + ")";
    cLight = "rgba(255, 255, 255, " + BOARD.light + ")";
    cDark = "rgba(255, 255, 255, " + BOARD.dark + ")";
    cEdge = "rgba(255, 255, 255, 0.1)";
    cCoord = "rgba(255, 255, 255, 0.3)";
    cWhite = "#f2f2f6";
    cWhiteGlow = "rgba(" + accent + ", 0.13)";
    cWhiteEdge = "rgba(8, 8, 10, 0.9)";
    cBlack = "#08080a";
    cBlackEdge = "rgba(226, 232, 245, 0.68)";
  }

  /* Not every system has the chess glyphs. If the measured width of a king
     matches an unassigned codepoint, they are missing, so use letters. */
  function glyphsAvailable() {
    ctx.font = "40px " + GLYPH_FONT;
    const king = ctx.measureText("\u265A").width;
    const notdef = ctx.measureText("\uE05C").width;
    return king > 1 && Math.abs(king - notdef) > 0.5;
  }

  function layout() {
    dpr = Math.min(window.devicePixelRatio || 1, BOARD.maxDpr);
    cssSize = canvas.clientWidth || 320;
    canvas.width = Math.round(cssSize * dpr);
    canvas.height = Math.round(cssSize * dpr);
    pad = Math.round(cssSize * BOARD.margin);
    sq = (cssSize - pad) / 8;
    x0 = pad;
    glyphFont = Math.round(sq * BOARD.glyph) + "px " + GLYPH_FONT;
    coordFont = "500 " + Math.max(8, Math.round(sq * 0.26)) + "px " + FONT_STACK;
    useGlyphs = glyphsAvailable();
    bloom = starSprite(sq * 0.3 * dpr, accent, 0.75, 2.4);
    colours();
    dirty = true;
  }

  /* Remembers the position being replaced so it can fade out under the new one
     rather than vanishing in a single frame. Call before the board changes. */
  function captureOutgoing() {
    if (reducedMotion.matches || !game.pos) { outFade = 0; return; }
    for (let s = 21; s <= 98; s++) {
      const p = game.pos.pieceAt(s);
      outgoing[s] = (p > 0 && enter[s] > 0.4) ? p : 0;
    }
    outFade = 1;
  }

  /* A fresh position blooms outward from the middle of the board, just behind
     the old one on its way out. */
  function announceNewPosition() {
    enter.fill(1);
    enterDelay.fill(0);
    lastGlow.fill(0);
    pickGlow.fill(0);
    hint.fill(0);
    checkGlow = 0;
    winGlow = 0;
    if (reducedMotion.matches) { outFade = 0; dirty = true; return; }
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const s = 21 + r * 10 + f;
        if (game.pos.pieceAt(s) <= 0) continue;
        enter[s] = 0;
        const reach = Math.max(Math.abs(f - 3.5), Math.abs(r - 3.5)) - 0.5;
        // the old position needs a moment to clear first
        enterDelay[s] = BOARD.enterLead + reach * BOARD.enterStagger;
      }
    }
    dirty = true;
  }

  function squareX(s) { return x0 + CHESS.fileOf(s) * sq; }
  function squareY(s) { return CHESS.rankOf(s) * sq; }

  function squareAt(px, py) {
    const f = Math.floor((px - x0) / sq);
    const r = Math.floor(py / sq);
    if (f < 0 || f > 7 || r < 0 || r > 7) return -1;
    return 21 + r * 10 + f;
  }

  function drawPiece(piece, cx, cy, scale, alpha) {
    const type = piece & 7;
    const white = !(piece & CHESS.BLACK);
    const text = useGlyphs ? GLYPHS[type] : LETTERS[type];
    const y = cy - sq * BOARD.glyphLift;
    if (scale !== 1 || alpha !== 1) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(cx, y);
      ctx.scale(scale, scale);
      ctx.translate(-cx, -y);
    }
    ctx.font = glyphFont;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // Both sides use the solid glyphs so they carry the same weight, and are
    // told apart by fill: White is starlight, Black is cut out of the night
    // with a bright edge. The rim has to stay thin or it eats the glyph.
    const rim = Math.max(1, sq * 0.028);
    if (white) {
      ctx.lineWidth = sq * 0.12;
      ctx.strokeStyle = cWhiteGlow;
      ctx.strokeText(text, cx, y);
      ctx.lineWidth = rim;
      ctx.strokeStyle = cWhiteEdge;
      ctx.strokeText(text, cx, y);
      ctx.fillStyle = cWhite;
      ctx.fillText(text, cx, y);
    } else {
      ctx.lineWidth = rim;
      ctx.strokeStyle = cBlackEdge;
      ctx.fillStyle = cBlack;
      ctx.fillText(text, cx, y);
      ctx.strokeText(text, cx, y);
    }
    if (scale !== 1 || alpha !== 1) ctx.restore();
  }

  function tick(dt) {
    if (!game.pos) return;
    if (reducedMotion.matches) {
      // no easing: the animated values sit at their targets
      for (let s = 21; s <= 98; s++) {
        enter[s] = 1;
        lastGlow[s] = (s === game.lastFrom || s === game.lastTo) ? 1 : 0;
        pickGlow[s] = s === game.selected ? 1 : 0;
        hint[s] = game.targets.indexOf(s) >= 0 ? 1 : 0;
      }
      checkGlow = game.pos.inCheck(game.pos.side()) ? 1 : 0;
      winGlow = game.solved ? 1 : 0;
      outFade = 0;
      return;
    }

    let busy = false;
    if (outFade > 0) {
      outFade = Math.max(0, outFade - dt / BOARD.leaveSec);
      busy = true;
    }
    for (let s = 21; s <= 98; s++) {
      if (enter[s] < 1) {
        if (enterDelay[s] > 0) enterDelay[s] -= dt;
        else enter[s] = Math.min(1, enter[s] + dt / BOARD.enterSec);
        busy = true;
      }
      const wantLast = (s === game.lastFrom || s === game.lastTo) ? 1 : 0;
      if (lastGlow[s] !== wantLast) { lastGlow[s] = ease(lastGlow[s], wantLast, dt, BOARD.fadeSec); busy = true; }
      const wantPick = s === game.selected ? 1 : 0;
      if (pickGlow[s] !== wantPick) { pickGlow[s] = ease(pickGlow[s], wantPick, dt, BOARD.fadeSec); busy = true; }
      const at = game.targets.indexOf(s);
      const wantHint = at >= 0 ? 1 : 0;
      if (hint[s] !== wantHint) {
        // markers ripple out in the order they were found
        const delay = at >= 0 ? at * BOARD.hintStagger : 0;
        hint[s] = ease(hint[s], wantHint, Math.max(0, dt - delay * 0.001), BOARD.hintSec);
        busy = true;
      }
    }

    const wantCheck = game.pos.inCheck(game.pos.side()) ? 1 : 0;
    if (checkGlow !== wantCheck) { checkGlow = ease(checkGlow, wantCheck, dt, BOARD.checkSec); busy = true; }
    const wantWin = game.solved ? 1 : 0;
    if (winGlow !== wantWin) { winGlow = ease(winGlow, wantWin, dt, BOARD.winSec); busy = true; }

    if (game.slide) {
      game.slide.t = Math.min(1, game.slide.t + dt / BOARD.slideSec);
      if (game.slide.t >= 1) game.slide = null;
      busy = true;
    }

    pulse += dt / BOARD.pulseSec;
    if (pulse > 1) pulse -= 1;
    if (checkGlow > 0.01) busy = true;            // the breath keeps going

    if (busy) dirty = true;
  }

  function draw() {
    const pos = game.pos;
    if (!pos) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssSize, cssSize);

    const size = sq * 8;
    ctx.fillStyle = cBackdrop;
    ctx.fillRect(x0, 0, size, size);

    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const s = 21 + r * 10 + f;
        ctx.fillStyle = (f + r) % 2 === 0 ? cLight : cDark;
        ctx.fillRect(squareX(s), squareY(s), sq + 0.5, sq + 0.5);
      }
    }

    // the last move, then the square you have picked up
    for (let s = 21; s <= 98; s++) {
      if (lastGlow[s] > 0.01) {
        ctx.fillStyle = "rgba(" + accent + ", " + (0.11 * lastGlow[s]).toFixed(3) + ")";
        ctx.fillRect(squareX(s), squareY(s), sq + 0.5, sq + 0.5);
      }
      if (pickGlow[s] > 0.01) {
        const a = pickGlow[s];
        ctx.fillStyle = "rgba(" + accent + ", " + (0.19 * a).toFixed(3) + ")";
        ctx.fillRect(squareX(s), squareY(s), sq + 0.5, sq + 0.5);
        ctx.strokeStyle = "rgba(" + accent + ", " + (0.7 * a).toFixed(3) + ")";
        ctx.lineWidth = Math.max(1, sq * 0.03);
        ctx.strokeRect(squareX(s) + sq * 0.02, squareY(s) + sq * 0.02, sq * 0.96, sq * 0.96);
      }
    }

    // the king that is in check, or the king that has been mated
    if (checkGlow > 0.01) {
      const k = pos.kingSquare(pos.side());
      const cx = squareX(k) + sq / 2, cy = squareY(k) + sq / 2;
      const breath = game.solved ? 0 : Math.sin(pulse * TAU) * 0.03;
      const r = bloom.radius / dpr * (1 + 0.12 * winGlow);
      ctx.globalAlpha = checkGlow * (game.solved ? 1 : 0.75);
      ctx.drawImage(bloom.canvas, cx - r, cy - r, r * 2, r * 2);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, sq * (0.44 + breath) * (1 + 0.06 * winGlow), 0, TAU);
      ctx.lineWidth = Math.max(1, sq * 0.035);
      ctx.strokeStyle = "rgba(" + accent + ", " + (0.85 * checkGlow).toFixed(3) + ")";
      ctx.stroke();
    }

    // where the piece you are holding may go
    for (let i = 0; i < game.targets.length; i++) {
      const t = game.targets[i];
      const a = hint[t];
      if (a <= 0.01) continue;
      const cx = squareX(t) + sq / 2, cy = squareY(t) + sq / 2;
      const grow = 0.6 + 0.4 * a;
      ctx.beginPath();
      if (pos.pieceAt(t) > 0) {
        ctx.arc(cx, cy, sq * BOARD.ring * grow, 0, TAU);
        ctx.lineWidth = sq * 0.07;
        ctx.strokeStyle = "rgba(" + accent + ", " + (0.44 * a).toFixed(3) + ")";
        ctx.stroke();
      } else {
        ctx.arc(cx, cy, sq * BOARD.dot * grow, 0, TAU);
        ctx.fillStyle = "rgba(" + accent + ", " + (0.44 * a).toFixed(3) + ")";
        ctx.fill();
      }
    }

    // the position on its way out, shrinking as it goes
    if (outFade > 0) {
      for (let s = 21; s <= 98; s++) {
        if (outgoing[s] <= 0) continue;
        drawPiece(outgoing[s], squareX(s) + sq / 2, squareY(s) + sq / 2,
          0.9 + 0.1 * outFade, outFade * 0.9);
      }
    }

    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const s = 21 + r * 10 + f;
        const piece = pos.pieceAt(s);
        if (piece <= 0) continue;
        if (game.slide && game.slide.to === s) continue;
        const t = enter[s];
        if (t <= 0) continue;
        const eased = 1 - Math.pow(1 - t, 3);
        drawPiece(piece, squareX(s) + sq / 2, squareY(s) + sq / 2,
          0.82 + 0.18 * eased, eased);
      }
    }

    if (game.slide) {
      const e = 1 - Math.pow(1 - game.slide.t, 3);
      const fx = squareX(game.slide.from) + sq / 2, fy = squareY(game.slide.from) + sq / 2;
      const tx = squareX(game.slide.to) + sq / 2, ty = squareY(game.slide.to) + sq / 2;
      drawPiece(game.slide.piece, fx + (tx - fx) * e, fy + (ty - fy) * e, 1, 1);
    }

    if (game.cursorShown && game.cursor >= 0) {
      ctx.strokeStyle = "rgba(" + accent + ", 0.7)";
      ctx.lineWidth = Math.max(1.5, sq * 0.045);
      ctx.strokeRect(squareX(game.cursor) + sq * 0.05, squareY(game.cursor) + sq * 0.05,
        sq * 0.9, sq * 0.9);
    }

    ctx.strokeStyle = cEdge;
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, 0.5, size - 1, size - 1);

    ctx.font = coordFont;
    ctx.fillStyle = cCoord;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let f = 0; f < 8; f++) {
      ctx.fillText("abcdefgh"[f], x0 + f * sq + sq / 2, size + pad * 0.18);
    }
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let r = 0; r < 8; r++) {
      ctx.fillText(String(8 - r), x0 - pad * 0.22, r * sq + sq / 2);
    }

    dirty = false;
  }

  return {
    canvas: canvas,
    layout: layout,
    draw: draw,
    tick: tick,
    squareAt: squareAt,
    announceNewPosition: announceNewPosition,
    captureOutgoing: captureOutgoing,
    markDirty: function () { dirty = true; },
    isDirty: function () { return dirty; },
  };
}());

/* 4. Where puzzles come from ------------------------------------------------
   The pool in puzzles.js gives an instant first position. maker.js proves
   fresh ones in a worker while you play, and those are preferred once they
   arrive, so coming back tomorrow does not mean the same puzzles.
   -------------------------------------------------------------------------- */

const supply = (function () {
  const fresh = [[], [], []];       // proved by the worker, one list per tier
  let worker = null;
  let asking = false;
  let made = 0;
  let seen = { 0: [], 1: [], 2: [] };

  function parsePool(i) {
    const entry = PUZZLE_POOL[i];
    const cut = entry.lastIndexOf(" ");
    return { fen: entry.slice(0, cut) + " w - - 0 1", tier: +entry.slice(cut + 1) };
  }

  function start() {
    if (worker || typeof Worker === "undefined") return;
    try {
      worker = new Worker("maker.js");
    } catch (e) {
      worker = null;                // file:// without a server, say
      return;
    }
    worker.onmessage = function (e) {
      const msg = e.data;
      if (msg.type === "puzzle") {
        fresh[msg.tier].push({ fen: msg.board + " w - - 0 1", tier: msg.tier });
        if (fresh[msg.tier].length > 4) fresh[msg.tier].shift();
        made++;
        ui.onSupply(made);
      } else if (msg.type === "done") {
        asking = false;
        topUp();
      }
    };
    worker.onerror = function () { worker = null; asking = false; };
    topUp();
  }

  /* Keep two of the tier being played in hand, and no more: there is no reason
     to keep a phone busy once the shelf is full. */
  function topUp() {
    if (!worker || asking || document.hidden) return;
    const want = 2 - fresh[game.tier].length;
    if (want <= 0) return;
    asking = true;
    worker.postMessage({
      type: "make", tier: game.tier, want: want, budgetMs: 12000,
    });
  }

  return {
    start: start,
    topUp: topUp,
    freshCount: function (tier) { return fresh[tier].length; },
    madeCount: function () { return made; },
    restoreSeen: function (s) { seen = s || { 0: [], 1: [], 2: [] }; },
    seen: function () { return seen; },

    /* The next position for this tier. A freshly proved one if there is one,
       otherwise one from the pool that this browser has not shown yet. */
    next: function (tier, preferFresh) {
      if (preferFresh && fresh[tier].length) {
        const puzzle = fresh[tier].shift();
        topUp();
        return puzzle;
      }
      const marks = seen[tier] || (seen[tier] = []);
      const candidates = [];
      for (let i = 0; i < PUZZLE_POOL.length; i++) {
        const p = parsePool(i);
        if (p.tier !== tier || marks.indexOf(i) >= 0) continue;
        candidates.push(i);
      }
      if (!candidates.length) {
        // been through them all: start the tier again
        marks.length = 0;
        for (let i = 0; i < PUZZLE_POOL.length; i++) {
          if (parsePool(i).tier === tier) candidates.push(i);
        }
      }
      if (!candidates.length) {
        if (fresh[tier].length) return fresh[tier].shift();
        return parsePool(0);
      }
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      marks.push(pick);
      topUp();
      return parsePool(pick);
    },
  };
}());

/* 5. The run of play -------------------------------------------------------
   Three White moves. Black answers with the defence that holds out longest.
   Mate inside the three and it is solved.
   ------------------------------------------------------------------------- */

const game = {
  pos: null,
  fen: "",
  tier: 1,
  used: 0,
  history: [],          // [{ white, black }] so an undo takes back a pair
  selected: -1,
  targets: [],
  lastFrom: -1,
  lastTo: -1,
  solved: false,
  over: false,
  slipped: false,
  slide: null,
  cursor: 0,
  cursorShown: false,
  pending: null,        // a promotion waiting for a choice
  replay: null,
  thinkTimer: 0,
};

function loadPuzzle(puzzle) {
  if (game.pos) board.captureOutgoing();
  game.fen = puzzle.fen;
  game.pos = game.pos || CHESS.create();
  restart();
  board.layout();
  board.announceNewPosition();
  ui.syncPuzzle();
}

function restart() {
  clearTimeout(game.thinkTimer);
  game.thinkTimer = 0;
  if (game.replay) { clearTimeout(game.replay.timer); game.replay = null; }
  game.pos.setFen(game.fen);
  game.used = 0;
  game.history.length = 0;
  game.selected = -1;
  game.targets.length = 0;
  game.lastFrom = -1;
  game.lastTo = -1;
  game.solved = false;
  game.over = false;
  game.slipped = false;
  game.slide = null;
  game.pending = null;
  game.cursor = game.pos.kingSquare(CHESS.WHITE);
}

function movesLeft() { return MOVES_ALLOWED - game.used; }

function busy() {
  return game.thinkTimer !== 0 || !!game.replay;
}

function select(sq) {
  game.selected = sq;
  game.targets.length = 0;
  const all = game.pos.legalMoves();
  for (let i = 0; i < all.length; i++) {
    if (CHESS.moveFrom(all[i]) === sq) {
      const to = CHESS.moveTo(all[i]);
      if (game.targets.indexOf(to) < 0) game.targets.push(to);
    }
  }
}

function deselect() {
  game.selected = -1;
  game.targets.length = 0;
  game.pending = null;
  ui.hidePromotion();
}

function startSlide(m) {
  if (reducedMotion.matches) { game.slide = null; return; }
  game.slide = {
    from: CHESS.moveFrom(m),
    to: CHESS.moveTo(m),
    piece: game.pos.pieceAt(CHESS.moveTo(m)),
    t: 0,
  };
}

function tryMove(from, to) {
  const all = game.pos.legalMoves();
  const matches = [];
  for (let i = 0; i < all.length; i++) {
    if (CHESS.moveFrom(all[i]) === from && CHESS.moveTo(all[i]) === to) {
      matches.push(all[i]);
    }
  }
  if (!matches.length) return false;
  if (matches.length > 1) {
    // only a promotion offers several moves between the same two squares
    game.pending = { from: from, to: to, options: matches };
    ui.showPromotion(matches);
    return true;
  }
  playWhite(matches[0]);
  return true;
}

function playWhite(m) {
  const pos = game.pos;
  const san = pos.toSan(m);
  pos.make(m);
  game.history.push({ white: m, black: 0 });
  game.used++;
  game.lastFrom = CHESS.moveFrom(m);
  game.lastTo = CHESS.moveTo(m);
  startSlide(m);
  deselect();

  if (pos.isCheckmate()) {
    game.solved = true;
    game.over = true;
    ui.onSolved(san);
    requestDraw();
    return;
  }
  if (pos.isStalemate()) {
    game.over = true;
    ui.onFailed("That is stalemate, not mate: a draw.");
    requestDraw();
    return;
  }
  if (game.used >= MOVES_ALLOWED) {
    game.over = true;
    ui.onFailed("Three moves gone and the king is still there.");
    requestDraw();
    return;
  }

  ui.onWhiteMove(san);
  requestDraw();
  // let the board show the move before the defence answers
  game.thinkTimer = setTimeout(replyBlack, reducedMotion.matches ? 0 : 170);
}

function replyBlack() {
  game.thinkTimer = 0;
  const pos = game.pos;
  const answer = pos.bestDefence(movesLeft(), 0);
  if (!answer.move) { requestDraw(); return; }
  const san = pos.toSan(answer.move);
  pos.make(answer.move);
  game.history[game.history.length - 1].black = answer.move;
  game.lastFrom = CHESS.moveFrom(answer.move);
  game.lastTo = CHESS.moveTo(answer.move);
  startSlide(answer.move);
  game.slipped = answer.distance === 0;
  game.cursor = pos.kingSquare(CHESS.WHITE);
  ui.onBlackMove(san, answer.distance);
  requestDraw();
}

function takeBack() {
  if (game.replay || !game.history.length) return;
  clearTimeout(game.thinkTimer);
  game.thinkTimer = 0;
  const last = game.history.pop();
  if (last.black) game.pos.unmake();
  game.pos.unmake();
  game.used--;
  game.solved = false;
  game.over = false;
  game.slide = null;
  deselect();
  const prev = game.history[game.history.length - 1];
  if (prev) {
    const m = prev.black || prev.white;
    game.lastFrom = CHESS.moveFrom(m);
    game.lastTo = CHESS.moveTo(m);
  } else {
    game.lastFrom = -1;
    game.lastTo = -1;
  }
  game.slipped = false;
  ui.onTakeBack();
  requestDraw();
}

/* The proved line, worked out from the starting position. */
function solutionLine() {
  const p = CHESS.create();
  p.setFen(game.fen);
  const out = [];
  let remaining = MOVES_ALLOWED;
  for (let guard = 0; guard < 12; guard++) {
    const keys = p.matingMoves(remaining, 0);
    if (!keys.length) break;
    out.push({ move: keys[0], san: p.toSan(keys[0]) });
    p.make(keys[0]);
    if (p.isCheckmate()) break;
    const answer = p.bestDefence(remaining - 1, 0);
    if (!answer.move) break;
    out.push({ move: answer.move, san: p.toSan(answer.move) });
    p.make(answer.move);
    remaining = answer.distance;
    if (!remaining) break;
  }
  return out;
}

function showLine() {
  if (game.replay) return;
  const line = solutionLine();
  restart();
  board.announceNewPosition();
  ui.onLine(line);
  game.over = true;
  if (reducedMotion.matches) {
    for (let i = 0; i < line.length; i++) game.pos.make(line[i].move);
    const last = line[line.length - 1];
    game.lastFrom = CHESS.moveFrom(last.move);
    game.lastTo = CHESS.moveTo(last.move);
    requestDraw();
    return;
  }
  game.replay = { line: line, at: 0, timer: 0 };
  game.replay.timer = setTimeout(stepReplay, 520);
}

function stepReplay() {
  const r = game.replay;
  if (!r) return;
  if (r.at >= r.line.length) {
    game.replay = null;
    ui.onLineDone();
    requestDraw();
    return;
  }
  const m = r.line[r.at++].move;
  game.lastFrom = CHESS.moveFrom(m);
  game.lastTo = CHESS.moveTo(m);
  game.pos.make(m);
  startSlide(m);
  requestDraw();
  r.timer = setTimeout(stepReplay, 700);
}

/* 6. Input */

const ARROWS = { ArrowUp: -10, ArrowDown: 10, ArrowLeft: -1, ArrowRight: 1 };

function initInput() {
  const canvas = board.canvas;
  let boxLeft = 0, boxTop = 0, boxStale = true;

  function measure() {
    const r = canvas.getBoundingClientRect();
    boxLeft = r.left;
    boxTop = r.top;
    boxStale = false;
  }

  canvas.addEventListener("pointerdown", function (e) {
    if (e.button) return;
    e.preventDefault();
    measure();
    canvas.classList.add("quiet-focus");
    canvas.focus({ preventScroll: true });
    game.cursorShown = false;
    ui.pointerUsed();
    if (game.over || busy() || game.pending) {
      if (game.over) ui.nudgeOver();
      return;
    }
    press(board.squareAt(e.clientX - boxLeft, e.clientY - boxTop));
  });

  canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  window.addEventListener("scroll", function () { boxStale = true; }, { passive: true });
  window.addEventListener("resize", function () { boxStale = true; }, { passive: true });
  canvas.addEventListener("blur", function () {
    canvas.classList.remove("quiet-focus");
    game.cursorShown = false;
    requestDraw();
  });

  canvas.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const step = ARROWS[e.key];
    if (step !== undefined) {
      canvas.classList.remove("quiet-focus");
      game.cursorShown = true;
      ui.keyUsed();
      const next = game.cursor + step;
      if (CHESS.fileOf(next) >= 0 && CHESS.fileOf(next) <= 7 &&
        CHESS.rankOf(next) >= 0 && CHESS.rankOf(next) <= 7) {
        game.cursor = next;
        ui.announceSquare(game.cursor);
      }
      requestDraw();
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      canvas.classList.remove("quiet-focus");
      game.cursorShown = true;
      ui.keyUsed();
      if (game.over || busy() || game.pending) ui.nudgeOver();
      else press(game.cursor);
      requestDraw();
      e.preventDefault();
    } else if (e.key === "Escape") {
      deselect();
      requestDraw();
      e.preventDefault();
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (k !== "u" && k !== "r" && k !== "l" && k !== "n") return;
    ui.keyUsed();
    if (k === "u") takeBack();
    else if (k === "r") ui.restart();
    else if (k === "l") ui.showLine();
    else ui.next();
    e.preventDefault();
  });
}

/* One press on a square: pick a piece up, or put it down. */
function press(sq) {
  if (sq < 0) { deselect(); requestDraw(); return; }
  const piece = game.pos.pieceAt(sq);
  if (game.selected >= 0) {
    if (sq === game.selected) { deselect(); requestDraw(); return; }
    if (game.targets.indexOf(sq) >= 0) { tryMove(game.selected, sq); requestDraw(); return; }
  }
  if (piece > 0 && !(piece & CHESS.BLACK)) {
    select(sq);
    ui.onPick(sq, piece);
  } else {
    deselect();
    if (piece > 0) ui.nudge("That is one of Black's pieces.");
  }
  requestDraw();
}

/* 7. Interface */

const ui = (function () {
  const statusEl = document.querySelector("[data-status]");
  const liveEl = document.querySelector("[data-live]");
  const tallyEl = document.querySelector("[data-tally]");
  const scoreEl = document.querySelector("[data-score]");
  const undoBtn = document.querySelector("[data-undo]");
  const resetBtn = document.querySelector("[data-reset]");
  const lineBtn = document.querySelector("[data-line]");
  const nextBtn = document.querySelector("[data-next]");
  const lineOut = document.querySelector("[data-line-out]");
  const promotionEl = document.querySelector("[data-promotion]");
  const promotionChoices = document.querySelector("[data-promotion-choices]");
  const tierButtons = Array.prototype.slice.call(document.querySelectorAll("[data-tier]"));

  let statusTimer = 0, liveTimer = 0, fromKeyboard = false;
  let solvedCount = 0, streak = 0, best = 0;

  function load() {
    const saved = readJson(localStorage, STORE_KEY) || {};
    solvedCount = saved.solved || 0;
    streak = saved.streak || 0;
    best = saved.best || 0;
    game.tier = (saved.tier === 0 || saved.tier === 1 || saved.tier === 2) ? saved.tier : 1;
    supply.restoreSeen(saved.seen);
  }

  function save() {
    writeJson(localStorage, STORE_KEY, {
      solved: solvedCount, streak: streak, best: best,
      tier: game.tier, seen: supply.seen(),
    });
  }

  function say(text, tone, sticky) {
    statusEl.textContent = text || "\u00a0";
    if (tone) statusEl.setAttribute("data-tone", tone);
    else statusEl.removeAttribute("data-tone");
    clearTimeout(statusTimer);
    if (text && !sticky) {
      statusTimer = setTimeout(function () {
        statusEl.textContent = "\u00a0";
        statusEl.removeAttribute("data-tone");
      }, 3200);
    }
  }

  function announce(text) {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(function () { liveEl.textContent = text; }, 150);
  }

  function tally() {
    if (game.solved) tallyEl.textContent = "Solved in three";
    else if (game.over) tallyEl.textContent = "Out of moves";
    else tallyEl.textContent = "Move " + Math.min(game.used + 1, MOVES_ALLOWED) +
      " of " + MOVES_ALLOWED;
    let score = solvedCount === 1 ? "1 solved" : solvedCount + " solved";
    if (streak > 1) score += " · streak " + streak;
    else if (best > 1) score += " · best " + best;
    scoreEl.textContent = score;
    scoreEl.hidden = solvedCount === 0;
    undoBtn.disabled = !game.history.length || !!game.replay;
    lineBtn.disabled = !!game.replay;
    nextBtn.disabled = !!game.replay;
  }

  function syncTiers() {
    for (let i = 0; i < tierButtons.length; i++) {
      const on = +tierButtons[i].getAttribute("data-tier") === game.tier;
      tierButtons[i].setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  function focusBoard() { board.canvas.focus({ preventScroll: true }); }

  function clearLine() {
    lineOut.hidden = true;
    lineOut.textContent = "";
  }

  function pieceWord(piece) { return PIECE_WORDS[piece & 7]; }

  function format(line) {
    let out = "";
    for (let i = 0; i < line.length; i++) {
      if (i % 2 === 0) out += (i ? "  " : "") + (i / 2 + 1) + ". ";
      out += line[i].san + (i % 2 === 0 ? " " : "");
    }
    return out.trim();
  }

  function fetchNext(preferFresh) {
    const puzzle = supply.next(game.tier, preferFresh);
    loadPuzzle(puzzle);
    save();
    clearLine();
    say("");
    announce("A new position, " + TIERS[game.tier].toLowerCase() +
      ". White to move, mate in three.");
    requestDraw();
  }

  return {
    init: function () {
      load();
      syncTiers();
      undoBtn.addEventListener("click", function () { takeBack(); });
      resetBtn.addEventListener("click", function () { ui.restart(); });
      lineBtn.addEventListener("click", function () { ui.showLine(); });
      nextBtn.addEventListener("click", function () { ui.next(); });
      for (let i = 0; i < tierButtons.length; i++) {
        tierButtons[i].addEventListener("click", function () {
          const tier = +this.getAttribute("data-tier");
          if (tier === game.tier) return;
          game.tier = tier;
          streak = 0;
          syncTiers();
          fetchNext(true);
          focusBoard();
        });
      }
      // The pool gives an instant first position; the worker takes over after.
      fetchNext(false);
      supply.start();
      requestDraw();
    },

    syncPuzzle: function () { tally(); },

    onSupply: function () { /* the shelf filled up quietly */ },

    onPick: function (sq, piece) {
      say("");
      announce("Picked up the " + pieceWord(piece) + " on " + CHESS.squareName(sq) +
        ", " + game.targets.length + " squares available.");
    },

    onWhiteMove: function (san) {
      tally();
      say("");
      announce("You played " + san + ". Black to answer.");
    },

    onBlackMove: function (san, distance) {
      tally();
      if (distance === 0) {
        say("Black is out of the net after " + san + ". Undo and try again?", "nudge", true);
        announce("Black replied " + san + ". The forced mate has gone.");
      } else {
        say("");
        announce("Black replied " + san + ". " + movesLeft() +
          (movesLeft() === 1 ? " move left." : " moves left."));
      }
    },

    onSolved: function (san) {
      solvedCount++;
      streak++;
      if (streak > best) best = streak;
      save();
      tally();
      const text = streak > 1 ? "Mate. " + san + ". " + streak + " in a row."
        : "Mate. " + san;
      say(text, "solved", true);
      announce(text + " Press N for a new one.");
      if (fromKeyboard) nextBtn.focus();
    },

    onFailed: function (why) {
      streak = 0;
      save();
      tally();
      say(why + " Undo, show the line, or take a new one.", "nudge", true);
      announce(why);
    },

    onTakeBack: function () {
      tally();
      say("");
      announce("Taken back. Move " + (game.used + 1) + " of " + MOVES_ALLOWED + ".");
    },

    onLine: function (line) {
      streak = 0;
      save();
      tally();
      lineOut.hidden = false;
      lineOut.textContent = format(line);
      say("Watch the line.", "nudge", true);
      announce("The line is " + format(line));
    },

    onLineDone: function () {
      tally();
      say("That is the line. Take a new position when you are ready.", "nudge", true);
    },

    nudge: function (text) { say(text, "nudge"); announce(text); },

    nudgeOver: function () {
      if (game.replay) return;
      if (game.solved) say("Mate already. New puzzle?", "solved", true);
      else say("Out of moves. Show the line, or take a new one.", "nudge", true);
    },

    announceSquare: function (sq) {
      const piece = game.pos.pieceAt(sq);
      announce(CHESS.squareName(sq) + (piece > 0
        ? ", " + ((piece & CHESS.BLACK) ? "black " : "white ") + pieceWord(piece)
        : ", empty"));
    },

    showPromotion: function (options) {
      promotionChoices.textContent = "";
      const order = [CHESS.QUEEN, CHESS.ROOK, CHESS.BISHOP, CHESS.KNIGHT];
      for (let i = 0; i < order.length; i++) {
        const type = order[i];
        let found = 0;
        for (let j = 0; j < options.length; j++) {
          if (CHESS.movePromo(options[j]) === type) found = options[j];
        }
        if (!found) continue;
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = GLYPHS[type];
        b.setAttribute("aria-label", PIECE_WORDS[type]);
        b.addEventListener("click", function () {
          ui.hidePromotion();
          game.pending = null;
          playWhite(found);
          requestDraw();
          focusBoard();
        });
        promotionChoices.appendChild(b);
      }
      promotionEl.hidden = false;
      const first = promotionChoices.querySelector("button");
      if (first && fromKeyboard) first.focus();
      announce("Choose what the pawn becomes.");
    },

    hidePromotion: function () {
      if (promotionEl.hidden) return;
      if (promotionEl.contains(document.activeElement)) focusBoard();
      promotionEl.hidden = true;
      promotionChoices.textContent = "";
    },

    restart: function () {
      restart();
      board.announceNewPosition();
      tally();
      clearLine();
      say("");
      announce("Back to the starting position. White to move, mate in three.");
      requestDraw();
    },

    showLine: function () { showLine(); },

    next: function () {
      if (game.replay) return;
      fetchNext(true);
      focusBoard();
    },

    keyUsed: function () { fromKeyboard = true; },
    pointerUsed: function () { fromKeyboard = false; },
  };
}());

/* 8. Frame loop */

let raf = 0, lastFrame = 0;

function frame(now) {
  const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0;
  lastFrame = now;
  board.tick(dt);
  if (board.isDirty()) board.draw();
  raf = requestAnimationFrame(frame);
}

function startLoop() {
  if (raf || reducedMotion.matches || document.hidden) return;
  lastFrame = 0;
  raf = requestAnimationFrame(frame);
}

function stopLoop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

/* Called after any change of state: the loop picks it up, or we paint now. */
function requestDraw() {
  board.markDirty();
  if (!raf) { board.tick(0); board.draw(); }
}

let resizeTimer = 0;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function () {
    board.layout();
    board.draw();
  }, 150);
}

ui.init();
initInput();

window.addEventListener("resize", onResize, { passive: true });
window.addEventListener("orientationchange", onResize, { passive: true });
document.addEventListener("visibilitychange", function () {
  if (document.hidden) {
    stopLoop();
  } else {
    startLoop();
    supply.topUp();
  }
});
if (reducedMotion.addEventListener) {
  reducedMotion.addEventListener("change", function () {
    if (reducedMotion.matches) {
      stopLoop();
      game.slide = null;
      board.tick(0);
      board.draw();
    } else {
      startLoop();
    }
  });
}

startLoop();

}());
