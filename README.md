# TheTinyPenguinn.github.io

My personal website: plain HTML, CSS and vanilla JavaScript. There's no build step, no framework, no npm and no external requests. Edit a file, refresh the page, and push to publish.

```
index.html        Home: hero, about, work, thoughts, events, play, contact
style.css         All styles, in numbered, commented sections
main.js           Starfield, reveal-on-scroll, reading time
posts/            One HTML file per post (+ template.html to copy)
play/             Mate in Three, the chess puzzle (see play/README.md)
404.html          Served by GitHub Pages for missing pages
.nojekyll         Tells GitHub Pages to serve files as-is
```

## Run it locally

```sh
cd TheTinyPenguinn.github.io
python3 -m http.server 8000
```

Open <http://localhost:8000>.

**To view it on your phone:** keep the phone on the same Wi-Fi as your computer, then find your computer's local IP address:

- macOS: `ipconfig getifaddr en0`
- Linux: `hostname -I`
- Windows: `ipconfig` (look for "IPv4 Address")

On the phone, open `http://<that-ip>:8000`, for example `http://192.168.1.23:8000`. If it doesn't load, allow Python through your firewall when prompted. To make the server reachable from other devices you can also run `python3 -m http.server 8000 --bind 0.0.0.0`.

Serve the site with a server rather than double-clicking `index.html`. The 404 page uses root paths, and page transitions only work over http.

## Add a post

1. Copy `posts/template.html` to `posts/<slug>.html`, for example `posts/what-i-learned-shipping-wealthos.html`.
2. In the new file, delete the `<meta name="robots" content="noindex">` line and replace every `[PLACEHOLDER]`: the title (it appears in `<title>`, `og:title` and `<h1>`), the date (both the visible date and `datetime="YYYY-MM-DD"`), the summary, and the body. Remove the example elements you don't need. Reading time is calculated automatically.
3. In `index.html`, copy one `<li class="index-row">` block in the Thoughts list, put it at the top (newest first), and point its link at `posts/<slug>.html`.

That's all: one block on the home page plus one new file.

Images: put them in the `media/` folder as WebP at twice the size they display (the device photos are 680×510 and about 20KB each; ffmpeg can convert with `ffmpeg -i in.png -vf scale=680:-1 -c:v libwebp -quality 76 out.webp`), and use the commented `<figure>` example in the template. Always set `width`, `height` and `alt`.

## Tune the motion

**Starfield:** every setting is in the `STARFIELD` object at the top of `main.js`, with a comment on each one:

| Setting | What it does |
| --- | --- |
| `seed` | Changes the arrangement of stars. Every page shares it. |
| `maxStars`, `density` | How many stars there are. The count scales with screen area, up to the cap. |
| `layers` | Per depth layer (far to near): `share` (fraction of stars), `size`, `alpha` (brightness), `depth` (how much the layer drifts and parallaxes), `softness` (0 = crisp point, 1 = out of focus). |
| `sizeVariance` | How often a noticeably larger star appears. 0 makes every star the same size. |
| `glow` | Halo size relative to the star's core. |
| `tints` | Star colour temperatures (cool white to faint blue-white) and how common each is. |
| `drift` | Drift speed in px/s for the nearest layer. |
| `parallax` | How far stars move when you scroll (0.07 = 7% of scroll distance for the nearest layer). |
| `scrollStiffness` | How quickly the sky catches up after a scroll. Lower values feel floatier; it settles in about 4 / stiffness seconds. |
| `scrollMaxSpeed` | Speed cap for that catch-up, so a fast flick doesn't whip the sky. |
| `edgeFalloff` | How much dimmer stars are towards the edges of the screen. |
| `quietDim` | Star brightness on pages whose `<body>` has `data-sky="quiet"`. Every post has it, so the sky stays out of the way of long reads. |
| `quietZoom`, `arrivalMs` | Posts sit slightly "further in" than home. Moving between them dollies the sky forward or back over `arrivalMs`. |
| `introDelayMs` | On the first visit of a session the sky starts first and the hero follows after this delay. |
| `maxDpr` | Resolution cap for the star canvas. 1.5 keeps the soft stars crisp and cuts per-frame pixels by about 44% compared with 2. |
| `nebula` | The faint background wash: number of `blobs`, overall `strength` (0 = off), `palette`, `centreLift` (a slightly lighter centre), `vignette` (darker corners), and `parallax`/`travel` (how far it moves with scroll). |
| `idleFps` | Redraw rate once scrolling has settled. Only the slow drift is moving then, so 30 is plenty and saves battery. |
| `fadeInMs` | Fade-in on the first page of a visit. Later pages show the sky instantly. |
| `background` | Must match `--bg` in `style.css`. |

