import { FarFieldGrid } from "./quadtree";
import { DEFAULT_FORCE_SETTINGS, type ForceSettings } from "./types";

/**
 * The force simulation: repel, link, centre — velocity-Verlet integrated, with
 * the same alpha cooling schedule d3-force uses.
 *
 * Deliberately free of DOM and React: it runs unchanged on the main thread or
 * inside force.worker.ts, which is what lets the physics move off the UI thread
 * without a second implementation. State is flat typed arrays so a frame costs no
 * allocation and positions can be transferred to another thread for free.
 *
 * The local graph adds a fourth force: given a hop depth per node it pulls each one
 * towards a ring at `depth * orbitGap` instead of towards the origin. It is a *bias*,
 * not a layout — the angle a node settles at still comes from repel and link, so
 * clusters keep forming, they just form along a ring. The centre is held at the
 * origin like a sun, which is what makes the arrangement read as a system rather
 * than as a target pattern.
 */

export const ALPHA_MIN = 0.001;
/** Cools from 1 to ALPHA_MIN in ~320 ticks, matching d3's default feel. */
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 320);
/** Velocity kept per tick (d3's velocityDecay 0.4 inverted). */
const VELOCITY_DECAY = 0.6;
/** Golden angle — deterministic phyllotaxis seeding, so a reload lays out the same. */
const PHI = Math.PI * (3 - Math.sqrt(5));
const INITIAL_RADIUS = 26;

/**
 * Pull towards a node's own orbit. Firm enough that the rings the renderer draws are
 * the rings the nodes actually sit on — a ring the layout only loosely obeys looks
 * like a mistake — and once the radius is settled the repulsion it no longer fights
 * goes tangential, which is what spreads a hop around its circle instead of bunching
 * it at one bearing. Tuned by eye against a 32-node local graph.
 */
const ORBIT_PULL = 0.42;
/** The centre is a sun: it holds the origin far harder than an ordinary node. */
const SUN_GRIP = 4;

/**
 * How a link's 0..1 strength maps to physics. A weight of 0 keeps 35% of the pull
 * and asks for 1.55x the rest distance; a weight of 1 is a plain d3 link. Chosen by
 * eye on the real graph: enough that tag-only relations visibly hang farther out,
 * little enough that a weakly linked node never drifts off screen.
 */
const WEAK_LINK_PULL = 0.35;
const WEAK_LINK_STRETCH = 1.55;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Sidebar 0..1 -> force constants. One place, so the sliders stay honest. */
export function chargeStrength(repel: number): number {
  return -(24 + repel * 300);
}
export function centerStrength(center: number): number {
  return center * 0.14;
}

export class ForceSimulation {
  count = 0;
  alpha = 1;
  positions = new Float32Array(0);
  settings: ForceSettings = { ...DEFAULT_FORCE_SETTINGS };

  private velocities = new Float32Array(0);
  // Explicit buffer generic: the links array arrives from a worker message, where
  // it is only known to be ArrayBufferLike, and TS will not narrow that for us.
  private links: Int32Array<ArrayBufferLike> = new Int32Array(0);
  private linkBias = new Float32Array(0);
  private linkBase = new Float32Array(0);
  /**
   * Per-link distance multiplier, or null when no weights were supplied. A weak
   * relationship is asked to sit farther out, which is what makes clusters read as
   * clusters: strong edges pull their group tight, weak ones only tether.
   */
  private linkStretch: Float32Array | null = null;
  private pinned = new Uint8Array(0);
  /** Hops from the centre per local index, or null in the global graph. */
  private depths: Int32Array | null = null;
  private grid = new FarFieldGrid();

  /**
   * Swaps in a new subgraph. `seed` carries the previous position of each node
   * (NaN for nodes that were not on screen before) so that changing a filter
   * nudges the layout instead of throwing it away and re-exploding it.
   *
   * `weights` is one 0..1 strength per link, parallel to `links`. It is optional so
   * an unweighted caller (and the tests) still get d3's plain behaviour. `depths` is
   * hops from the local centre per index — omit it (or pass null) and the layout
   * centres on the origin the way it always has.
   */
  setGraph(
    count: number,
    links: Int32Array,
    seed?: Float32Array | null,
    weights?: Float32Array | null,
    depths?: Int32Array | null
  ): void {
    this.count = count;
    this.positions = new Float32Array(count * 2);
    this.velocities = new Float32Array(count * 2);
    this.pinned = new Uint8Array(count);
    this.links = links;
    this.depths = depths && depths.length >= count ? depths : null;

    for (let i = 0; i < count; i += 1) {
      const seedX = seed ? seed[i * 2] : NaN;
      const seedY = seed ? seed[i * 2 + 1] : NaN;
      if (Number.isFinite(seedX) && Number.isFinite(seedY)) {
        this.positions[i * 2] = seedX;
        this.positions[i * 2 + 1] = seedY;
      } else {
        const radius = INITIAL_RADIUS * Math.sqrt(0.5 + i);
        const angle = i * PHI;
        this.positions[i * 2] = radius * Math.cos(angle);
        this.positions[i * 2 + 1] = radius * Math.sin(angle);
      }
    }

    const linkCount = links.length / 2;
    const degree = new Int32Array(count);
    for (let l = 0; l < linkCount; l += 1) {
      degree[links[l * 2]] += 1;
      degree[links[l * 2 + 1]] += 1;
    }
    this.linkBias = new Float32Array(linkCount);
    this.linkBase = new Float32Array(linkCount);
    // Only allocated when weights arrive, so the unweighted path costs nothing.
    this.linkStretch = weights && weights.length >= linkCount ? new Float32Array(linkCount) : null;
    for (let l = 0; l < linkCount; l += 1) {
      const source = links[l * 2];
      const target = links[l * 2 + 1];
      const ds = degree[source] || 1;
      const dt = degree[target] || 1;
      // d3's convention: the busier end of a link moves less.
      this.linkBias[l] = ds / (ds + dt);
      const weight = weights ? clamp01(weights[l]) : 1;
      // Folded into the base rather than applied per tick: the sidebar's link slider
      // is the only other factor and it multiplies this untouched. The floor of 0.35
      // matters — a weak edge must still hold, or the graph would fly apart wherever
      // the relationship is merely suggestive.
      this.linkBase[l] = (1 / Math.min(ds, dt)) * (WEAK_LINK_PULL + (1 - WEAK_LINK_PULL) * weight);
      if (this.linkStretch) this.linkStretch[l] = WEAK_LINK_STRETCH - (WEAK_LINK_STRETCH - 1) * weight;
    }

    this.alpha = 1;
  }

