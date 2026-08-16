# pi-handdraw

Hand-drawn style **live canvas** extension for [pi](https://github.com/earendil-works/pi-coding-agent) (`@earendil-works/pi-coding-agent`).

It gives the AI a structured "drawing language" (boxes / ellipses / diamonds / arrows / text / paths) and draws **rough.js sketch-style diagrams live on a browser canvas** — you watch a pen write each stroke in real time.

## Features

- **`handdraw_canvas` tool** — live collaborative canvas
  - AI draws incrementally (1–3 elements per call); every stroke appears **instantly in your browser** with a pen indicator writing it out
  - Infinite canvas with auto-expansion; elements can be updated or removed by ID
  - AI receives a canvas summary after each call (occupied areas + free spots + element metadata) so it can place the next strokes without overlap
  - Chinese and English text rendered in a calligraphy style (Kaiti; Chinese glyphs written stroke-by-stroke from `hanzi-writer-data`)
- **Boards (`handdraw_board` tool)** — the canvas is organized into multiple boards
  - Each board is a directory `boards/<name>/`: canvas state in `state.json`, resources (images…) in `images/`
  - Board management is itself a tool: `list / create / switch / delete`
  - The browser page has a board switcher; strokes are isolated per board
- **Journal-friendly drawing vocabulary**
  - Multi-line text / paragraphs: `\n` line breaks, `w` auto-wrapping, `lineHeight`, `align`
  - Stickers: predefined rough-style doodles (`sticker` element by name: star, heart, sun, cloud, flower, coffee, check, music, rainbow, moon — see `stickers.ts`; the status result lists them for the AI)
  - `z` stacking order on every element (backgrounds under text, decorative stickers, …)
- **i18n** — tool text and canvas page in Chinese or English: `HANDDRAW_LANG=zh|en` (default `zh`)
- Canvas state persists across restarts (per board); refreshing the page restores the drawing instantly without replaying the animation

## Installation

### As a pi extension

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

### As an MCP server (any MCP-capable agent)

The same tool is available over MCP (stdio), sharing all logic with the pi extension:

```json
{
  "mcpServers": {
    "handdraw": {
      "command": "npx",
      "args": ["tsx", "/path/to/pi-handdraw/mcp-server.ts"]
    }
  }
}
```

Or run it directly: `npm run mcp`.

### As a standalone web canvas bridged to your own agent

Run a self-contained canvas server with a chat panel — the page gets a slide-in chat card on the left where you talk to **your own installed agent**, which draws on the canvas through the handdraw tools. No built-in LLM and no API keys to configure — it uses your agent's existing login:

```bash
npm run agent                              # default: pi
HANDDRAW_AGENT_BACKEND=codex npm run agent # or claude-code / codex / gemini
HANDDRAW_ACP_CMD="my-acp-agent --flag" npm run agent  # any ACP agent command
HANDDRAW_PI_ARGS="--model anthropic/claude-sonnet-4-5" npm run agent  # extra args for the pi backend
```

- **pi (default)** — bridged via pi's built-in `--mode rpc` (JSONL), reusing your globally installed handdraw extension; the chat session persists in `boards/.pi-web-session/` across restarts
- **claude-code / codex / gemini** — bridged via [ACP](https://agentclientprotocol.com) (Agent Client Protocol, the same protocol Zed uses; `@zed-industries/*-acp` adapters fetched by npx, or gemini's built-in `--experimental-acp`), with the handdraw MCP server injected into the ACP session
- The chat panel (floating card, collapsible) only appears in this mode; the bottom bar also has a **＋** button to create new boards
- ACP tool permission requests are auto-approved (`HANDDRAW_ACP_AUTO_APPROVE=0` to reject); messages time out after 10 min (`HANDDRAW_AGENT_TIMEOUT_MS`)
- Chat API: `GET /api/agent/info`, `GET /api/chat/history`, `POST /api/chat`, `POST /api/chat/reset`

## Usage

Once installed, you don't call anything directly — just ask:

- **"Draw the system architecture on the live canvas"** → AI uses `handdraw_canvas`; the canvas page opens automatically (default `http://localhost:8788`) and you watch it draw stroke by stroke
- **"Change the red box to say …"** → AI updates that element by ID; **"remove the arrow"** works too

### Live canvas

- Serves on the first free port of **8788–8791** (override with `HANDDRAW_CANVAS_PORTS=port1,port2`)
- `GET /?board=<name>` — infinite canvas page with a board switcher
- `WS /ws?board=<name>` — stroke events pushed in real time (isolated per board)
- Boards live under `boards/` next to the extension (override with `HANDDRAW_BOARDS_DIR`); a legacy `canvas-state.json` is migrated to `boards/default/state.json` on first start
- Environment: `HANDDRAW_LANG=zh|en` (UI/tool language), `HANDDRAW_BOARDS_DIR`, `HANDDRAW_CANVAS_PORTS`

## How it works

| File | Role |
|---|---|
| `index.ts` | pi extension shell: registers the `handdraw_canvas` tool |
| `mcp-server.ts` | MCP server shell (stdio): same tool for any MCP-capable agent |
| `web-agent.ts` | Standalone web canvas + chat bridge: relays the in-page chat to your own agent — pi via `--mode rpc` (default), or claude code / codex / gemini via ACP |
| `core.ts` | Agent-agnostic core: shared JSON schema, tool guidelines, canvas server lifecycle, draw/update/remove/status/clear logic |
| `draw.ts` | Drawing language → rough.js strokes; stroke sequencing for the pen animation |
| `handwriting.ts` | Stroke-by-stroke handwriting data (Chinese glyph data from `hanzi-writer-data`) |
| `canvas-server.ts` | Local HTTP + WebSocket server for the live canvas (multi-board) |
| `canvas-page.html` | Browser canvas page (incremental rendering, pen-follow animation, z-ordered groups) |
| `i18n.ts` | Chinese/English strings (tool text + canvas page UI) |
| `stickers.ts` | Sticker doodle library (normalized point data, rendered via rough.js) |

## Requirements

- pi (`@earendil-works/pi-coding-agent`) with extension support
- Node.js 18+

## License

MIT
