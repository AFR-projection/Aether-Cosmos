/**
 * Far-field approximation for the repulsion force.
 *
 * A naive n-body pass is O(n²) — 6000 nodes would be 36M distance checks per
 * frame, which is exactly how a force graph freezes a browser. This is a
 * Barnes–Hut approximation over a fixed quadtree pyramid: a stack of uniform
 * grids where level L has 2^L × 2^L cells, each holding the mass and centre of
 * mass of the nodes inside it.
 *
 * A pyramid rather than a pointer tree because every array is allocated once and
 * reused: a frame does no allocation, so the collector never runs mid-drag.
 * Cost is O(n log n) per tick with a small constant.
 */

/** theta², the Barnes–Hut opening angle. Larger = faster and coarser. */
const THETA2 = 0.81;
const MAX_LEVELS = 8;
const MIN_LEVELS = 3;

export class FarFieldGrid {
  private levels = MIN_LEVELS;
  private levelOffset = new Int32Array(MAX_LEVELS + 2);
  private mass = new Float32Array(0);
  private comX = new Float32Array(0);
  private comY = new Float32Array(0);
  private totalCells = 0;
  private minX = 0;
  private minY = 0;
  private size = 1;
  /** Explicit traversal stack: triples of (level, gx, gy). */
  private stack = new Int32Array(3 * 4 * (MAX_LEVELS + 1) * 8);

  /** Sizes the pyramid for `count` nodes: roughly one node per leaf cell. */
  resize(count: number): void {
    const wanted = Math.max(
      MIN_LEVELS,
      Math.min(MAX_LEVELS, Math.ceil(Math.log2(Math.max(2, Math.sqrt(count)))) + 1)
    );
    if (wanted === this.levels && this.mass.length > 0) return;

    this.levels = wanted;
    let offset = 0;
    for (let level = 0; level <= wanted; level += 1) {
      this.levelOffset[level] = offset;
      offset += 1 << (2 * level);
    }
    this.levelOffset[wanted + 1] = offset;
    this.totalCells = offset;
    this.mass = new Float32Array(offset);
    this.comX = new Float32Array(offset);
    this.comY = new Float32Array(offset);
  }

  build(positions: Float32Array, count: number): void {
    this.resize(count);
    const { mass, comX, comY, levels, levelOffset } = this;
    mass.fill(0, 0, this.totalCells);
    comX.fill(0, 0, this.totalCells);
    comY.fill(0, 0, this.totalCells);
    if (count === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < count; i += 1) {
      const x = positions[i * 2];
      const y = positions[i * 2 + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    // Square, padded bounds: a padded box keeps every node strictly inside the
    // grid so the clamp below never folds two far-apart nodes into one cell.
    const extent = Math.max(maxX - minX, maxY - minY, 1);
    const pad = extent * 0.02 + 1;
    this.size = extent + pad * 2;
    this.minX = minX - pad;
    this.minY = minY - pad;

    const leafWidth = 1 << levels;
    const leafBase = levelOffset[levels];
    const scale = leafWidth / this.size;
    for (let i = 0; i < count; i += 1) {
      const x = positions[i * 2];
      const y = positions[i * 2 + 1];
      const gx = Math.min(leafWidth - 1, Math.max(0, ((x - this.minX) * scale) | 0));
      const gy = Math.min(leafWidth - 1, Math.max(0, ((y - this.minY) * scale) | 0));
      const cell = leafBase + gy * leafWidth + gx;
      mass[cell] += 1;
      comX[cell] += x;
      comY[cell] += y;
    }

    // Roll the leaf sums up the pyramid, then normalize every cell in one pass.
    for (let level = levels - 1; level >= 0; level -= 1) {
      const width = 1 << level;
      const childWidth = width * 2;
      const base = levelOffset[level];
      const childBase = levelOffset[level + 1];
      for (let gy = 0; gy < width; gy += 1) {
        for (let gx = 0; gx < width; gx += 1) {
          const c0 = childBase + gy * 2 * childWidth + gx * 2;
          const c1 = c0 + 1;
          const c2 = c0 + childWidth;
          const c3 = c2 + 1;
          const cell = base + gy * width + gx;
          mass[cell] = mass[c0] + mass[c1] + mass[c2] + mass[c3];
          comX[cell] = comX[c0] + comX[c1] + comX[c2] + comX[c3];
          comY[cell] = comY[c0] + comY[c1] + comY[c2] + comY[c3];
        }
      }
    }
    for (let cell = 0; cell < this.totalCells; cell += 1) {
      const m = mass[cell];
      if (m > 0) {
        comX[cell] /= m;
        comY[cell] /= m;
      }
    }
  }

  /** Leaf cell holding a point — used to exclude a node from its own cell. */
  private leafOf(x: number, y: number): number {
    const leafWidth = 1 << this.levels;
    const scale = leafWidth / this.size;
    const gx = Math.min(leafWidth - 1, Math.max(0, ((x - this.minX) * scale) | 0));
    const gy = Math.min(leafWidth - 1, Math.max(0, ((y - this.minY) * scale) | 0));
    return this.levelOffset[this.levels] + gy * leafWidth + gx;
  }

  /**
   * Adds the repulsion acting on node `i` into `velocities`.
   * `strength` is negative for repulsion, matching d3-force's convention.
   */
  apply(
    i: number,
    positions: Float32Array,
    velocities: Float32Array,
    strength: number,
    alpha: number
  ): void {
    const { mass, comX, comY, levels, levelOffset, stack } = this;
    const x = positions[i * 2];
    const y = positions[i * 2 + 1];
    const ownLeaf = this.leafOf(x, y);
    let vx = 0;
    let vy = 0;

    let top = 0;
    stack[top++] = 0;
    stack[top++] = 0;
    stack[top++] = 0;

    while (top > 0) {
      const gy = stack[--top];
      const gx = stack[--top];
      const level = stack[--top];
      const width = 1 << level;
      const cell = levelOffset[level] + gy * width + gx;
      const m = mass[cell];
      if (m === 0) continue;

      let dx = comX[cell] - x;
      let dy = comY[cell] - y;
      let d2 = dx * dx + dy * dy;
      const cellSize = this.size / width;

      if (level < levels && cellSize * cellSize >= THETA2 * d2) {
        const childLevel = level + 1;
        for (let q = 0; q < 4; q += 1) {
          stack[top++] = childLevel;
          stack[top++] = gx * 2 + (q & 1);
          stack[top++] = gy * 2 + (q >> 1);
        }
        continue;
      }

      let bodyMass = m;
      if (level === levels && cell === ownLeaf) {
        // The cell's centre of mass includes this node; take it back out instead
        // of letting a node push itself.
        if (m <= 1) continue;
        bodyMass = m - 1;
        dx = (comX[cell] * m - x) / bodyMass - x;
        dy = (comY[cell] * m - y) / bodyMass - y;
        d2 = dx * dx + dy * dy;
      }

      if (d2 < 1) {
        if (dx === 0 && dy === 0) {
          // Perfectly coincident nodes have no direction to separate along; a
          // deterministic nudge keeps the layout reproducible.
          dx = ((i * 2654435761) % 2001) / 1000 - 1;
          dy = (((i + 7) * 40503) % 2001) / 1000 - 1;
          d2 = dx * dx + dy * dy || 1;
        }
        d2 = Math.max(d2, 1);
      }

      const w = (bodyMass * strength * alpha) / d2;
      vx += dx * w;
      vy += dy * w;
    }

    velocities[i * 2] += vx;
    velocities[i * 2 + 1] += vy;
  }
}