  setSettings(next: ForceSettings): void {
    this.settings = next;
  }

  /** Wakes a settled layout — after a drag, a filter change or a slider move. */
  reheat(alpha = 0.55): void {
    if (this.alpha < alpha) this.alpha = alpha;
  }

  pin(index: number, x: number, y: number): void {
    if (index < 0 || index >= this.count) return;
    this.pinned[index] = 1;
    this.positions[index * 2] = x;
    this.positions[index * 2 + 1] = y;
    this.velocities[index * 2] = 0;
    this.velocities[index * 2 + 1] = 0;
  }

  release(index: number): void {
    if (index < 0 || index >= this.count) return;
    this.pinned[index] = 0;
  }

  get settled(): boolean {
    return this.alpha <= ALPHA_MIN;
  }

  /** One integration step. Returns the new alpha. */
  tick(): number {
    const { count, positions, velocities, pinned } = this;
    if (count === 0) return this.alpha;

    this.alpha += (0 - this.alpha) * ALPHA_DECAY;
    const alpha = this.alpha;
    const charge = chargeStrength(this.settings.repel);
    const centerK = centerStrength(this.settings.center);

    this.grid.build(positions, count);
    const { depths } = this;
    const gap = this.settings.orbitGap;
    const orbiting = depths !== null && gap > 0;
    for (let i = 0; i < count; i += 1) {
      if (pinned[i]) continue;
      this.grid.apply(i, positions, velocities, charge, alpha);
      const depth = orbiting ? depths[i] : -1;
      if (depth > 0) {
        let x = positions[i * 2];
        let y = positions[i * 2 + 1];
        let length = Math.sqrt(x * x + y * y);
        if (length < 1e-6) {
          // Sitting exactly on the sun: nudge it onto a deterministic bearing so the
          // radial pull has a direction to work along at all.
          x = Math.cos(i * PHI);
          y = Math.sin(i * PHI);
          positions[i * 2] = x;
          positions[i * 2 + 1] = y;
          length = 1;
        }
        // Towards this node's own ring rather than towards the middle. Same shape as
        // d3's forceRadial: a spring along the radius, leaving the bearing free.
        const pull = ((depth * gap - length) / length) * ORBIT_PULL * alpha;
        velocities[i * 2] += x * pull;
        velocities[i * 2 + 1] += y * pull;
      } else {
        const grip = depth === 0 ? centerK * SUN_GRIP : centerK;
        velocities[i * 2] += (0 - positions[i * 2]) * grip * alpha;
        velocities[i * 2 + 1] += (0 - positions[i * 2 + 1]) * grip * alpha;
      }
    }

    const { links, linkBias, linkBase, linkStretch } = this;
    const linkCount = links.length / 2;
    const distance = this.settings.linkDistance;
    const linkScale = this.settings.link * 2;
    for (let l = 0; l < linkCount; l += 1) {
      const source = links[l * 2];
      const target = links[l * 2 + 1];
      let dx =
        positions[target * 2] + velocities[target * 2] - positions[source * 2] - velocities[source * 2];
      let dy =
        positions[target * 2 + 1] +
        velocities[target * 2 + 1] -
        positions[source * 2 + 1] -
        velocities[source * 2 + 1];
      let length = Math.sqrt(dx * dx + dy * dy);
      if (length < 1e-6) {
        // Coincident endpoints: separate them along a fixed diagonal.
        dx = 0.7;
        dy = 0.7;
        length = 1;
      }
      const rest = linkStretch ? distance * linkStretch[l] : distance;
      const strength = Math.min(1, linkBase[l] * linkScale);
      const push = ((length - rest) / length) * alpha * strength;
      const fx = dx * push;
      const fy = dy * push;
      const bias = linkBias[l];
      if (!pinned[target]) {
        velocities[target * 2] -= fx * bias;
        velocities[target * 2 + 1] -= fy * bias;
      }
      if (!pinned[source]) {
        velocities[source * 2] += fx * (1 - bias);
        velocities[source * 2 + 1] += fy * (1 - bias);
      }
    }

    for (let i = 0; i < count; i += 1) {
      if (pinned[i]) {
        velocities[i * 2] = 0;
        velocities[i * 2 + 1] = 0;
        continue;
      }
      velocities[i * 2] *= VELOCITY_DECAY;
      velocities[i * 2 + 1] *= VELOCITY_DECAY;
      positions[i * 2] += velocities[i * 2];
      positions[i * 2 + 1] += velocities[i * 2 + 1];
    }

    return this.alpha;
  }
}
