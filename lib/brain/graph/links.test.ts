import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { GraphNode } from "./types";
import {
  GRAPH_POPUP_PATH,
  GRAPH_POPUP_WINDOW,
  graphWorkspacePath,
  memoryHref,
  nodeShareUrl,
  openGraphPopup,
} from "./links";

/**
 * The URLs the graph hands out.
 *
 * Two claims in the module's own docblock are asserted here rather than trusted. A
 * link must resolve to the thing it names, so an entity — which has no page in this
 * app — gets null instead of an invented route. And a shared link must not depend on
 * hidden state: the brain id travels in the query string, so the URL opens the same
 * graph no matter which brain the receiving session has active.
 *
 * The third thing worth pinning is the blocked-popup path: `openGraphPopup` has to
 * report failure rather than leave a click looking broken, which means it can never
 * assume `window.open` returned a window.
 */

const BRAIN = "22222222-2222-4222-8222-222222222222";

const node = (overrides: Partial<GraphNode> = {}): GraphNode => ({
  id: "memory-1",
  index: 0,
  kind: "memory",
  label: "Deploy notes",
  type: "note",
  detail: null,
  tags: [],
  projectId: null,
  projectName: null,
  importance: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
  searchText: "deploy notes",
  ...overrides,
});

const open = vi.fn();
const focus = vi.fn();

/** A window just complete enough for the three globals this module touches. */
function stubWindow(availWidth: number, availHeight: number): void {
  vi.stubGlobal("window", {
    location: { origin: "https://aether.byafr.dev" },
    screen: { availWidth, availHeight },
    open,
  });
}

/** Parse the features string `window.open` was called with into a lookup. */
function features(): Record<string, string> {
  const raw = open.mock.calls[0]?.[2] as string | undefined;
  return Object.fromEntries(
    (raw ?? "").split(",").map((part) => {
      const [key, value] = part.split("=");
      return [key, value];
    })
  );
}

beforeEach(() => {
  open.mockReset();
  focus.mockReset();
  open.mockReturnValue({ focus });
  stubWindow(1920, 1080);
});

afterEach(() => {
  vi.unstubAllGlobals();
});
describe("graphWorkspacePath", () => {
  it("names the brain in the query string, so the link needs no session state", () => {
    expect(graphWorkspacePath(BRAIN)).toBe(`${GRAPH_POPUP_PATH}?brain=${BRAIN}`);
  });

  it("lives outside /brain, where the app shell would wrap it", () => {
    // The point of the pop-out is a graph with nothing else in it.
    expect(GRAPH_POPUP_PATH.startsWith("/brain")).toBe(false);
  });

  it("adds the focus node when there is one", () => {
    const url = new URL(graphWorkspacePath(BRAIN, "memory-1"), "https://x.test");
    expect(url.searchParams.get("brain")).toBe(BRAIN);
    expect(url.searchParams.get("focus")).toBe("memory-1");
  });

  it("omits focus for null, undefined and empty string alike", () => {
    for (const focusId of [null, undefined, ""]) {
      expect(graphWorkspacePath(BRAIN, focusId)).not.toContain("focus");
    }
  });

  it("escapes whatever it is handed instead of splicing it in raw", () => {
    const url = graphWorkspacePath("brain &1", "node=2&brain=other");
    expect(url).not.toContain("brain=other");
    const parsed = new URL(url, "https://x.test");
    expect(parsed.searchParams.get("brain")).toBe("brain &1");
    expect(parsed.searchParams.get("focus")).toBe("node=2&brain=other");
  });
});

describe("memoryHref", () => {
  it("deep links a memory into the memories list by its label", () => {
    expect(memoryHref(node({ label: "Deploy notes" }))).toBe(
      "/brain/memories?q=Deploy%20notes"
    );
  });

  it("returns null for an entity rather than inventing a route", () => {
    // Entities have no page of their own; a fabricated href would 404 on click.
    expect(memoryHref(node({ kind: "entity", label: "PostgreSQL" }))).toBeNull();
  });

  it("encodes a label that would otherwise add query parameters", () => {
    const href = memoryHref(node({ label: "a&b?c=d#e" }))!;
    expect(href).toBe("/brain/memories?q=a%26b%3Fc%3Dd%23e");
    expect(new URL(href, "https://x.test").searchParams.get("q")).toBe("a&b?c=d#e");
  });
});

