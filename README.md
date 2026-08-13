# pi-handdraw

Hand-drawn style **live canvas** extension for [pi](https://github.com/earendil-works/pi-coding-agent) (`@earendil-works/pi-coding-agent`).

It gives the AI a structured "drawing language" (boxes / ellipses / diamonds / arrows / text / paths) and draws **rough.js sketch-style diagrams live on a browser canvas** — you watch a pen write each stroke in real time.

## Features

- **`handdraw_canvas` tool** — live collaborative canvas
  - AI draws incrementally (1–3 elements per call); every stroke appears **instantly in your browser** with a pen indicator writing it out
  - Infinite canvas with auto-expansion; elements can be updated or removed by ID
  - AI receives a canvas summary after each call (occupied areas + free spots) so it can place the next strokes without overlap
  - Canvas state persists across restarts (`canvas-state.json`); refreshing the page restores the drawing instantly without replaying the animation
  - Chinese and English text rendered in a calligraphy style (Kaiti; Chinese glyphs written stroke-by-stroke from `hanzi-writer-data`)

## Installation

```bash
# 1. Clone into your pi global extensions directory
cd ~/.pi/agent/extensions
git clone https://github.com/Codexiaoyi/pi-handdraw.git handdraw

# 2. Install dependencies
cd handdraw
npm install

# 3. Reload pi (or restart it)
#    Inside pi, run: /reload
```

Project-local install also works: put the folder in `<your-project>/.pi/extensions/handdraw/` instead.

## Usage

Once installed, you don't call anything directly — just ask:

- **"Draw the system architecture on the live canvas"** → AI uses `handdraw_canvas`; the canvas page opens automatically (default `http://localhost:8788`) and you watch it draw stroke by stroke
- **"Change the red box to say …"** → AI updates that element by ID; **"remove the arrow"** works too

### Live canvas

- Serves on the first free port of **8788–8791**
- `GET /` — infinite canvas page (open it before asking the AI to draw)
- `WS /ws` — stroke events pushed in real time
- State file `canvas-state.json` lives next to the extension; delete it to start with a blank canvas

## How it works

| File | Role |
|---|---|
| `index.ts` | Extension entry: registers the `handdraw_canvas` tool |
| `draw.ts` | Drawing language → rough.js strokes; stroke sequencing for the pen animation |
| `handwriting.ts` | Stroke-by-stroke handwriting data (Chinese glyph data from `hanzi-writer-data`) |
| `canvas-server.ts` | Local HTTP + WebSocket server for the live canvas |
| `canvas-page.html` | Browser canvas page (incremental rendering, pen-follow animation) |

## Requirements

- pi (`@earendil-works/pi-coding-agent`) with extension support
- Node.js 18+

## License

MIT
