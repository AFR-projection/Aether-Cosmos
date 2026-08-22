# Knowledge Graph

The interactive graph visualization at `/brain/graph`: how it's built, what you can
do with it, and how it stays fast with thousands of nodes.

---

## What it shows

Every memory is a node. Edges come from two sources:

- **Derived** — TF-IDF cosine similarity between memory content. Computed in
  `lib/brain/graph/relate.ts` using term vectors weighted by inverse document
  frequency, **not** embeddings. The top *k* similar memories per memory become
  edges, where *k* is tuned so the graph stays connected without becoming a hairball.
- **Explicit** — user-created or agent-created links from `memory_links`, with a
  label (`relates_to`, `contradicts`, `depends_on`, etc.).

Entities and relationships from `brain_entities` / `brain_relationships` are a
separate graph layer for now — they appear in the detail card when you select a
memory, but not as nodes on the canvas.

---

## Pipeline

The graph is not computed client-side. A snapshot is requested from the server,
which runs the full pipeline and returns a view ready to render.

```
1. snapshot     — read from DB (memories + memory_links + derived edges from relate.ts)
2. model        — turn rows into a graph: nodes[], edges[], metrics (PageRank, components)
3. query        — apply filters (text search, memory type, archived, orphans)
4. view         — cap nodes (2500 workspace / 6000 pop-out) and edges (6000 / 20000)
5. groups       — evaluate up to 12 custom rules, assign colours
6. engine       — velocity-Verlet force simulation (attraction + repulsion + damping)
7. canvas       — render in the browser, batched per colour
```

Steps 1–6 run server-side in `app/api/brain/[id]/graph/route.ts` → `lib/brain/graph-service.ts`.
Step 7 is `components/brain/graph/graph-canvas.tsx`.

The force worker (`components/brain/graph/force.worker.ts`) ticks the simulation in
a background thread using a Barnes–Hut quadtree for O(n log n) force calculation
instead of O(n²).

---

## Views

| Mode | What it shows |
|------|---------------|
| **Global** | All memories that pass the filters, up to the cap |
| **Local** | One focus memory + its *N*-hop neighbourhood (depths 1–6, default 2) |

Switch with the **Local Graph** toggle in the controls. In local mode, select a
memory (click a node or pick from the list) and adjust the depth slider. The server
re-runs the query with that focus and depth.

---

## Filters

| Filter | Effect |
|--------|--------|
| **Search** | Matches title or content (case-insensitive substring) |
| **Memory type** | `note`, `preference`, `task`, `entity`, `relationship`, `event` |
| **Include archived** | Show or hide archived memories |
| **Hide orphans** | Remove nodes with degree 0 |

Filters are applied at query time (step 3), so changing them re-requests the
snapshot rather than hiding nodes client-side.

---

## Groups

Up to 12 custom colour-coded rules evaluated in order, first match wins. A rule is
a predicate on the memory (type, importance threshold, tag presence, title pattern,
project membership) and a colour. The UI lets you reorder rules, toggle them on/off,
and assign one of 12 fixed colours.

Grouping happens after the view is capped (step 5), so changing group rules does
not trigger a server round-trip — it's a client-side re-colour.

---

## Caps and performance

| Limit | Workspace | Pop-out | Why |
|-------|-----------|---------|-----|
| Nodes | 2500 | 6000 | Keeps the force simulation under 16 ms/frame on a 2019 MacBook Pro |
| Edges | 6000 | 20000 | Canvas draw calls are batched per colour; 20k edges with 12 colours = ~1.7k per batch, which fits in one frame |
| Groups | 12 | 12 | Colour palette size + UI layout |
| Local depth | 1–6 | 1–6 | Depth 7+ rarely adds signal and always adds >1000 nodes |

When the filtered set exceeds the cap, the server returns the most recent or highest
importance memories first (depending on sort order). The detail card on a selected
node lists up to 40 related neighbours — the canvas may show fewer.

The pop-out window (`/brain/graph?popup=1`) runs in a separate browsing context
with its own renderer, so dragging nodes there does not block the main workspace.
Settings (groups, filters, camera) sync across windows via `BroadcastChannel` with
1–2 ms latency.

---

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| Arrow keys | Pan the canvas |
| `+` / `−` | Zoom in / out |
| `0` | Fit all visible nodes into view |
| `Esc` | Deselect node |

Mouse:
- **Click node** → select, show detail card
- **Double-click node** → center local graph on that node
- **Right-click node** → context menu (open, edit, archive, delete)
- **Drag node** → reposition (affects the simulation)
- **Drag background** → pan
- **Scroll** → zoom

---

## Settings persistence

Graph settings (group rules, last filter state, local/global mode, depth) are stored
per brain in `localStorage` under `brain-graph-settings:{brainId}`. The camera
position (pan, zoom) is deliberately **not** persisted — every visit starts with
"fit all."

Access settings state via `lib/brain/graph/use-graph-settings.ts`, which wraps
`useSyncExternalStore` so changes from one tab are visible in another instantly.

---

## Force simulation

The layout is computed with a velocity-Verlet integrator:

```
for each node i:
  force = Σ spring(i, j) - Σ repulsion(i, k) - damping * velocity_i
  velocity += force * dt
  position += velocity * dt
```

- **Spring** — edges pull connected nodes together (Hooke's law)
- **Repulsion** — all nodes repel each other (inverse square, computed via
  Barnes–Hut quadtree to avoid O(n²) checks)
- **Damping** — velocity decay, so the graph settles instead of oscillating forever

The worker runs at 60 Hz and posts positions back to the main thread. The canvas
reads them every `requestAnimationFrame` and draws.

---

## Why not a library?

The graph was originally implemented with d3-force and react-force-graph, then
rewritten from scratch when neither could handle 2000+ nodes without dropping frames.
The current pipeline trades off some layout beauty for guarantees: the server
controls the cap, the worker uses a quadtree, and the canvas batches draws. Those
guarantees let the graph scale to the test suite's synthetic 10k-node stress case
without freezing.

---

**See also:** [Second Brain Architecture](second-brain-architecture.md) ·
[Second Brain Overview](second-brain.md)