## Change the type, spacing and colour

Everything is set by variables at the top of `style.css`, in section 1:

- **Type scale** (`--t-*`): 11px spaced-caps labels, 13px meta, 17px body, 18px long-form, 22px titles, a fluid 20 to 26px lede, and a fluid 56 to 144px display size for the name. Post titles are a fluid 36 to 60px. Section 6 sets the tracking and leading for each role: tracking tightens as the size grows.
- **Spacing scale** (`--s-1` to `--s-10`): 4, 8, 12, 16, 24, 32, 48, 64, 96 and 128px. `--section-gap` sets the fluid 96 to 160px gap between sections. Related things sit 4 to 24px apart; separate blocks sit 64px or more apart.
- **Grid:** `--label-col` (the 176px left column for labels, dates and margin notes) and `--content` (the 640px text column). Below 52rem it collapses to one column.
- **Colour:** `--text` (primary), `--text-2` (secondary), `--text-3` (meta), `--rule` (hairlines) and `--accent`. The accent is used only for hover, focus and text selection.

**Entrances, links and page transitions:** set these with the CSS variables at the top of `style.css`. There are three entrance styles, chosen by the value of the `data-reveal` attribute:

- `data-reveal` (rise), for list items and cards: `--reveal-duration` (the fade finishes at about 65% of it), `--reveal-distance`, `--reveal-stagger`.
- `data-reveal="focus"`, for hero and post titles: the text comes into focus with almost no movement. Tune it with `--focus-duration`, `--focus-blur`, `--focus-distance` and `--focus-stagger`.
- `data-reveal="fade"`, for section labels: opacity only.
- Section hairlines draw in from the left: `--line-duration`, `--ease-draw`.
- Links and page changes: `--link-sweep`, `--page-transition`, and the curves `--ease-out-expo`, `--ease-out-soft` and `--ease-sweep`.

The `REVEAL` object in `main.js` sets:

- The scroll speed above which items skip their entrance and do a short fade instead (`fastScroll`).
- How far clear of the bottom edge an item must be before it animates (`rootMargin`).

Items that are already above the screen, for example after going back, simply appear.

To make an element fade in, add `data-reveal` to it.

With **Reduce motion** turned on in the OS, the starfield is drawn once and stays still, and entrances, link sweeps and page transitions are switched off. With JavaScript turned off, all content stays visible.

## Deploy to GitHub Pages

1. Create a public repo named exactly **`TheTinyPenguinn.github.io`**.
2. Push this folder to its `main` branch:

   ```sh
   git remote add origin https://github.com/TheTinyPenguinn/TheTinyPenguinn.github.io.git
   git push -u origin main
   ```

3. In the repo, go to **Settings → Pages → Build and deployment**. Set **Source: Deploy from a branch**, **Branch: `main`**, **Folder: `/ (root)`**, then save.
4. After a minute or two, the site is live at <https://thetinypenguinn.github.io>. Every later push to `main` redeploys it.

## Add a custom domain (optional)

1. Buy the domain from any registrar.
2. Add a file called `CNAME` (no extension) to the repo root. It should contain one line, the domain:

   ```
   example.com
   ```

3. At your registrar's DNS settings:
   - **Apex domain** (`example.com`): add four `A` records pointing to
     `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`.
     For IPv6, optionally add `AAAA` records pointing to
     `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`.
   - **`www` subdomain:** add a `CNAME` record for `www` pointing to `thetinypenguinn.github.io`.
4. In **Settings → Pages**, enter the domain under **Custom domain**. Once the DNS check passes, tick **Enforce HTTPS**. The DNS check and certificate can take anywhere from a few minutes to a day.
5. Optional but recommended: verify the domain under your GitHub account's **Settings → Pages** so nobody else can claim it.

GitHub's reference: [Managing a custom domain for your GitHub Pages site](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).
