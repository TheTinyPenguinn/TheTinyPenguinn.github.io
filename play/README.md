# Mate in Three

A chess puzzle in its own folder, and a different one every time the page is
opened. You play White; there is a forced mate in three, and Black answers with
the defence that holds out longest.

Plain HTML, CSS and vanilla JavaScript: no build step, no dependencies, no
network requests, no images. Pieces are Unicode glyphs drawn into a `<canvas>`.

    play/
      index.html   markup and copy
      game.css     the site's tokens, header and footer, then this page's layout
      engine.js    the rules of chess, and the forced-mate search
      puzzles.js   150 positions, proved in advance, for an instant first load
      maker.js     a worker that makes and proves fresh positions as you play
      game.js      board, input, and the run of play

## Run it locally

    cd play
    python3 -m http.server 8492

Then open <http://127.0.0.1:8492/>. To try it on a phone on the same Wi-Fi,
serve from the repository root instead and visit
`http://<your-computer's-IP>:8000/play/`.

A worker needs a server: opening `index.html` straight off the disk still
plays, using the built-in 150, but it cannot make new ones.

## How it sits in the site

It is the second entry under Work in the site's `index.html`, linked as
`play/`.

- **The sky** is the site's own. The page loads `../main.js`, which draws the
  same starfield as every other page and carries it across navigation, dimmed
  as it is on posts (`<body data-sky="quiet">`). `game.js` draws only the board,
  and is wrapped in one function so its names never collide with `main.js`.
- **The page transition** is the site's dissolve, repeated in `game.css`.
  Both pages must opt in for the browser to run it.
- **The look.** `game.css` repeats the site's tokens, header, footer and link
  styles rather than loading `style.css`, whose layout rules would fight the
  game's. If you change the site's accent or background, change it here too:
  the tokens are at the top of `game.css`, and `BOARD.accentRgb` near the top
  of `game.js`.

Moved out of the site, the page still plays; it just has no sky.

## Where the puzzles come from

`puzzles.js` holds 150 positions across three difficulty tiers, every one proved
before it was written down. That is only the head start: `maker.js` runs in a
Web Worker and keeps making fresh ones while you play, so the supply does not
run out and coming back tomorrow does not mean the same puzzles. Which one you
see is remembered in `localStorage`, so a refresh always brings a position you
have not had.

Nothing reaches the board until it has passed every check in the list below.
The worker applies exactly the same ones the offline verifier does.

## Correctness

`engine.js` has no DOM in it, so the same file that runs in the browser runs in
Node. That is how everything here is checked.

**Move generation** is measured with *perft*, which counts every legal move
sequence to a given depth. The counts match the published figures for five
standard test positions, including 4,865,609 at depth five from the opening and
4,085,603 at depth four from "Kiwipete", the position people use because it
exercises castling, en passant, promotion and pins at once.

**Cross-checked** against `chess.js`, an independent implementation: 29,054
positions from 440 random games, comparing the full legal-move list, the
algebraic notation of every move, and checkmate and stalemate detection.
Everything matched.

**Every position**, shipped or freshly made, is proved by exhaustive search:

1. it is legal to start from: both kings, Black not already in check, no pawn
   on the first or last rank, White to move;
2. White forces mate in three against every legal defence;
3. there is no mate in two and no mate in one, so "three" is exact;
4. exactly one first move keeps the forced mate, so there is one answer;
5. the line shown is legal throughout and ends in checkmate;
6. it reads like a position, not a scatter: the losing king is on an edge, and
   neither side has two bishops on one square colour, which can only happen
   after a promotion.

The search counts stalemate as a failure rather than a win, so no puzzle can be
"solved" by leaving Black with no legal move. Anything that fails a check is
thrown away rather than patched.

## Tuning

`BOARD`, at the top of `game.js`, sets square shading, piece size, the glow on
a White piece, and every motion timing: how long a piece takes to slide, how
fast highlights come and go, and how a fresh position blooms outward from the
middle of the board.

`maker.js` has its own `MATERIAL` list of endgame material to try, and
`CHOICE_CAP`, which is what keeps the gentle tier gentle: forcing lines come
from thin material and few choices.

## How it behaves

- One `requestAnimationFrame` loop drives the board, with delta-time
  animation, and it stops while the tab is hidden. The sky runs on the site's
  own loop in `main.js`.
- `devicePixelRatio` is capped at 2. Colour strings and fonts are built on
  layout, so no frame allocates.
- The puzzle maker runs in a worker, so the board never waits for it. It stops
  once a couple of positions are in hand, and while the tab is hidden.
- `prefers-reduced-motion: reduce` turns the loop off: pieces appear instead of sliding, and "show the line" jumps to the mate.
- Your score is one small JSON blob in `localStorage` under `mateinthree.v2`.
- Touch and mouse: tap a piece, tap a square. Keyboard: arrows to move about
  the board, Enter to pick up and put down, `U` undo, `R` reset, `L` show the
  line, `N` for a new position.
- The chess glyphs come from whatever symbol font the system has. If none has
  them, the board falls back to letters rather than showing empty boxes.