describe("nodeShareUrl", () => {
  it("is absolute and reopens the graph centred on the node", () => {
    expect(nodeShareUrl(BRAIN, node({ id: "memory-9" }))).toBe(
      `https://aether.byafr.dev${GRAPH_POPUP_PATH}?brain=${BRAIN}&focus=memory-9`
    );
  });

  it("carries the brain, not the active-brain cookie, so a paste opens the same graph", () => {
    const url = new URL(nodeShareUrl(BRAIN, node())!);
    expect(url.searchParams.get("brain")).toBe(BRAIN);
  });

  it("returns null when no brain is known", () => {
    expect(nodeShareUrl(undefined, node())).toBeNull();
  });

  it("returns null on the server, where there is no origin to build on", () => {
    vi.unstubAllGlobals();
    expect(nodeShareUrl(BRAIN, node())).toBeNull();
  });
});

describe("openGraphPopup", () => {
  it("opens the workspace in one named window and focuses it", () => {
    expect(openGraphPopup(BRAIN, "memory-1")).toBe(true);

    const [url, target] = open.mock.calls[0];
    expect(url).toBe(graphWorkspacePath(BRAIN, "memory-1"));
    // A named target reuses the window instead of stacking a second pop-out.
    expect(target).toBe(GRAPH_POPUP_WINDOW);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("asks for a chromeless, resizable window", () => {
    openGraphPopup(BRAIN);

    const flags = features();
    expect(flags["popup"]).toBe("yes");
    expect(flags["resizable"]).toBe("yes");
    expect(flags["toolbar"]).toBe("no");
    expect(flags["menubar"]).toBe("no");
    expect(flags["location"]).toBe("no");
  });

  it("reports a blocked popup instead of pretending it opened", () => {
    open.mockReturnValue(null);

    expect(openGraphPopup(BRAIN)).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it("does nothing at all without a brain, or on the server", () => {
    expect(openGraphPopup(undefined)).toBe(false);
    expect(open).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    expect(openGraphPopup(BRAIN)).toBe(false);
  });
});

describe("openGraphPopup — the window fits the screen it is on", () => {
  it("scales to 80% x 85% of the available screen on a normal display", () => {
    stubWindow(1500, 1000);

    openGraphPopup(BRAIN);

    const flags = features();
    expect(flags["width"]).toBe("1200");
    expect(flags["height"]).toBe("850");
  });

  it("never grows past 1600x1000 on a very large display", () => {
    stubWindow(3840, 2160);

    openGraphPopup(BRAIN);

    const flags = features();
    expect(flags["width"]).toBe("1600");
    expect(flags["height"]).toBe("1000");
  });

  it("never shrinks below 900x600 on a small display", () => {
    // A hardcoded 1600x1000 would open mostly off-screen here.
    stubWindow(1024, 640);

    openGraphPopup(BRAIN);

    const flags = features();
    expect(flags["width"]).toBe("900");
    expect(flags["height"]).toBe("600");
  });

  it("centres the window, and never places it off the top-left edge", () => {
    stubWindow(1920, 1080);
    openGraphPopup(BRAIN);
    let flags = features();
    expect(Number(flags["left"])).toBe((1920 - Number(flags["width"])) / 2);
    expect(Number(flags["top"])).toBe((1080 - Number(flags["height"])) / 2);

    // Clamped minimum size on a small screen would otherwise compute a negative offset.
    open.mockReset();
    open.mockReturnValue({ focus });
    stubWindow(800, 500);
    openGraphPopup(BRAIN);
    flags = features();
    expect(Number(flags["left"])).toBe(0);
    expect(Number(flags["top"])).toBe(0);
  });
});

