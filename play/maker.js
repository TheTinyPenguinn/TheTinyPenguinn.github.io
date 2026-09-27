/* maker.js: makes fresh mate-in-three positions, and proves each one before
   handing it over.

   This runs in a Web Worker, so the board never waits for it. A position is
   only sent to the page once it has passed every check below, which is the
   same set of checks the offline verifier applies to the shipped pool:

     1. legal to start from: both kings, Black not already in check, no pawn
        on the first or last rank, White to move;
     2. White forces mate in three against every legal defence;
     3. there is no mate in two and no mate in one, so "three" is exact;
     4. exactly one first move keeps the forced mate, so there is one answer;
     5. the proved line is three White moves ending in checkmate, never
        stalemate;
     6. it reads like a position rather than a scatter of pieces: the losing
        king is on an edge, and no side has two bishops on one square colour,
        which can only happen after a promotion.

   Anything that fails is thrown away and another arrangement is tried. */

importScripts("engine.js");

var MAKER = (function () {
  "use strict";

  /* Small endgame material, with and without pawns. The first group gives
     clean mating nets, the pawn sets make positions that read like endgames. */
  const MATERIAL = [
    ["Q", ""], ["R", ""], ["QN", ""], ["RB", ""], ["RN", ""], ["RR", ""],
    ["BB", ""], ["QN", "p"], ["RB", "p"], ["RN", "p"], ["Q", "r"], ["Q", "n"],
    ["R", "p"], ["RP", "p"], ["QB", "r"], ["NNB", ""], ["QR", "q"], ["BN", "p"],
    ["RP", "pp"], ["QP", "pp"], ["RR", "pp"], ["QN", "pp"], ["RB", "pp"],
    ["RNP", "pp"], ["BBP", "p"], ["RPP", "pp"], ["NNP", "p"], ["QB", "pp"],
    ["RN", "pp"], ["QNP", "pp"], ["RBP", "pp"], ["Q", "rp"], ["R", "bp"],
    ["RR", "rp"], ["Q", "np"],
  ];

  const pos = CHESS.create();

  // Seeded from the clock so two visitors do not walk the same sequence.
  let seed = (Date.now() ^ 0x5bf03635) | 1;
  function rnd(n) {
    seed ^= seed << 13; seed |= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed |= 0;
    return (seed >>> 0) % n;
  }

  /* A random arrangement, or null if it could not be laid out sanely. */
  function arrange(white, black) {
    const used = {};
    const place = {};
    function pick(edgeBias) {
      for (let tries = 0; tries < 40; tries++) {
        let f = rnd(8), r = rnd(8) + 1;
        if (edgeBias && rnd(3) === 0) {
          if (rnd(2)) r = rnd(2) ? 8 : 1; else f = rnd(2) ? 7 : 0;
        }
        const k = f + "," + r;
        if (!used[k]) { used[k] = 1; return { f: f, r: r, k: k }; }
      }
      return null;
    }
    const bk = pick(true);
    const wk = pick(false);
    if (!bk || !wk) return null;
    // kings may never stand next to each other
    if (Math.abs(bk.f - wk.f) <= 1 && Math.abs(bk.r - wk.r) <= 1) return null;
    place[bk.k] = "k";
    place[wk.k] = "K";
    for (let i = 0; i < white.length; i++) {
      const s = pick(false);
      if (!s) return null;
      if (white[i] === "P" && (s.r === 1 || s.r === 8)) return null;
      place[s.k] = white[i];
    }
    for (let i = 0; i < black.length; i++) {
      const s = pick(false);
      if (!s) return null;
      if (black[i] === "p" && (s.r === 1 || s.r === 8)) return null;
      place[s.k] = black[i];
    }
    let board = "";
    for (let r = 8; r >= 1; r--) {
      let run = 0;
      for (let f = 0; f < 8; f++) {
        const p = place[f + "," + r];
        if (!p) { run++; continue; }
        if (run) { board += run; run = 0; }
        board += p;
      }
      if (run) board += run;
      if (r > 1) board += "/";
    }
    return board;
  }

  /* Cheap tests first: a mating net means a boxed-in king and a check to hand.
     Without these the exhaustive search would be run on hopeless positions. */
  function worthSearching() {
    if (pos.inCheck(CHESS.BLACK)) return false;
    const white = pos.legalMoves();
    if (!white.length) return false;
    let checks = 0;
    for (let i = 0; i < white.length; i++) {
      pos.make(white[i]);
      if (pos.inCheck(CHESS.BLACK)) checks++;
      pos.unmake();
      if (checks) break;
    }
    return checks > 0;
  }

  function blackReplies(board) {
    const probe = CHESS.create();
    probe.setFen(board + " b - - 0 1");
    return probe.legalMoves().length;
  }

  /* Bishops of one colour on the same square colour only arise from a
     promotion, and the losing king belongs on an edge. */
  function looksRight() {
    const counts = { 0: 0, 8: 0 };
    const colours = { 0: -1, 8: -1 };
    let odd = false;
    for (let sq = 21; sq <= 98; sq++) {
      const p = pos.pieceAt(sq);
      if (p <= 0 || (p & 7) !== CHESS.BISHOP) continue;
      const side = p & 8;
      counts[side]++;
      if (counts[side] > 2) return false;
      const colour = (CHESS.fileOf(sq) + CHESS.rankOf(sq)) & 1;
      if (colours[side] < 0) colours[side] = colour;
      else if (colours[side] === colour) odd = true;
    }
    if (odd) return false;
    const k = pos.kingSquare(CHESS.BLACK);
    const f = CHESS.fileOf(k), r = CHESS.rankOf(k);
    return f === 0 || f === 7 || r === 0 || r === 7;
  }

  /* The proved line, and a check that it really ends in mate. */
  function provedLine(fen) {
    pos.setFen(fen);
    const sans = [];
    let remaining = 3;
    for (let i = 0; i < 6; i++) {
      const keys = pos.matingMoves(remaining, 0);
      if (!keys.length) return null;
      sans.push(pos.toSan(keys[0]));
      pos.make(keys[0]);
      if (pos.isCheckmate()) break;
      if (pos.isStalemate()) return null;
      const answer = pos.bestDefence(remaining - 1, 0);
      if (!answer.move || answer.distance === 0) return null;
      sans.push(pos.toSan(answer.move));
      pos.make(answer.move);
      remaining = answer.distance;
    }
    if (sans.length !== 5) return null;
    if (!/#$/.test(sans[4])) return null;
    return sans;
  }

  function tierOf(whiteMoves, replies, quiet, pieces, allChecks) {
    const score = whiteMoves + replies * 2 + (quiet ? 8 : 0) + pieces;
    if (allChecks || score <= 34) return 0;
    if (score <= 45) return 1;
    return 2;
  }

  /* Forcing lines come from thin material, so a gentle position is looked for
     among the smaller sets and with a cap on how much choice White has. Left
     open, the search overwhelmingly turns up tough ones. */
  const SMALL = MATERIAL.slice(0, 8);
  const CHOICE_CAP = [26, 34, 99];

  /* One attempt at the asked-for tier. Returns a finished puzzle or null. */
  function attempt(tier) {
    const sets = tier === 0 ? SMALL : MATERIAL;
    const spec = sets[rnd(sets.length)];
    const board = arrange(spec[0], spec[1]);
    if (!board) return null;
    const fen = board + " w - - 0 1";
    try {
      pos.setFen(fen);
    } catch (e) {
      return null;
    }
    if (!worthSearching()) return null;
    pos.setFen(fen);
    if (!looksRight()) return null;

    const replies = blackReplies(board);
    if (replies < 2 || replies > 7) return null;        // not forced, not open

    pos.setFen(fen);
    const choices = pos.legalMoves().length;
    if (choices > CHOICE_CAP[tier]) return null;        // cheap, so do it early

    // exact: mate in three, and no faster mate
    pos.setFen(fen);
    if (pos.mateIn(1, 0)) return null;
    pos.setFen(fen);
    if (pos.mateIn(2, 0)) return null;
    pos.setFen(fen);
    if (!pos.mateIn(3, 0)) return null;

    // one answer only
    pos.setFen(fen);
    const keys = pos.matingMoves(3, 0);
    if (keys.length !== 1) return null;
    pos.setFen(fen);
    const keySan = pos.toSan(keys[0]);

    const line = provedLine(fen);
    if (!line) return null;

    const pieces = (board.match(/[a-zA-Z]/g) || []).length;
    const quiet = !/[+#]/.test(keySan);
    const allChecks = /[+#]/.test(line[0]) && /[+#]/.test(line[2]);

    return {
      board: board,
      tier: tierOf(choices, replies, quiet, pieces, allChecks),
      line: line,
    };
  }

  return {
    /* Keeps trying until it has `want` puzzles for `tier` or the budget runs
       out, sending each one over the moment it is proved. A position of another
       tier is still worth having, so it goes over too and simply lands on a
       different shelf. */
    run: function (tier, want, budgetMs) {
      const until = Date.now() + budgetMs;
      const asked = Math.max(0, Math.min(2, tier | 0));
      let made = 0, tries = 0, wanted = 0;
      while (wanted < want && Date.now() < until) {
        tries++;
        const puzzle = attempt(asked);
        if (!puzzle) continue;
        made++;
        if (puzzle.tier === asked) wanted++;
        postMessage({
          type: "puzzle",
          board: puzzle.board,
          tier: puzzle.tier,
          line: puzzle.line,
          tries: tries,
        });
      }
      postMessage({ type: "done", tier: asked, made: made, tries: tries });
    },
  };
}());

onmessage = function (e) {
  const msg = e.data || {};
  if (msg.type !== "make") return;
  MAKER.run(msg.tier || 0, msg.want || 1, msg.budgetMs || 8000);
};
