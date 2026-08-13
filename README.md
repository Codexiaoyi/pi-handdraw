# pi-handdraw

Hand-drawn style diagram extension for [pi](https://github.com/earendil-works/pi-coding-agent) (`@earendil-works/pi-coding-agent`).

It gives the AI a structured "drawing language" (boxes / ellipses / diamonds / arrows / text / paths) and renders **rough.js sketch-style diagrams** — as static SVG+PNG shown inline in your terminal, or **live on a browser canvas** where you watch a pen write each stroke in real time.

## Features

- **`handdraw` tool** — one-shot diagram generation
  - Flowcharts, mind maps, architecture sketches in a wobbly hand-drawn style
  - Two layouts: `flow` (auto-arranged, arrows drawn automatically between consecutive shapes) and `manual` (exact x/y coordinates)
  - Chinese and English text rendered in a calligraphy font (Kaiti)
  - Saves both `.svg` and `.png`, displays the image **inline in the TUI** (Warp / Kitty / iTerm2 / Ghostty / WezTerm)
- **`handdraw_canvas` tool** — live collaborative canvas
  - AI draws incrementally (1–3 elements per call); every stroke appears **instantly in your browser** with a pen indicator writing it out
  - Infinite canvas with auto-expansion; elements can be updated or removed by ID
  - AI receives a canvas summary after each call (occupied areas + free spots) so it can place the next strokes without overlap
  - Canvas state persists across restarts (`canvas-state.json`)
- **`/handdraw-demo` command** — generates a sample flowchart and opens a stroke-by-stroke handwriting animation in your browser

## Installation

```bash
# 1. Clone into your pi global extensions directory
cd ~/.pi/agent/extensions
git clone https://github.com/Codexiaoyi/pi-handdraw.git handdraw

# 2. Install dependencies (includes the native @resvg/resvg-js renderer)
cd handdraw
npm install

# 3. Reload pi (or restart it)
#    Inside pi, run: /reload
```

Project-local install also works: put the folder in `<your-project>/.pi/extensions/handdraw/` instead.

## Usage

Once installed, you don't call anything directly — just ask:

- **"Draw a flowchart of the login process"** → AI uses `handdraw`, you get an inline sketch + `handdraw/*.svg|png` files
- **"Draw the system architecture on the live canvas"** → AI uses `handdraw_canvas`; open the canvas page (default `http://localhost:8788`) and watch it draw stroke by stroke
- **`/handdraw-demo`** → instant demo: sample diagram + browser handwriting animation

The AI decides which tool fits; you can nudge it with words like "hand-drawn", "sketch", "live canvas".

### Output files

One-shot diagrams are written to `./handdraw/` in your project directory:

```
handdraw/
  20250813-210530-login-flow.svg   # vector, rough.js style
  20250813-210530-login-flow.png   # rasterized via resvg
  20250813-210530-login-flow.html  # optional handwriting animation
```

### Live canvas

- Serves on the first free port of **8788–8791**
- `GET /` — infinite canvas page (open it before asking the AI to draw)
- `WS /ws` — stroke events pushed in real time
- State file `canvas-state.json` lives next to the extension; delete it to start with a blank canvas

## How it works

| File | Role |
|---|---|
| `index.ts` | Extension entry: registers the `handdraw` / `handdraw_canvas` tools and `/handdraw-demo` command |
| `draw.ts` | Drawing language → rough.js SVG; flow layout engine; stroke sequencing for animations |
| `handwriting.ts` | Stroke-by-stroke handwriting animation (Chinese glyph data from `hanzi-writer-data`) |
| `canvas-server.ts` | Local HTTP + WebSocket server for the live canvas |
| `canvas-page.html` | Browser canvas page (incremental rendering, pen-follow animation) |
| `raster.ts` | SVG → PNG via `@resvg/resvg-js` |

## Requirements

- pi (`@earendil-works/pi-coding-agent`) with extension support
- Node.js 18+
- For inline images: a terminal with graphics protocol support (Warp, Kitty, iTerm2, Ghostty, WezTerm). Without one, files are still saved to disk.

## License

MIT
