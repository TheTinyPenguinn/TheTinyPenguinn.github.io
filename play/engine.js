/* engine.js: the rules of chess, and a forced-mate search.

   No DOM here on purpose: this file runs unchanged in Node, which is how the
   puzzle set is proved correct. See README.md.

   Board: the 10x12 mailbox. Squares 21..98 are real (21 = a8, 98 = h1) and
   everything else holds OFF, so a piece can step off the edge without a
   bounds test. Pieces: type in the low three bits, colour in bit three.
   Moves: one int: from | to<<7 | promotion<<14 | flag<<17. */

var CHESS = (function () {
  "use strict";

  /* 1. Constants */

  const OFF = -1, EMPTY = 0;
  const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
  const WHITE = 0, BLACK = 8;

  const NORMAL = 0, DOUBLE = 1, EPCAP = 2, CASTLE = 3;

  const MAX_PLY = 48;
  const MAX_MOVES = 256;
  const MAX_HIST = 512;

  const KNIGHT_STEPS = [-21, -19, -12, -8, 8, 12, 19, 21];
  const KING_STEPS = [-11, -10, -9, -1, 1, 9, 10, 11];
  const BISHOP_RAYS = [-11, -9, 9, 11];
  const ROOK_RAYS = [-10, -1, 1, 10];
  const QUEEN_RAYS = KING_STEPS;

  const CHAR_TO_PIECE = {
    P: PAWN, N: KNIGHT, B: BISHOP, R: ROOK, Q: QUEEN, K: KING,
    p: PAWN | BLACK, n: KNIGHT | BLACK, b: BISHOP | BLACK,
    r: ROOK | BLACK, q: QUEEN | BLACK, k: KING | BLACK,
  };
  const TYPE_TO_CHAR = [".", "P", "N", "B", "R", "Q", "K"];
  const FILES = "abcdefgh";

  // Castling rights: 1 white short, 2 white long, 4 black short, 8 black long.
  // Moving from or onto one of these squares takes rights away.
  const RIGHTS_MASK = new Int8Array(120).fill(15);
  RIGHTS_MASK[95] = 12;   // e1, the white king
  RIGHTS_MASK[98] = 14;   // h1
  RIGHTS_MASK[91] = 13;   // a1
  RIGHTS_MASK[25] = 3;    // e8, the black king
  RIGHTS_MASK[28] = 11;   // h8
  RIGHTS_MASK[21] = 7;    // a8

  function fileOf(sq) { return (sq % 10) - 1; }
  function rankOf(sq) { return ((sq - sq % 10) / 10) - 2; }   // 0 = rank 8
  function squareName(sq) { return FILES[fileOf(sq)] + (8 - rankOf(sq)); }
  function squareFrom(name) {
    return 21 + (8 - +name[1]) * 10 + FILES.indexOf(name[0]);
  }

  function move(from, to, promo, flag) {
    return from | (to << 7) | ((promo || 0) << 14) | ((flag || 0) << 17);
  }
  function moveFrom(m) { return m & 127; }
  function moveTo(m) { return (m >> 7) & 127; }
  function movePromo(m) { return (m >> 14) & 7; }
  function moveFlag(m) { return (m >> 17) & 7; }

  /* 2. A position */

  function create() {
    const board = new Int8Array(120).fill(OFF);
    const kingSq = new Int16Array(2);
    let side = WHITE;
    let rights = 0;
    let ep = 0;                       // the square a pawn could be taken on

    // undo stack, allocated once
    const hFrom = new Int16Array(MAX_HIST);
    const hTo = new Int16Array(MAX_HIST);
    const hPiece = new Int8Array(MAX_HIST);
    const hCap = new Int8Array(MAX_HIST);
    const hCapSq = new Int16Array(MAX_HIST);
    const hFlag = new Int8Array(MAX_HIST);
    const hRights = new Int8Array(MAX_HIST);
    const hEp = new Int16Array(MAX_HIST);
    let depth = 0;

    // move lists, one slice per ply, allocated once
    const pool = new Int32Array(MAX_PLY * MAX_MOVES);
    const scores = new Int32Array(MAX_MOVES);
    let nodes = 0;

    /* 3. Attacks */

    /* Is `sq` attacked by any piece of colour `by`? */
    function attacked(sq, by) {
      if (by === WHITE) {
        if (board[sq + 9] === PAWN || board[sq + 11] === PAWN) return true;
      } else {
        if (board[sq - 9] === (PAWN | BLACK) || board[sq - 11] === (PAWN | BLACK)) return true;
      }
      const knight = KNIGHT | by, king = KING | by;
      for (let i = 0; i < 8; i++) {
        if (board[sq + KNIGHT_STEPS[i]] === knight) return true;
        if (board[sq + KING_STEPS[i]] === king) return true;
      }
      const bishop = BISHOP | by, rook = ROOK | by, queen = QUEEN | by;
      for (let i = 0; i < 4; i++) {
        const d = BISHOP_RAYS[i];
        for (let t = sq + d; ; t += d) {
          const p = board[t];
          if (p === EMPTY) continue;
          if (p === bishop || p === queen) return true;
          break;
        }
      }
      for (let i = 0; i < 4; i++) {
        const d = ROOK_RAYS[i];
        for (let t = sq + d; ; t += d) {
          const p = board[t];
          if (p === EMPTY) continue;
          if (p === rook || p === queen) return true;
          break;
        }
      }
      return false;
    }

    function inCheck(colour) {
      return attacked(kingSq[colour >> 3], colour ^ BLACK);
    }

    /* 4. Move generation */

    /* Fills this ply's slice with pseudo-legal moves and returns how many.
       Pseudo-legal means "obeys how the piece moves"; leaving your own king
       in check is weeded out when the move is made. */
    function generate(ply) {
      const base = ply * MAX_MOVES;
      const us = side, them = us ^ BLACK;
      let n = 0;

      for (let sq = 21; sq <= 98; sq++) {
        const p = board[sq];
        if (p <= EMPTY || (p & BLACK) !== us) continue;
        const type = p & 7;

        if (type === PAWN) {
          const up = us === WHITE ? -10 : 10;
          const homeRank = us === WHITE ? 6 : 1;
          const lastRank = us === WHITE ? 0 : 7;
          const one = sq + up;
          if (board[one] === EMPTY) {
            if (rankOf(one) === lastRank) {
              pool[base + n++] = move(sq, one, QUEEN, NORMAL);
              pool[base + n++] = move(sq, one, ROOK, NORMAL);
              pool[base + n++] = move(sq, one, BISHOP, NORMAL);
              pool[base + n++] = move(sq, one, KNIGHT, NORMAL);
            } else {
              pool[base + n++] = move(sq, one, 0, NORMAL);
              if (rankOf(sq) === homeRank && board[sq + 2 * up] === EMPTY) {
                pool[base + n++] = move(sq, sq + 2 * up, 0, DOUBLE);
              }
            }
          }
          for (let s = -1; s <= 1; s += 2) {
            const t = sq + up + s;
            const q = board[t];
            if (q > EMPTY && (q & BLACK) === them) {
              if (rankOf(t) === lastRank) {
                pool[base + n++] = move(sq, t, QUEEN, NORMAL);
                pool[base + n++] = move(sq, t, ROOK, NORMAL);
                pool[base + n++] = move(sq, t, BISHOP, NORMAL);
                pool[base + n++] = move(sq, t, KNIGHT, NORMAL);
              } else {
                pool[base + n++] = move(sq, t, 0, NORMAL);
              }
            } else if (q === EMPTY && ep !== 0 && t === ep) {
              pool[base + n++] = move(sq, t, 0, EPCAP);
            }
          }
          continue;
        }

        if (type === KNIGHT || type === KING) {
          const steps = type === KNIGHT ? KNIGHT_STEPS : KING_STEPS;
          for (let i = 0; i < 8; i++) {
            const t = sq + steps[i];
            const q = board[t];
            if (q === OFF) continue;
            if (q === EMPTY || (q & BLACK) === them) {
              pool[base + n++] = move(sq, t, 0, NORMAL);
            }
          }
          continue;
        }

        const rays = type === BISHOP ? BISHOP_RAYS
          : type === ROOK ? ROOK_RAYS : QUEEN_RAYS;
        for (let i = 0; i < rays.length; i++) {
          const d = rays[i];
          for (let t = sq + d; ; t += d) {
            const q = board[t];
            if (q === OFF) break;
            if (q === EMPTY) { pool[base + n++] = move(sq, t, 0, NORMAL); continue; }
            if ((q & BLACK) === them) pool[base + n++] = move(sq, t, 0, NORMAL);
            break;
          }
        }
      }

      // Castling: the king may not start, cross or land on an attacked square.
      if (us === WHITE) {
        if ((rights & 1) && board[95] === KING && board[98] === ROOK &&
          board[96] === EMPTY && board[97] === EMPTY &&
          !attacked(95, BLACK) && !attacked(96, BLACK) && !attacked(97, BLACK)) {
          pool[base + n++] = move(95, 97, 0, CASTLE);
        }
        if ((rights & 2) && board[95] === KING && board[91] === ROOK &&
          board[94] === EMPTY && board[93] === EMPTY && board[92] === EMPTY &&
          !attacked(95, BLACK) && !attacked(94, BLACK) && !attacked(93, BLACK)) {
          pool[base + n++] = move(95, 93, 0, CASTLE);
        }
      } else {
        const bk = KING | BLACK, br = ROOK | BLACK;
        if ((rights & 4) && board[25] === bk && board[28] === br &&
          board[26] === EMPTY && board[27] === EMPTY &&
          !attacked(25, WHITE) && !attacked(26, WHITE) && !attacked(27, WHITE)) {
          pool[base + n++] = move(25, 27, 0, CASTLE);
        }
        if ((rights & 8) && board[25] === bk && board[21] === br &&
          board[24] === EMPTY && board[23] === EMPTY && board[22] === EMPTY &&
          !attacked(25, WHITE) && !attacked(24, WHITE) && !attacked(23, WHITE)) {
          pool[base + n++] = move(25, 23, 0, CASTLE);
        }
      }
      return n;
    }

    /* 5. Make and unmake */

    function make(m) {
      const from = m & 127, to = (m >> 7) & 127;
      const promo = (m >> 14) & 7, flag = (m >> 17) & 7;
      const p = board[from];
      let capSq = 0, cap = EMPTY;
      if (flag === EPCAP) {
        capSq = side === WHITE ? to + 10 : to - 10;
        cap = board[capSq];
      } else if (board[to] !== EMPTY) {
        capSq = to;
        cap = board[to];
      }

      hFrom[depth] = from; hTo[depth] = to; hPiece[depth] = p;
      hCap[depth] = cap; hCapSq[depth] = capSq; hFlag[depth] = flag;
      hRights[depth] = rights; hEp[depth] = ep;
      depth++;

      if (capSq !== 0) board[capSq] = EMPTY;
      board[from] = EMPTY;
      board[to] = promo ? (promo | (p & BLACK)) : p;

      if ((p & 7) === KING) {
        kingSq[(p & BLACK) >> 3] = to;
        if (flag === CASTLE) {
          if (to === 97) { board[96] = board[98]; board[98] = EMPTY; }
          else if (to === 93) { board[94] = board[91]; board[91] = EMPTY; }
          else if (to === 27) { board[26] = board[28]; board[28] = EMPTY; }
          else if (to === 23) { board[24] = board[21]; board[21] = EMPTY; }
        }
      }

      rights &= RIGHTS_MASK[from] & RIGHTS_MASK[to];
      ep = flag === DOUBLE ? (from + to) >> 1 : 0;
      side ^= BLACK;
    }

    function unmake() {
      depth--;
      const from = hFrom[depth], to = hTo[depth], p = hPiece[depth];
      const cap = hCap[depth], capSq = hCapSq[depth], flag = hFlag[depth];
      side ^= BLACK;
      rights = hRights[depth];
      ep = hEp[depth];

      board[to] = EMPTY;
      board[from] = p;
      if (capSq !== 0) board[capSq] = cap;

      if ((p & 7) === KING) {
        kingSq[(p & BLACK) >> 3] = from;
        if (flag === CASTLE) {
          if (to === 97) { board[98] = board[96]; board[96] = EMPTY; }
          else if (to === 93) { board[91] = board[94]; board[94] = EMPTY; }
          else if (to === 27) { board[28] = board[26]; board[26] = EMPTY; }
          else if (to === 23) { board[21] = board[24]; board[24] = EMPTY; }
        }
      }
    }

    /* 6. Terminal states */

    function hasLegalMove(ply) {
      const base = ply * MAX_MOVES;
      const count = generate(ply);
      const us = side;
      for (let i = 0; i < count; i++) {
        make(pool[base + i]);
        const legal = !attacked(kingSq[us >> 3], side);
        unmake();
        if (legal) return true;
      }
      return false;
    }

    /* All legal moves as a plain array. For the interface, not the search. */
    function legalMoves(ply) {
      const p = ply === undefined ? MAX_PLY - 4 : ply;
      const base = p * MAX_MOVES;
      const count = generate(p);
      const us = side;
      const out = [];
      for (let i = 0; i < count; i++) {
        const m = pool[base + i];
        make(m);
        if (!attacked(kingSq[us >> 3], side)) out.push(m);
        unmake();
      }
      return out;
    }

    function isCheckmate() { return inCheck(side) && !hasLegalMove(MAX_PLY - 3); }
    function isStalemate() { return !inCheck(side) && !hasLegalMove(MAX_PLY - 3); }

    /* 7. FEN */

    function setFen(fen) {
      board.fill(OFF);
      for (let r = 0; r < 8; r++) {
        for (let f = 0; f < 8; f++) board[21 + r * 10 + f] = EMPTY;
      }
      const parts = fen.trim().split(/\s+/);
      const rows = parts[0].split("/");
      if (rows.length !== 8) throw new Error("bad FEN: " + fen);
      for (let r = 0; r < 8; r++) {
        let f = 0;
        for (let i = 0; i < rows[r].length; i++) {
          const ch = rows[r][i];
          if (ch >= "1" && ch <= "8") { f += +ch; continue; }
          const piece = CHAR_TO_PIECE[ch];
          if (piece === undefined) throw new Error("bad FEN piece: " + ch);
          board[21 + r * 10 + f] = piece;
          f++;
        }
        if (f !== 8) throw new Error("bad FEN rank: " + rows[r]);
      }
      side = parts[1] === "b" ? BLACK : WHITE;
      rights = 0;
      if (parts[2] && parts[2] !== "-") {
        if (parts[2].indexOf("K") >= 0) rights |= 1;
        if (parts[2].indexOf("Q") >= 0) rights |= 2;
        if (parts[2].indexOf("k") >= 0) rights |= 4;
        if (parts[2].indexOf("q") >= 0) rights |= 8;
      }
      ep = parts[3] && parts[3] !== "-" ? squareFrom(parts[3]) : 0;
      depth = 0;
      kingSq[0] = 0; kingSq[1] = 0;
      for (let sq = 21; sq <= 98; sq++) {
        if (board[sq] === KING) kingSq[0] = sq;
        else if (board[sq] === (KING | BLACK)) kingSq[1] = sq;
      }
      if (!kingSq[0] || !kingSq[1]) throw new Error("FEN needs both kings: " + fen);
    }

    function fen() {
      let out = "";
      for (let r = 0; r < 8; r++) {
        let run = 0;
        for (let f = 0; f < 8; f++) {
          const p = board[21 + r * 10 + f];
          if (p === EMPTY) { run++; continue; }
          if (run) { out += run; run = 0; }
          const ch = TYPE_TO_CHAR[p & 7];
          out += (p & BLACK) ? ch.toLowerCase() : ch;
        }
        if (run) out += run;
        if (r < 7) out += "/";
      }
      out += side === WHITE ? " w " : " b ";
      let c = "";
      if (rights & 1) c += "K";
      if (rights & 2) c += "Q";
      if (rights & 4) c += "k";
      if (rights & 8) c += "q";
      out += c || "-";
      out += " " + (ep ? squareName(ep) : "-");
      return out;
    }

    /* 8. Move notation */

    function toSan(m) {
      const from = moveFrom(m), to = moveTo(m);
      const promo = movePromo(m), flag = moveFlag(m);
      const p = board[from], type = p & 7;
      let s;

      if (flag === CASTLE) {
        s = fileOf(to) === 6 ? "O-O" : "O-O-O";
      } else if (type === PAWN) {
        const captures = board[to] !== EMPTY || flag === EPCAP;
        s = captures ? FILES[fileOf(from)] + "x" + squareName(to) : squareName(to);
        if (promo) s += "=" + TYPE_TO_CHAR[promo];
      } else {
        s = TYPE_TO_CHAR[type];
        if (type !== KING) {
          // Name the file, the rank, or both, but only when another piece of
          // the same kind could also go there.
          const rivals = [];
          const all = legalMoves(MAX_PLY - 6);
          for (let i = 0; i < all.length; i++) {
            const o = all[i];
            if (moveTo(o) !== to || moveFrom(o) === from) continue;
            if ((board[moveFrom(o)] & 7) === type) rivals.push(moveFrom(o));
          }
          if (rivals.length) {
            let sameFile = false, sameRank = false;
            for (let i = 0; i < rivals.length; i++) {
              if (fileOf(rivals[i]) === fileOf(from)) sameFile = true;
              if (rankOf(rivals[i]) === rankOf(from)) sameRank = true;
            }
            if (!sameFile) s += FILES[fileOf(from)];
            else if (!sameRank) s += 8 - rankOf(from);
            else s += squareName(from);
          }
        }
        if (board[to] !== EMPTY) s += "x";
        s += squareName(to);
      }

      make(m);
      const check = inCheck(side);
      const stuck = !hasLegalMove(MAX_PLY - 2);
      unmake();
      if (check) s += stuck ? "#" : "+";
      return s;
    }

    /* 9. Forced-mate search
       mateIn(n): the side to move can force mate in at most n of its own
       moves, against every defence. Stalemate counts as a failure, not a win,
       so a "mate" that lets the defender run out of legal moves is rejected. */

    /* Checks first, then captures and promotions: a mate search lives or dies
       on this ordering. */
    function order(base, count, ply) {
      const us = side;
      for (let i = 0; i < count; i++) {
        const m = pool[base + i];
        let s = 0;
        make(m);
        if (!attacked(kingSq[us >> 3], side)) {
          if (inCheck(side)) s += 1000;
          s += movePromo(m) ? 40 : 0;
        } else {
          s = -1000;                       // illegal, sink it
        }
        unmake();
        if (board[moveTo(m)] !== EMPTY) s += 20;
        scores[i] = s;
      }
      for (let i = 1; i < count; i++) {
        const m = pool[base + i], s = scores[i];
        let j = i - 1;
        while (j >= 0 && scores[j] < s) {
          pool[base + j + 1] = pool[base + j];
          scores[j + 1] = scores[j];
          j--;
        }
        pool[base + j + 1] = m;
        scores[j + 1] = s;
      }
    }

    function mateIn(n, ply) {
      if (n < 1 || ply + 2 >= MAX_PLY) return false;
      const base = ply * MAX_MOVES;
      const count = generate(ply);
      if (n > 1) order(base, count, ply);
      const us = side;
      for (let i = 0; i < count; i++) {
        const m = pool[base + i];
        make(m);
        if (attacked(kingSq[us >> 3], side)) { unmake(); continue; }
        nodes++;
        let won;
        if (!hasLegalMove(ply + 1)) {
          won = inCheck(side);              // no reply and in check: mate
        } else {
          won = n > 1 && everyReplyLoses(n, ply + 1);
        }
        unmake();
        if (won) return true;
      }
      return false;
    }

    function everyReplyLoses(n, ply) {
      const base = ply * MAX_MOVES;
      const count = generate(ply);
      const us = side;
      let any = false;
      for (let i = 0; i < count; i++) {
        const m = pool[base + i];
        make(m);
        if (attacked(kingSq[us >> 3], side)) { unmake(); continue; }
        any = true;
        const lost = mateIn(n - 1, ply + 1);
        unmake();
        if (!lost) return false;
      }
      return any;
    }

    /* The smallest n up to `max` for which the side to move forces mate,
       or 0 if there is none. */
    function mateDistance(max, ply) {
      const p = ply || 0;
      for (let n = 1; n <= max; n++) if (mateIn(n, p)) return n;
      return 0;
    }

    /* Every first move that forces mate in at most n. */
    function matingMoves(n, ply) {
      const p = ply || 0;
      const all = legalMoves(MAX_PLY - 8);
      const out = [];
      for (let i = 0; i < all.length; i++) {
        make(all[i]);
        let ok;
        if (!hasLegalMove(p + 1)) ok = inCheck(side);
        else ok = n > 1 && everyReplyLoses(n, p + 1);
        unmake();
        if (ok) out.push(all[i]);
      }
      return out;
    }

    /* The defence that holds out longest, and how long that is. A distance of
       0 means this side escapes the mate altogether. Ties go to a capture,
       then to the first move generated, so the answer never wobbles. */
    function bestDefence(max, ply) {
      const p = ply || 0;
      const all = legalMoves(MAX_PLY - 10);
      let best = 0, bestScore = -1, bestDistance = 0;
      for (let i = 0; i < all.length; i++) {
        const m = all[i];
        const capture = board[moveTo(m)] !== EMPTY;
        make(m);
        const d = mateDistance(max, p + 1);
        unmake();
        const score = (d === 0 ? 1000 : d) * 10 + (capture ? 1 : 0);
        if (score > bestScore) { bestScore = score; best = m; bestDistance = d; }
      }
      return { move: best, distance: bestDistance };
    }

    return {
      // reading the position
      board: board,
      side: function () { return side; },
      rights: function () { return rights; },
      epSquare: function () { return ep; },
      kingSquare: function (colour) { return kingSq[colour >> 3]; },
      pieceAt: function (sq) { return board[sq]; },
      fen: fen,
      setFen: setFen,
      // moving
      legalMoves: legalMoves,
      make: make,
      unmake: unmake,
      historyDepth: function () { return depth; },
      // state of play
      inCheck: inCheck,
      attacked: attacked,
      isCheckmate: isCheckmate,
      isStalemate: isStalemate,
      toSan: toSan,
      // search
      mateIn: mateIn,
      mateDistance: mateDistance,
      matingMoves: matingMoves,
      bestDefence: bestDefence,
      nodes: function () { return nodes; },
      resetNodes: function () { nodes = 0; },
      // 10. Perft: the yardstick for move generation
      perft: function perft(d, ply) {
        const p = ply || 0;
        if (d === 0) return 1;
        const base = p * MAX_MOVES;
        const count = generate(p);
        const us = side;
        let total = 0;
        for (let i = 0; i < count; i++) {
          make(pool[base + i]);
          if (!attacked(kingSq[us >> 3], side)) total += this.perft(d - 1, p + 1);
          unmake();
        }
        return total;
      },
    };
  }

  return {
    create: create,
    WHITE: WHITE, BLACK: BLACK,
    PAWN: PAWN, KNIGHT: KNIGHT, BISHOP: BISHOP,
    ROOK: ROOK, QUEEN: QUEEN, KING: KING,
    EMPTY: EMPTY, OFF: OFF,
    moveFrom: moveFrom, moveTo: moveTo, movePromo: movePromo, moveFlag: moveFlag,
    CASTLE: CASTLE, EPCAP: EPCAP, DOUBLE: DOUBLE,
    fileOf: fileOf, rankOf: rankOf,
    squareName: squareName, squareFrom: squareFrom,
  };
}());

if (typeof module !== "undefined" && module.exports) module.exports = CHESS;
