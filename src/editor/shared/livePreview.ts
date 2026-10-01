// Shared with obsidian-latex-live / obsidian-tinymist: keep byte-identical (canonical copy: obsidian-tinymist/src/editor/shared).
//
// Live preview (编辑模式): the constructs a language scanner recognizes render in place and
// show their source while the cursor is on them, as in Obsidian's Live Preview. The language
// supplies `scan` (constructs, pure) and `decorate` (what each one looks like); this module owns
// the rules both languages share.
//   Field     one StateField holds every decoration: block widgets and replaced line breaks
//             are only legal from state (CodeMirror throws for them from a ViewPlugin). It
//             rebuilds on an edit, a focus change, `refreshLive`, new lint diagnostics, a
//             reconfiguration and the mouse coming up. A selection change re-decorates only
//             the constructs on the lines of the old and the new selection (nothing when there
//             are none): on a 5,700-line document a cursor move costs 0.2 ms, a rebuild 3 ms.
//             A construct whose look depends on the selection only on some of its lines (a
//             theorem box: its \begin and \end line) says so with `reveals`: a move inside a
//             long one keeps it, re-decorating only what is on the lines moved over.
//             Renders that land re-decorate only the constructs that waited for them.
//             While the mouse is down (Obsidian's freeze: nothing moves under a drag) and
//             during an IME composition the decorations are only mapped (a formula collapsing
//             next to the composition would replace DOM the IME is editing);
//             `compositionend` refreshes. The view draws the replacements within one line only
//             near the viewport (RangeSet.compare walks every replaced range of a set at each
//             update: 12,500 of them made a cursor move cost 1.2 ms); block replacements and
//             replaced line breaks must come from state, and atomic ranges and `replacedAt`
//             read the whole document.
//   Reveal    a construct shows its source while the editor has focus (or its search panel
//             is open: findNext keeps the focus there) and a selection range touches it,
//             inclusively at both ends (`$x$|` touches). Unfocused, everything renders. A
//             construct with an error diagnostic in it, or whose render failed, is never
//             replaced (the lint underline, or a dotted `lsp-lp-error` underline, stays).
//             `renderConstruct` applies this to a rendered construct: a block (whole lines)
//             reveals over its lines and keeps a rendering below its source, also while an
//             error diagnostic is in it (the preview replaces nothing: the last rendering
//             stays, marked when the new source fails).
//   Widgets   RenderWidget clones the renderer's node. CodeMirror hands a widget's DOM to
//             the next widget of the class at that place (a replaced block becomes the
//             preview below its revealed source), so updateDOM resyncs everything, and a
//             render still pending or failed keeps the last one shown (`is-pending`,
//             `is-error`) when that was the same construct's. Heights of blocks are measured
//             into a per-key cache for `estimatedHeight`.
//   Renders   `ctx.result` reads a per-renderer cache (past 2000 renders the oldest go, never
//             one an open view uses); a miss is queued and the construct stays source until
//             its render lands. The scheduler renders the viewport first: a synchronous
//             renderer in a microtask (before paint) with an 8 ms budget per run, the rest in
//             the next frames; an asynchronous one with one request in flight per renderer.
//             A renderer may answer some kinds synchronously and others not (LaTeX: MathJax,
//             and a PDF page or crop being drawn): while an asynchronous render is in flight,
//             requests of a kind that has answered with a promise wait for it, the others keep
//             rendering (a formula never waits for a PDF page). The rest of the document is
//             prefetched in idle chunks, nearest first, so scrolling finds its widgets. Results
//             of an older epoch are dropped; a new epoch empties the cache, but a construct
//             keeps showing its rendering from before (the same request under the old epoch:
//             its text is unchanged) until its new render lands, or fails and shows the source
//             (stale-while-revalidate: a template saved in another pane re-renders without a
//             flash of source). Those renderings are display-only (never a hit or a peek) and
//             count against the cache's bound. A request the epoch cannot change (an image, a
//             PDF crop: `ctx.request(.., epochFree)`) has no epoch in its key: its render stays
//             cached across epochs. One `refreshLive` per batch (async: per frame), held while
//             the mouse is down or a composition is open (both rebuild when they end).
//   Keys      none are bound. Vertical motion (keyArbiter hands the arrows to
//             cursorLineUp/Down, which skip lines under block widgets) is corrected by the
//             `enterBlocks` transaction filter: a line move (it carries a goal column) over
//             hidden lines stops on the block, which then reveals. Past a block where the
//             drawn viewport ends, CodeMirror estimates the next line's place and a move can
//             land one line further: the filter knows the viewport the view last drew.
//   Heights   a block widget whose size changes after CodeMirror measured it (MathJax's
//             glyph CSS, web fonts) bumps a line attribute (rAF-coalesced), which makes
//             CodeMirror measure again; without it, the gutter drifted from the lines in
//             documents shorter than the pane.
// `liveInput()` (focus, mouse, composition) is mounted permanently; `livePreview(...)` goes
// into `livePreviewCompartment`, which the mode toggle reconfigures (a field added by a
// reconfiguration never sees that transaction's effects, so input state lives outside it).
// Only type imports from "obsidian" are allowed here: tests bundle this without Obsidian.
import { forEachDiagnostic, setDiagnosticsEffect } from "@codemirror/lint";
import { searchPanelOpen } from "@codemirror/search";
import {
  ChangeDesc,
  Compartment,
  EditorSelection,
  EditorState,
  Extension,
  Facet,
  Range,
  RangeSet,
  StateEffect,
  StateField,
  Text,
  Transaction,
} from "@codemirror/state";
import {
  BlockWrapper,
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
  logException,
} from "@codemirror/view";

// ---- API -----------------------------------------------------------------------------

/** A span of source the scanner recognizes. A block construct owns whole lines. */
export interface Construct {
  readonly from: number;
  readonly to: number;
  readonly block?: boolean;
}

/** What a renderer draws. Equal keys render identically (build them with `ctx.request`). */
export interface RenderRequest {
  /** `${epoch}|${kind}|${display ? 1 : 0}|${src}`; `*` in place of the epoch for an epoch-free request. */
  readonly key: string;
  readonly src: string;
  readonly display: boolean;
  /** "math", "crop", "paper", "image": the widget's class is `lsp-lp-<kind>`. */
  readonly kind: string;
  /** Scheduling hint: requests in the viewport render first. */
  readonly pos: number;
}

/**
 * A rendering (a template: widgets clone it) or the renderer's message. A `quiet` failure
 * keeps the source without the error underline: the construct is fine, only a fragment of it
 * cannot render (Typst math that needs the code around it).
 */
export type RenderResult =
  | { readonly ok: true; readonly node: Element }
  | { readonly ok: false; readonly message: string; readonly quiet?: boolean };

export interface FragmentRenderer {
  /**
   * Results computed under an older epoch are dropped; a new epoch empties the cache. Until
   * a construct's render for the new epoch lands, it shows its rendering from the epoch
   * before (only for a request equal but for the epoch: keys built with `ctx.request`).
   * Epoch-free requests are kept.
   */
  readonly epoch: number;
  /**
   * A throw or a rejection counts as `{ ok: false, message }` (cached like one). Requests of a
   * kind that has answered with a promise render one at a time; while one is in flight, other
   * kinds go on.
   */
  render(req: RenderRequest): RenderResult | Promise<RenderResult>;
  /** After a batch of renders (LaTeX: MathJax's stylesheet). */
  flush?(): void;
  /**
   * Called with a listener while a live view uses this renderer; the renderer calls it when
   * its epoch changed (or anything else asks for a rebuild). Returns the unsubscribe.
   */
  subscribe?(onChange: () => void): () => void;
}

export interface LiveContext {
  readonly state: EditorState;
  /**
   * A selection range touches [from, to] (inclusive) and the editor has focus or its search
   * panel is open.
   */
  touch(from: number, to: number): boolean;
  /** touch() over the whole lines of [from, to]. */
  touchLines(from: number, to: number): boolean;
  /**
   * An error diagnostic lies in [from, to]: it overlaps the range, or is empty and inside it
   * (inclusively). One that only ends where the range starts, or starts where it ends, does not.
   */
  hasError(from: number, to: number): boolean;
  /**
   * A request keyed with the renderer's current epoch, or, `epochFree`, with none: for what the
   * epoch cannot change (an image, a PDF crop), whose render then outlives a new epoch.
   */
  request(kind: string, src: string, display: boolean, pos: number, epochFree?: boolean): RenderRequest;
  /**
   * The cached result, or undefined: then the request is queued and a refresh follows. While
   * a request of a new epoch is queued, its successful rendering from the epoch before comes
   * back instead (display-only: the render is still queued, and its result replaces it).
   */
  result(req: RenderRequest): RenderResult | undefined;
  /** The cached result without queueing a render (never an earlier epoch's rendering). */
  peek(req: RenderRequest): RenderResult | undefined;
  /** A replace decoration (atomic). One overlapping a replace added earlier is dropped. */
  replace(from: number, to: number, deco: Decoration): void;
  /** Marks and line decorations (never atomic). */
  mark(from: number, to: number, deco: Decoration): void;
  /** Point widgets, e.g. a block preview below a revealed block (`side: 1`). */
  point(pos: number, deco: Decoration): void;
  /** A BlockWrapper element around the lines of [from, to] (theorem boxes). */
  wrap(from: number, to: number, spec: BlockWrapperSpec): void;
}

export type BlockWrapperSpec = Parameters<typeof BlockWrapper.create>[0];

export interface LiveLanguage<C extends Construct = Construct> {
  /** The document's constructs in document order (by `from`). Pure; memoized per Text. */
  scan(doc: Text): readonly C[];
  /**
   * Where `decorate` tests the selection, when that is less than the construct's lines (a
   * theorem box: its \begin and \end line); null for its lines. A selection move elsewhere in it
   * keeps its decorations (only the constructs on the lines moved over are decorated again), one
   * there re-decorates it whole.
   */
  reveals?(c: C): readonly (readonly [number, number])[] | null;
  /**
   * A construct's decorations. They must lie within the construct's own lines and depend on
   * the selection only there (or only on its `reveals`): a selection move re-decorates just the
   * constructs on the lines it left or entered (and those on their lines, for nesting), keeping
   * the rest.
   */
  decorate(c: C, ctx: LiveContext): void;
}

export interface LivePreviewConfig<C extends Construct = Construct> {
  language: LiveLanguage<C>;
  renderer: FragmentRenderer;
  /** Longer documents get no decorations (default LIVE_MAX_LINES). */
  maxLines?: number;
}

/** Documents longer than this stay source: the mode toggle refuses them. */
export const LIVE_MAX_LINES = 10_000;

/** Holds `livePreview(...)` in live mode and nothing in source mode. */
export const livePreviewCompartment = new Compartment();

/**
 * Rebuild the decorations (labels loaded, an epoch bump): `null`. The scheduler passes the
 * keys of renders that landed instead, which re-decorates only the constructs waiting for them.
 */
export const refreshLive = StateEffect.define<readonly string[] | null>();

// ---- Input state (always mounted) ----------------------------------------------------

interface LiveInputState {
  readonly focused: boolean;
  readonly mouse: boolean;
}

const NO_INPUT: LiveInputState = { focused: false, mouse: false };
const setFocus = StateEffect.define<boolean>();
const setMouse = StateEffect.define<boolean>();

const inputField = StateField.define<LiveInputState>({
  create: () => NO_INPUT,
  update(v, tr) {
    for (const e of tr.effects) {
      if (e.is(setFocus) && e.value !== v.focused) v = { ...v, focused: e.value };
      else if (e.is(setMouse) && e.value !== v.mouse) v = { ...v, mouse: e.value };
    }
    return v;
  },
});

const inputOf = (state: EditorState): LiveInputState => state.field(inputField, false) ?? NO_INPUT;

/**
 * Reveal follows the selection while the editor has focus or its search panel is open: the
 * panel's findNext and replace keep the focus in its field, and the current match must show.
 */
const revealing = (state: EditorState): boolean => inputOf(state).focused || searchPanelOpen(state);

class InputPlugin {
  private readonly win: Window;
  private destroyed = false;
  private focusSyncPending = false;

  constructor(private readonly view: EditorView) {
    this.win = view.dom.ownerDocument.defaultView ?? window;
    this.win.addEventListener("mouseup", this.up, true);
    this.win.addEventListener("dragend", this.up, true);
    this.win.addEventListener("blur", this.up);
    this.syncFocus();
  }

  update(): void {
    if (this.view.hasFocus !== inputOf(this.view.state).focused) this.syncFocus();
  }

  private syncFocus(): void {
    if (this.focusSyncPending) return;
    this.focusSyncPending = true;
    // A new state starts unfocused. CodeMirror can also drop its queued focus effect
    // when another update (a render landing, for example) changes the state first.
    // Reconcile the current state after updates, never dispatch from a plugin update.
    queueMicrotask(() => {
      this.focusSyncPending = false;
      const { view } = this;
      // compositionend's refresh will sync it once the IME no longer owns the DOM.
      if (view.composing) return;
      if (!this.destroyed && view.hasFocus !== inputOf(view.state).focused) {
        // The lost transaction may also carry other focus mirrors (cursor preview).
        // Apply the view's focus hooks together, just as CodeMirror would have done.
        const state = view.state;
        const effects = state.facet(EditorView.focusChangeEffect).flatMap((f) => f(state, view.hasFocus) ?? []);
        view.dispatch({ effects });
      }
    });
  }

  private readonly up = () => {
    setTimeout(() => {
      const { view } = this;
      if (this.destroyed || !inputOf(view.state).mouse) return;
      view.dispatch({ effects: setMouse.of(false) });
      if (isLive(view.state)) keepHeadInView(view);
    });
  };

  destroy(): void {
    this.destroyed = true;
    this.win.removeEventListener("mouseup", this.up, true);
    this.win.removeEventListener("dragend", this.up, true);
    this.win.removeEventListener("blur", this.up);
  }
}

const inputPlugin = ViewPlugin.fromClass(InputPlugin, {
  eventHandlers: {
    // Runs before CodeMirror's own mousedown, so the selection it sets is already frozen.
    mousedown(e, view) {
      if (e.button === 0 && isLive(view.state) && !inputOf(view.state).mouse) {
        view.dispatch({ effects: setMouse.of(true) });
      }
      return false;
    },
    compositionend(_e, view) {
      setTimeout(() => {
        if (isLive(view.state)) view.dispatch({ effects: refreshLive.of(null) });
      });
      return false;
    },
  },
});

const keepHeadKey = {};

/** After a click revealed a construct, the cursor may sit off-screen (Overleaf's scrollJumpAdjuster). */
function keepHeadInView(view: EditorView): void {
  const head = view.state.selection.main.head;
  view.requestMeasure({
    key: keepHeadKey,
    read(v) {
      const at = v.coordsAtPos(head);
      const box = v.scrollDOM.getBoundingClientRect();
      return !at || at.top < box.top || at.bottom > box.bottom;
    },
    write(off, v) {
      if (!off || v.state.selection.main.head !== head) return;
      queueMicrotask(() => v.dispatch({ effects: EditorView.scrollIntoView(head, { y: "nearest" }) }));
    },
  });
}

const INPUT: Extension = [
  inputField,
  inputPlugin,
  EditorView.focusChangeEffect.of((_state, focusing) => setFocus.of(focusing)),
];

/** Focus, mouse and composition state for live preview: mount always, outside the compartment. */
export function liveInput(): Extension {
  return INPUT;
}

// ---- Render cache and scheduler ------------------------------------------------------

/**
 * Renders kept per renderer, the oldest rendered out first (earlier epochs' renderings still
 * shown count too, and go before this epoch's). Renders the attached views' last builds use
 * are never dropped (a document with more constructs than this would otherwise evict and
 * re-render its own renders forever); eviction runs in passes, each time the cache has grown
 * by CACHE_SLACK past what the last pass left.
 */
const CACHE_SIZE = 2000;
const CACHE_SLACK = 200;
/** Per synchronous run of the scheduler; the rest waits for the next frame. */
const BUDGET_MS = 8;
/** Renders per idle callback when prefetching the part of the document out of view. */
const PREFETCH_CHUNK = 50;
const IDLE_TIMEOUT_MS = 200;
const SAMPLES = 1000;

const now = () => performance.now();

interface Job {
  req: RenderRequest;
  view: EditorView;
}

/** The keys of the renders that landed in a batch, per view waiting for them. */
type Landed = Map<EditorView, Set<string>>;

function land(landed: Landed, job: Job): void {
  let keys = landed.get(job.view);
  if (!keys) landed.set(job.view, (keys = new Set()));
  keys.add(job.req.key);
}

function frame(win: Window, f: () => void): void {
  if (typeof win.requestAnimationFrame === "function") win.requestAnimationFrame(() => f());
  else setTimeout(f, 16);
}

type IdleDeadlineLike = { didTimeout: boolean; timeRemaining(): number };

function idle(win: Window, f: (deadline: IdleDeadlineLike) => void): void {
  const ric = (win as Window & { requestIdleCallback?: Window["requestIdleCallback"] }).requestIdleCallback;
  if (typeof ric === "function") ric.call(win, f, { timeout: IDLE_TIMEOUT_MS });
  else setTimeout(() => f({ didTimeout: true, timeRemaining: () => 0 }), 50);
}

function record(samples: number[], ms: number): void {
  samples.push(ms);
  if (samples.length > SAMPLES) samples.splice(0, samples.length - SAMPLES);
}

function percentile(samples: readonly number[], p: number): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(2);
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const isPromise = <T>(v: T | Promise<T>): v is Promise<T> =>
  typeof (v as { then?: unknown } | null)?.then === "function";

/** Marks, in a build's `used` keys, an earlier epoch's rendering it shows (by request identity). */
const SHOWN = "~";
/** The key prefix of an epoch-free request (in place of `${epoch}|`). */
const EPOCH_FREE = "*|";

/** One renderer's cache, queue and statistics, shared by the views that use it. */
class RenderStore {
  epoch: number;
  private readonly cache = new Map<string, RenderResult>();
  /**
   * Successful renders of earlier epochs by request identity (the key without its epoch),
   * oldest first: shown in place of a request of this epoch until its own result is cached.
   */
  private readonly previous = new Map<string, RenderResult>();
  readonly views = new Set<EditorView>();
  /**
   * The keys of the asynchronous renders in flight: one, except when a kind answers with a
   * promise for the first time while another is in flight (at most one more per kind).
   */
  private readonly inflight = new Set<string>();
  /**
   * Per request kind: it has answered with a promise (true: one at a time) or only
   * synchronously (false: renders while another is in flight, as a kind not seen yet does).
   */
  private readonly kinds = new Map<string, boolean>();
  private pumpQueued = false;
  /** A run went over its budget: the next frame goes on with it. */
  private frameQueued = false;
  private idleQueued = false;
  /** Size at which the next eviction pass runs. */
  private limit = CACHE_SIZE + CACHE_SLACK;
  /** Prefetch renders left in the current idle chunk (async renders continue it). */
  private chunkLeft = 0;
  private unsubscribe: (() => void) | null = null;
  renders = 0;
  hits = 0;
  misses = 0;
  readonly renderTimes: number[] = [];
  builds = 0;
  readonly buildTimes: number[] = [];

  constructor(readonly renderer: FragmentRenderer) {
    this.epoch = renderer.epoch;
  }

  /**
   * When the renderer moved to a new epoch: empty the cache but for epoch-free requests,
   * keeping its successful renders (and those of earlier epochs not rendered again yet) to
   * show until the new ones land.
   */
  sync(): void {
    if (this.renderer.epoch === this.epoch) return;
    const prefix = `${this.epoch}|`;
    for (const [key, result] of this.cache) {
      if (key.startsWith(EPOCH_FREE)) continue;
      this.cache.delete(key);
      if (!result.ok || !key.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      this.previous.delete(id);
      this.previous.set(id, result);
    }
    this.epoch = this.renderer.epoch;
    if (this.size > this.limit) this.evict();
  }

  /** Renders held: this epoch's and earlier ones still waiting to be shown again. */
  get size(): number {
    return this.cache.size + this.previous.size;
  }

  get(key: string): RenderResult | undefined {
    return this.cache.get(key);
  }

  /**
   * The request's identity: its key without this epoch (null for a key of another epoch, and
   * for an epoch-free one, which a new epoch keeps as it is).
   */
  private identity(key: string): string | null {
    const prefix = `${this.epoch}|`;
    return key.startsWith(prefix) ? key.slice(prefix.length) : null;
  }

  /**
   * The rendering an earlier epoch made for `key`'s request, to show while its own render is
   * pending; `used` records it (kept from eviction while shown).
   */
  shown(key: string, used: Set<string>): RenderResult | undefined {
    const id = this.identity(key);
    const result = id === null ? undefined : this.previous.get(id);
    if (result) used.add(SHOWN + id);
    return result;
  }

  private put(key: string, result: RenderResult): void {
    this.cache.delete(key);
    this.cache.set(key, result);
    // Its own result is in: the earlier rendering (or the source, on a failure) gives way.
    const id = this.identity(key);
    if (id !== null) this.previous.delete(id);
    if (this.size > this.limit) this.evict();
  }

  /**
   * Drop the oldest renders no attached view's last build used, earlier epochs' first (losing
   * one only shows a construct's source until its new render lands).
   */
  private evict(): void {
    const used: ReadonlySet<string>[] = [];
    for (const view of this.views) {
      const value = view.state.field(liveField, false);
      if (value) used.push(value.used);
    }
    for (const id of this.previous.keys()) {
      if (this.size <= CACHE_SIZE) break;
      if (!used.some((u) => u.has(SHOWN + id))) this.previous.delete(id);
    }
    for (const key of this.cache.keys()) {
      if (this.size <= CACHE_SIZE) break;
      if (!used.some((u) => u.has(key))) this.cache.delete(key);
    }
    this.limit = Math.max(CACHE_SIZE, this.size) + CACHE_SLACK;
  }

  get pending(): number {
    let n = 0;
    for (const view of this.views) n += view.state.field(liveField, false)?.missing.size ?? 0;
    return n;
  }

  attach(view: EditorView): void {
    this.views.add(view);
    if (this.views.size === 1 && this.renderer.subscribe) {
      this.unsubscribe = this.renderer.subscribe(() => {
        this.sync();
        for (const v of this.views) refreshSoon(v, null);
      });
    }
  }

  detach(view: EditorView): void {
    this.views.delete(view);
    this.limit = CACHE_SIZE + CACHE_SLACK;
    if (this.views.size) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private get win(): Window {
    const first = this.views.values().next().value;
    return first?.dom.ownerDocument.defaultView ?? window;
  }

  /** Render what the attached views miss (in a microtask: before the next paint). */
  schedule(): void {
    if (this.pumpQueued || this.frameQueued) return;
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pumpQueued = false;
      this.pump();
    });
  }

  /**
   * Every attached view's misses: those in its viewport in document order, then the rest,
   * nearest to the viewport first.
   */
  private collect(): { visible: Job[]; rest: Job[] } {
    const visible: Job[] = [];
    const rest: (Job & { dist: number })[] = [];
    for (const view of this.views) {
      const value = view.state.field(liveField, false);
      // Built under an older epoch: its refresh is on the way, with new keys.
      if (!value?.missing.size || value.epoch !== this.epoch) continue;
      const { from, to } = view.viewport;
      for (const { req } of value.missing.values()) {
        if (this.inflight.has(req.key)) continue;
        if (req.pos >= from && req.pos <= to) visible.push({ req, view });
        else rest.push({ req, view, dist: req.pos < from ? from - req.pos : req.pos - to });
      }
    }
    rest.sort((a, b) => a.dist - b.dist);
    return { visible, rest };
  }

  /** `job` waits for the asynchronous render in flight: its kind has answered with a promise. */
  private waits(job: Job): boolean {
    return this.inflight.size > 0 && this.kinds.get(job.req.kind) === true;
  }

  /**
   * An asynchronous render is in flight and no kind is known to answer synchronously (Typst):
   * nothing to do before it lands.
   */
  private get blocked(): boolean {
    if (!this.inflight.size) return false;
    for (const async of this.kinds.values()) if (!async) return false;
    return true;
  }

  private pump(): void {
    if (this.blocked || !this.views.size) return;
    const start = now();
    const landed: Landed = new Map();
    const { visible, rest } = this.collect();
    for (const job of visible) {
      if (this.cache.has(job.req.key)) {
        land(landed, job); // rendered for another view meanwhile
        continue;
      }
      if (this.waits(job)) continue;
      if (now() - start > BUDGET_MS) {
        this.frameQueued = true;
        frame(this.win, () => {
          this.frameQueued = false;
          this.pump();
        });
        this.landed(landed, false);
        return;
      }
      this.start(job, landed);
    }
    this.landed(landed, false);
    if (this.blocked || !rest.length) return;
    if (this.chunkLeft > 0) this.prefetch(null);
    else this.prefetchIdle();
  }

  private prefetchIdle(): void {
    if (this.idleQueued) return;
    this.idleQueued = true;
    idle(this.win, (deadline) => {
      this.idleQueued = false;
      this.chunkLeft = PREFETCH_CHUNK;
      this.prefetch(deadline);
    });
  }

  /** Render part of what is out of view (chunks of PREFETCH_CHUNK per idle callback). */
  private prefetch(deadline: IdleDeadlineLike | null): void {
    if (this.blocked || !this.views.size) return;
    const { visible, rest } = this.collect();
    // The viewport first. Visible misses already cached only wait for a refresh the mouse or a
    // composition holds: waiting for them would spin this through microtasks, and with it the
    // mouseup or compositionend that ends the hold would never run. Those waiting for the
    // render in flight start when it lands.
    if (visible.some((j) => !this.cache.has(j.req.key) && !this.waits(j))) return this.schedule();
    const landed: Landed = new Map();
    let more = false;
    for (const job of rest) {
      if (this.cache.has(job.req.key)) {
        land(landed, job);
        continue;
      }
      if (this.waits(job)) continue;
      if (this.chunkLeft <= 0 || (deadline && !deadline.didTimeout && deadline.timeRemaining() <= 0)) {
        more = true;
        break;
      }
      this.chunkLeft--;
      this.start(job, landed);
    }
    this.landed(landed, true);
    if (more) {
      this.chunkLeft = 0;
      this.prefetchIdle();
    } else if (!this.inflight.size) this.chunkLeft = 0;
    // else an async render continues the chunk when it lands
  }

  /**
   * Render one request. One that goes asynchronous is in flight until it lands (then the
   * scheduler runs again); its kind waits for it from then on.
   */
  private start(job: Job, landed: Landed): void {
    const { req } = job;
    const epoch = this.epoch;
    const t0 = now();
    let out: RenderResult | Promise<RenderResult>;
    try {
      out = this.renderer.render(req);
    } catch (e) {
      out = { ok: false, message: messageOf(e) };
    }
    this.renders++;
    if (!isPromise(out)) {
      if (!this.kinds.has(req.kind)) this.kinds.set(req.kind, false);
      record(this.renderTimes, now() - t0);
      this.put(req.key, out);
      land(landed, job);
      return;
    }
    this.kinds.set(req.kind, true);
    this.inflight.add(req.key);
    void out
      .then(
        (r) => r,
        (e: unknown): RenderResult => ({ ok: false, message: messageOf(e) }),
      )
      .then((r) => {
        this.inflight.delete(req.key);
        record(this.renderTimes, now() - t0);
        // A result computed under an older epoch describes macros or a preamble that are gone
        // (an epoch-free request's does not).
        if (req.key.startsWith(EPOCH_FREE) || (epoch === this.renderer.epoch && epoch === this.epoch)) {
          this.put(req.key, r);
          this.renderer.flush?.();
          for (const view of this.views) {
            if (view.state.field(liveField, false)?.missing.has(req.key)) refreshSoon(view, [req.key]);
          }
        }
        this.schedule(); // the viewport first, then the prefetch chunk goes on
      });
  }

  /** Renders of this batch landed: flush, then one refresh per view (now, or next frame). */
  private landed(landed: Landed, soon: boolean): void {
    if (!landed.size) return;
    this.renderer.flush?.();
    for (const [view, keys] of landed) {
      if (soon) refreshSoon(view, keys);
      else refreshNow(view, keys);
    }
  }
}

const stores = new WeakMap<FragmentRenderer, RenderStore>();

function storeFor(renderer: FragmentRenderer): RenderStore {
  let store = stores.get(renderer);
  if (!store) stores.set(renderer, (store = new RenderStore(renderer)));
  return store;
}

/** A view's refresh waiting for the next frame: the keys that landed, or null (rebuild). */
const refreshQueue = new WeakMap<EditorView, { keys: Set<string> | null }>();

/** Refresh a view now: the renders of `keys` landed, or (null) rebuild everything. */
function refreshNow(view: EditorView, keys: Iterable<string> | null): void {
  if (!view.state.field(liveField, false)) return;
  // Held until the mouse comes up or the composition ends: both rebuild anyway.
  if (inputOf(view.state).mouse || view.composing) return;
  view.dispatch({ effects: refreshLive.of(keys ? [...keys] : null) });
}

function refreshSoon(view: EditorView, keys: Iterable<string> | null): void {
  const queued = refreshQueue.get(view);
  if (queued) {
    if (!keys) queued.keys = null;
    else if (queued.keys) for (const key of keys) queued.keys.add(key);
    return;
  }
  refreshQueue.set(view, { keys: keys ? new Set(keys) : null });
  frame(view.dom.ownerDocument.defaultView ?? window, () => {
    const q = refreshQueue.get(view);
    refreshQueue.delete(view);
    refreshNow(view, q?.keys ?? null);
  });
}

// ---- The field -----------------------------------------------------------------------

/** A render some constructs wait for: its request and where those constructs start. */
interface Miss {
  readonly req: RenderRequest;
  readonly at: readonly number[];
}

interface LiveValue {
  readonly focused: boolean;
  /** Replacements that must come from state: blocks and ranges over line breaks (atomic). */
  readonly blocks: DecorationSet;
  /** Replacements within one line: widgets and hidden markup (atomic; drawn near the viewport). */
  readonly inline: DecorationSet;
  /** Marks, line decorations and point widgets. */
  readonly marks: DecorationSet;
  readonly wraps: RangeSet<BlockWrapper>;
  /** Requests this build missed, by key, in document order. */
  readonly missing: ReadonlyMap<string, Miss>;
  /** Every key this build read (hit, missed or peeked): never evicted while it lasts. */
  readonly used: ReadonlySet<string>;
  /** False above maxLines: no decorations. */
  readonly active: boolean;
  /** Mapped through changes without a rebuild (mouse down, composition). */
  readonly stale: boolean;
  /** The renderer's epoch at the build: its misses are only wanted while it lasts. */
  readonly epoch: number;
}

const liveConfig = Facet.define<LivePreviewConfig, LivePreviewConfig | null>({
  combine: (values) => values[0] ?? null,
});

/** Intervals sorted by `from`, with the running maximum of `to`, for overlap queries. */
class Intervals {
  /** Indices into the items given, sorted by `from`. */
  private readonly order: number[];
  private readonly froms: number[];
  private readonly maxTo: number[];

  constructor(private readonly items: readonly { from: number; to: number }[]) {
    this.order = items.map((_c, i) => i);
    if (!items.every((c, i) => i === 0 || items[i - 1].from <= c.from)) {
      this.order.sort((a, b) => items[a].from - items[b].from);
    }
    this.froms = this.order.map((i) => items[i].from);
    this.maxTo = [];
    let max = -1;
    for (const i of this.order) this.maxTo.push((max = Math.max(max, items[i].to)));
  }

  /** How many sorted items start at or before `pos`. */
  private upTo(pos: number): number {
    let lo = 0;
    let hi = this.froms.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.froms[mid] <= pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Some item intersects [from, to] (inclusive). */
  touches(from: number, to: number): boolean {
    const n = this.upTo(to);
    return n > 0 && this.maxTo[n - 1] >= from;
  }

  /** The indices (into the items given) of those intersecting [from, to]. */
  each(from: number, to: number, f: (index: number) => void): void {
    for (let k = this.upTo(to) - 1; k >= 0 && this.maxTo[k] >= from; k--) {
      if (this.items[this.order[k]].to >= from) f(this.order[k]);
    }
  }
}

interface Scan {
  constructs: readonly Construct[];
  /** Where the constructs test the selection (their spans, or `reveals`): item k is construct `of[k]`. */
  touched: Intervals;
  of: readonly number[];
}

const scans = new WeakMap<LiveLanguage, WeakMap<Text, Scan>>();
/** Languages whose scanner (or `reveals`) threw once (logged once). */
const failedScans = new WeakSet<LiveLanguage>();

function scanOf(language: LiveLanguage, state: EditorState): Scan {
  const { doc } = state;
  let perDoc = scans.get(language);
  if (!perDoc) scans.set(language, (perDoc = new WeakMap()));
  let scan = perDoc.get(doc);
  if (!scan) {
    let constructs: readonly Construct[];
    try {
      constructs = language.scan(doc);
    } catch (e) {
      // A scanner bug, or nesting deep enough to overflow its recursion: this text stays source
      // (an exception here would break every transaction).
      if (!failedScans.has(language)) logException(state, e, "live preview scan");
      failedScans.add(language);
      constructs = [];
    }
    let spans: readonly { from: number; to: number }[] = constructs;
    let of: number[] = constructs.map((_c, i) => i);
    if (language.reveals) {
      const narrowed: { from: number; to: number }[] = [];
      of = [];
      try {
        constructs.forEach((c, i) => {
          for (const [from, to] of language.reveals!(c) ?? [[c.from, c.to]]) {
            narrowed.push({ from, to });
            of.push(i);
          }
        });
        spans = narrowed;
      } catch (e) {
        // As a scanner bug: every construct tests its own lines.
        if (!failedScans.has(language)) logException(state, e, "live preview reveals");
        failedScans.add(language);
        of = constructs.map((_c, i) => i);
      }
    }
    perDoc.set(doc, (scan = { constructs, touched: new Intervals(spans), of }));
  }
  return scan;
}

const touchesRanges = (ranges: readonly { from: number; to: number }[], from: number, to: number) =>
  ranges.some((r) => r.from <= to && r.to >= from);

const EMPTY_MISSING: ReadonlyMap<string, Miss> = new Map();
const EMPTY_USED: ReadonlySet<string> = new Set();

function emptyValue(focused: boolean, active: boolean): LiveValue {
  return {
    focused,
    blocks: Decoration.none,
    inline: Decoration.none,
    marks: Decoration.none,
    wraps: RangeSet.empty,
    missing: EMPTY_MISSING,
    used: EMPTY_USED,
    active,
    stale: false,
    epoch: -1,
  };
}

interface Kept {
  from: number;
  to: number;
  deco: Decoration;
}

/** What decorating some constructs produced. */
interface Decorated {
  blocks: Range<Decoration>[];
  inline: Range<Decoration>[];
  marks: Range<Decoration>[];
  wraps: Range<BlockWrapper>[];
  missing: Map<string, { req: RenderRequest; at: number[] }>;
}

/** Run the language's `decorate` over `constructs` (in document order); `used` collects keys. */
function decorateAll(
  state: EditorState,
  cfg: LivePreviewConfig,
  store: RenderStore,
  focused: boolean,
  constructs: Iterable<Construct>,
  used: Set<string>,
): Decorated {
  const { doc } = state;
  const ranges = focused ? state.selection.ranges : [];
  const touch = (from: number, to: number) => touchesRanges(ranges, from, to);
  let errors: { spans: { from: number; to: number }[]; index: Intervals } | null = null;
  const kept: Kept[] = [];
  const marks: Range<Decoration>[] = [];
  const wraps: Range<BlockWrapper>[] = [];
  const missing = new Map<string, { req: RenderRequest; at: number[] }>();
  /** Where the construct being decorated starts (a miss waits there). */
  let current = 0;

  const ctx: LiveContext = {
    state,
    touch,
    touchLines: (from, to) => touch(doc.lineAt(from).from, doc.lineAt(to).to),
    hasError(from, to) {
      if (!errors) {
        const spans: { from: number; to: number }[] = [];
        forEachDiagnostic(state, (d, dFrom, dTo) => {
          if (d.severity === "error") spans.push({ from: dFrom, to: dTo });
        });
        errors = { spans, index: new Intervals(spans) };
      }
      const { spans } = errors;
      let found = false;
      errors.index.each(from, to, (i) => {
        const d = spans[i];
        if (d.from === d.to || (d.to > from && d.from < to)) found = true;
      });
      return found;
    },
    request: (kind, src, display, pos, epochFree) => ({
      key: `${epochFree ? EPOCH_FREE : `${store.epoch}|`}${kind}|${display ? 1 : 0}|${src}`,
      src,
      display,
      kind,
      pos,
    }),
    result(req) {
      used.add(req.key);
      const hit = store.get(req.key);
      if (hit) {
        store.hits++;
        return hit;
      }
      store.misses++;
      const miss = missing.get(req.key);
      if (miss) miss.at.push(current);
      else missing.set(req.key, { req, at: [current] });
      // A new epoch's render pending: the construct keeps its rendering from before.
      return store.shown(req.key, used);
    },
    peek(req) {
      used.add(req.key);
      return store.get(req.key);
    },
    replace(from, to, deco) {
      // Kept sorted by `from` and free of overlaps: the first replace of a place wins.
      let lo = 0;
      let hi = kept.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (kept[mid].from < from) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0 && kept[lo - 1].to > from && kept[lo - 1].from < to) return;
      for (let i = lo; i < kept.length && kept[i].from < to; i++) {
        if (kept[i].to > from) return;
      }
      kept.splice(lo, 0, { from, to, deco });
    },
    mark: (from, to, deco) => void marks.push(deco.range(from, to)),
    point: (pos, deco) => void marks.push(deco.range(pos)),
    wrap: (from, to, spec) => void wraps.push(BlockWrapper.create(spec).range(from, to)),
  };

  let failed = false;
  for (const c of constructs) {
    current = c.from;
    try {
      cfg.language.decorate(c, ctx);
    } catch (e) {
      if (!failed) logException(state, e, "live preview");
      failed = true;
    }
  }
  const blocks: Range<Decoration>[] = [];
  const inline: Range<Decoration>[] = [];
  let lineEnd = -1; // of the line the last replace started on (they come sorted)
  for (const k of kept) {
    const range = k.deco.range(k.from, k.to);
    if (k.from > lineEnd) lineEnd = doc.lineAt(k.from).to;
    if (k.deco.spec.block || k.to > lineEnd) blocks.push(range);
    else inline.push(range);
  }
  return { blocks, inline, marks, wraps, missing };
}

function build(state: EditorState, cfg: LivePreviewConfig, focused: boolean): LiveValue {
  const t0 = now();
  const store = storeFor(cfg.renderer);
  store.sync();
  if (state.doc.lines > (cfg.maxLines ?? LIVE_MAX_LINES)) return emptyValue(focused, false);
  const used = new Set<string>();
  const out = decorateAll(state, cfg, store, focused, scanOf(cfg.language, state).constructs, used);
  store.builds++;
  record(store.buildTimes, now() - t0);
  return {
    focused,
    blocks: Decoration.set(out.blocks, true),
    inline: Decoration.set(out.inline, true),
    marks: Decoration.set(out.marks, true),
    wraps: out.wraps.length ? BlockWrapper.set(out.wraps, true) : RangeSet.empty,
    missing: out.missing,
    used,
    active: true,
    stale: false,
    epoch: store.epoch,
  };
}

/** Constructs a partial re-decoration covers at most; more rebuild everything. */
const PATCH_MAX = 400;

/** Sorted, merged intervals. */
function merge(spans: [number, number][]): [number, number][] {
  spans.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [from, to] of spans) {
    const last = out[out.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/**
 * Re-decorate only the constructs on the lines of `spans` (and, for nesting, every construct
 * on those constructs' lines), replacing their decorations in place: a selection move (same
 * document, focus and epoch) or renders that landed. Null when a full build is due.
 */
function patch(
  value: LiveValue,
  state: EditorState,
  cfg: LivePreviewConfig,
  focused: boolean,
  spans: readonly (readonly [number, number])[],
): LiveValue | null {
  const store = storeFor(cfg.renderer);
  if (!value.active || value.epoch !== store.epoch || cfg.renderer.epoch !== store.epoch) return null;
  const t0 = now();
  const { doc } = state;
  const scan = scanOf(cfg.language, state);
  const lines = (from: number, to: number): [number, number] => [doc.lineAt(from).from, doc.lineAt(to).to];
  let region = merge(spans.map(([from, to]) => lines(from, to)));
  const picked = new Set<number>();
  for (let grew = true; grew; ) {
    grew = false;
    const spans: [number, number][] = [...region];
    for (const [from, to] of region) {
      scan.touched.each(from, to, (k) => {
        const i = scan.of[k];
        if (picked.has(i)) return;
        picked.add(i);
        grew = true;
        spans.push(lines(scan.constructs[i].from, scan.constructs[i].to));
      });
    }
    if (picked.size > PATCH_MAX) return null;
    region = merge(spans);
  }
  const constructs = [...picked].sort((a, b) => a - b).map((i) => scan.constructs[i]);
  // `used` only ever protects renders from eviction: sharing and growing it is safe.
  const used = value.used as Set<string>;
  const out = decorateAll(state, cfg, store, focused, constructs, used);
  const inside = (from: number, to: number) => region.some(([f, t]) => f <= from && to <= t);
  // The old decorations of the region go (all of them came from constructs in it).
  const drop = {
    sort: true,
    filter: (from: number, to: number) => !inside(from, to),
    filterFrom: region[0][0],
    filterTo: region[region.length - 1][1],
  };
  // The region's constructs asked again: their old misses go.
  const missing = new Map<string, Miss>();
  for (const [key, miss] of value.missing) {
    const at = miss.at.filter((p) => !inside(p, p));
    if (at.length) missing.set(key, at.length === miss.at.length ? miss : { req: miss.req, at });
  }
  for (const [key, miss] of out.missing) {
    const had = missing.get(key);
    missing.set(key, had ? { req: had.req, at: [...had.at, ...miss.at] } : miss);
  }
  store.builds++;
  record(store.buildTimes, now() - t0);
  return {
    ...value,
    blocks: value.blocks.update({ add: out.blocks, ...drop }),
    inline: value.inline.update({ add: out.inline, ...drop }),
    marks: value.marks.update({ add: out.marks, ...drop }),
    wraps: value.wraps.update({ add: out.wraps, ...drop }),
    missing,
  };
}

/** Renders of `keys` landed: re-decorate the constructs that waited for them. */
function patchLanded(value: LiveValue, state: EditorState, cfg: LivePreviewConfig, keys: readonly string[]): LiveValue | null {
  const spans: [number, number][] = [];
  for (const key of keys) for (const p of value.missing.get(key)?.at ?? []) spans.push([p, p]);
  // Nothing waits for them any more (a build since read them from the cache).
  if (!spans.length) return value;
  return patch(value, state, cfg, value.focused, spans);
}

function mapValue(value: LiveValue, changes: ChangeDesc): LiveValue {
  return {
    ...value,
    blocks: value.blocks.map(changes),
    inline: value.inline.map(changes),
    marks: value.marks.map(changes),
    wraps: value.wraps.map(changes),
    stale: true,
  };
}

/** A selection range is where a construct tests it (its lines, the widest range, or its `reveals`). */
function onConstruct(state: EditorState, cfg: LivePreviewConfig, sel: EditorSelection): boolean {
  const { doc } = state;
  const { touched } = scanOf(cfg.language, state);
  return sel.ranges.some((r) => touched.touches(doc.lineAt(r.from).from, doc.lineAt(r.to).to));
}

const liveField: StateField<LiveValue> = StateField.define<LiveValue>({
  create(state) {
    const cfg = state.facet(liveConfig);
    return cfg ? build(state, cfg, revealing(state)) : emptyValue(false, false);
  },
  update(value, tr) {
    const cfg = tr.state.facet(liveConfig);
    if (!cfg) return value;
    const focused = revealing(tr.state);
    let full = false;
    let landed: string[] | null = null;
    for (const e of tr.effects) {
      if (!e.is(refreshLive)) continue;
      if (e.value) (landed ??= []).push(...e.value);
      else full = true;
    }
    const refresh = full || landed !== null;
    if (!refresh && !tr.reconfigured && (inputOf(tr.state).mouse || tr.isUserEvent("input.type.compose"))) {
      return tr.docChanged ? mapValue(value, tr.changes) : value;
    }
    const rebuild =
      full ||
      tr.docChanged ||
      tr.reconfigured ||
      value.stale ||
      focused !== value.focused ||
      inputOf(tr.startState).mouse ||
      tr.effects.some((e) => e.is(setDiagnosticsEffect)) ||
      (landed !== null && !!tr.selection);
    if (rebuild) return build(tr.state, cfg, focused);
    if (landed) return patchLanded(value, tr.state, cfg, landed) ?? build(tr.state, cfg, focused);
    if (!tr.selection || !focused || !value.active) return value;
    // A cursor move that neither leaves nor enters a construct changes nothing; one that
    // does re-decorates the constructs on its lines.
    if (!onConstruct(tr.startState, cfg, tr.startState.selection) && !onConstruct(tr.state, cfg, tr.selection)) {
      return value;
    }
    const moved = [...tr.startState.selection.ranges, ...tr.selection.ranges].map((r): [number, number] => [r.from, r.to]);
    return patch(value, tr.state, cfg, true, moved) ?? build(tr.state, cfg, focused);
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.blocks),
    EditorView.decorations.of((view) => inlineNearViewport(view, view.state.field(f, false))),
    EditorView.decorations.from(f, (v) => v.marks),
    EditorView.blockWrappers.from(f, (v) => v.wraps),
    // Replaced ranges are atomic: arrows, Backspace and clicks step over them instead of
    // landing in hidden positions. Marks and point widgets are not.
    EditorView.atomicRanges.of((view) => view.state.field(f, false)?.blocks ?? Decoration.none),
    EditorView.atomicRanges.of((view) => view.state.field(f, false)?.inline ?? Decoration.none),
  ],
});

// ---- Drawing near the viewport -------------------------------------------------------

/** Characters on each side of the viewport whose one-line replacements are drawn too. */
const INLINE_MARGIN = 4000;

interface InlineWindow {
  value: LiveValue;
  /** The span around the viewport, and the lines of the main selection outside it. */
  spans: readonly [number, number][];
  set: DecorationSet;
}

const inlineWindows = new WeakMap<EditorView, InlineWindow>();

/**
 * The one-line replacements CodeMirror draws: those near the viewport and on the main
 * selection's lines (CodeMirror draws those lines too), kept per field value while the
 * viewport stays inside the span. Only drawing is limited: atomic ranges read the whole set.
 */
function inlineNearViewport(view: EditorView, value: LiveValue | undefined): DecorationSet {
  if (!value?.inline.size) return Decoration.none;
  const { doc, selection } = view.state;
  const { from, to } = view.viewport;
  const ends = [selection.main.anchor, selection.main.head];
  const within = (spans: readonly [number, number][], pos: number) => spans.some(([f, t]) => f <= pos && pos <= t);
  const last = inlineWindows.get(view);
  if (last && last.value === value && last.spans[0][0] <= from && to <= last.spans[0][1] && ends.every((p) => within(last.spans, p))) {
    return last.set;
  }
  const spans: [number, number][] = [[Math.max(0, from - INLINE_MARGIN), Math.min(doc.length, to + INLINE_MARGIN)]];
  for (const p of ends) {
    if (within(spans, p)) continue;
    const line = doc.lineAt(p);
    spans.push([line.from, line.to]);
  }
  const ranges: Range<Decoration>[] = [];
  // Merged spans are apart, so a range (within one line) starts in at most one.
  for (const [f, t] of merge(spans.map(([a, b]): [number, number] => [a, b]))) {
    value.inline.between(f, t, (a, b, deco) => {
      if (a >= f && a <= t) ranges.push(deco.range(a, b));
    });
  }
  const set = Decoration.set(ranges, true);
  inlineWindows.set(view, { value, spans, set });
  return set;
}

// ---- Vertical motion -----------------------------------------------------------------

/**
 * The viewport each view last drew, by the state it drew it for: a transaction filter sees no
 * view, and `enterBlocks` needs to know which lines CodeMirror only estimates.
 */
const drawn = new WeakMap<EditorState, { from: number; to: number }>();

const drawnViewport = ViewPlugin.define((view) => {
  drawn.set(view.state, view.viewport);
  return { update: (u) => void drawn.set(u.state, u.view.viewport) };
});

/**
 * The run of hidden block replacements over exactly the lines `lo`..`hi` (numbers): its first
 * block's start and its last block's end, or null when a visible line lies in between.
 */
function hiddenRun(deco: DecorationSet, doc: Text, lo: number, hi: number): { from: number; to: number } | null {
  const from = doc.line(lo).from;
  const to = doc.line(hi).to;
  const blocks: { from: number; to: number }[] = [];
  deco.between(from, to, (f, t, d) => {
    if (d.spec.block) blocks.push({ from: f, to: t });
  });
  if (!blocks.length) return null;
  blocks.sort((x, y) => x.from - y.from);
  let covered = from - 1;
  for (const blk of blocks) {
    if (blk.from > covered + 1) return null; // a visible line in between
    covered = Math.max(covered, blk.to);
  }
  return covered < to ? null : { from: blocks[0].from, to: covered };
}

/**
 * Where a line move from `oldHead` to `newHead` should stop instead: on the hidden run of
 * block replacements it jumped over, when those are exactly the lines in between (a visible
 * line there means a longer jump, PageDown). The move may also land inside the run: CodeMirror
 * puts it at the document's end or start when the run reaches there. It may also land one line
 * past the line after the run, when that line is outside the viewport the view drew (`viewport`):
 * CodeMirror then estimates where lines are by their characters, and a short line gets almost
 * no height. Down: the run's first block start; up: its last block end.
 */
function blockStop(
  deco: DecorationSet,
  doc: Text,
  oldHead: number,
  newHead: number,
  viewport?: { from: number; to: number },
): number | null {
  const a = doc.lineAt(oldHead).number;
  const b = doc.lineAt(newHead).number;
  if (Math.abs(b - a) < 2) return null;
  const down = b > a;
  let run = down ? hiddenRun(deco, doc, a + 1, b - 1) : hiddenRun(deco, doc, b + 1, a - 1);
  if (!run && viewport && Math.abs(b - a) >= 3) {
    const skipped = doc.line(down ? b - 1 : b + 1);
    if (down ? skipped.from > viewport.to : skipped.to < viewport.from) {
      run = down ? hiddenRun(deco, doc, a + 1, b - 2) : hiddenRun(deco, doc, b + 2, a - 1);
    }
  }
  if (!run) return null;
  return down ? run.from : run.to;
}

const enterBlocks = EditorState.transactionFilter.of((tr) => {
  // Exactly "select": cursor and selection motion (not pointer, search or other sub-events).
  if (!tr.selection || tr.docChanged || tr.annotation(Transaction.userEvent) !== "select") return tr;
  const value = tr.startState.field(liveField, false);
  if (!value?.active || !value.blocks.size) return tr;
  const old = tr.startState.selection.ranges;
  // Ranges pair up by index only while their number stays (Escape's simplifySelection, merges).
  if (old.length !== tr.selection.ranges.length) return tr;
  const viewport = drawn.get(tr.startState);
  let changed = false;
  const ranges = tr.selection.ranges.map((r, i) => {
    // Only line moves: cursorLineUp/Down, their Shift forms and PageUp/Down give the range a goal
    // column. Select All, Mod-Home/End, Cmd-ArrowUp/Down and snippet fields set none.
    if (r.goalColumn === undefined) return r;
    const stop = blockStop(value.blocks, tr.startState.doc, old[i].head, r.head, viewport);
    if (stop === null) return r;
    changed = true;
    return r.empty ? EditorSelection.cursor(stop, 0, undefined, r.goalColumn) : EditorSelection.range(r.anchor, stop, r.goalColumn);
  });
  return changed ? [tr, { selection: EditorSelection.create(ranges, tr.selection.mainIndex), sequential: true }] : tr;
});

// ---- Heights ---------------------------------------------------------------------------

/** Measured block heights by request key, for estimatedHeight. */
const heights = new Map<string, number>();

function setHeight(key: string, h: number): void {
  heights.delete(key);
  heights.set(key, h);
  if (heights.size > CACHE_SIZE) heights.delete(heights.keys().next().value!);
}

const remeasure = StateEffect.define<null>();

/** A line attribute that changes when a block widget resized: CodeMirror then measures again. */
const generation = StateField.define<number>({
  create: () => 0,
  update: (n, tr) => (tr.effects.some((e) => e.is(remeasure)) ? n + 1 : n),
  provide: (f) =>
    EditorView.decorations.compute([f], (state) =>
      Decoration.set(Decoration.line({ attributes: { "data-lp-gen": String(state.field(f)) } }).range(0)),
    ),
});

const remeasureFrames = new WeakSet<EditorView>();

function scheduleRemeasure(view: EditorView): void {
  if (remeasureFrames.has(view)) return;
  remeasureFrames.add(view);
  frame(view.dom.ownerDocument.defaultView ?? window, () => {
    remeasureFrames.delete(view);
    if (view.state.field(generation, false) === undefined) return; // no longer live
    // Redrawing line 1 under an open composition could disturb it: try again later.
    if (view.composing) scheduleRemeasure(view);
    else view.dispatch({ effects: remeasure.of(null) });
  });
}

// ---- Widgets ---------------------------------------------------------------------------

export type RenderMode = "inline" | "block" | "below";

interface WidgetDom {
  /** The request whose rendering the element shows or waits for. */
  key: string;
  /** A rendering is on screen (kept while a newer one is pending or failed). */
  rendered: boolean;
  ro: ResizeObserver | null;
  height: number;
}

const widgetDoms = new WeakMap<HTMLElement, WidgetDom>();

/**
 * A rendered construct: "inline" replaces an inline range, "block" whole lines, "below" is
 * the preview under a revealed block. `result` undefined means pending.
 */
export class RenderWidget extends WidgetType {
  constructor(
    readonly req: RenderRequest,
    readonly result: RenderResult | undefined,
    readonly mode: RenderMode,
  ) {
    super();
  }

  eq(other: RenderWidget): boolean {
    return other.req.key === this.req.key && other.mode === this.mode && other.result === this.result;
  }

  private get tag(): string {
    return this.mode === "inline" ? "SPAN" : "DIV";
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = view.dom.ownerDocument.createElement(this.tag.toLowerCase());
    const state: WidgetDom = { key: this.req.key, rendered: false, ro: null, height: -1 };
    widgetDoms.set(dom, state);
    this.sync(dom, state, view);
    return dom;
  }

  /**
   * CodeMirror hands over the DOM of any widget of this class it dropped (`from` is the widget
   * it showed). A pending or failed result keeps what is shown, so it takes only this
   * construct's own DOM: the same request, or the preview below the block being edited.
   * Another construct's rendering (a block that went back to source) would show under this one.
   */
  updateDOM(dom: HTMLElement, view: EditorView, from?: WidgetType): boolean {
    const state = widgetDoms.get(dom);
    if (!state || dom.tagName !== this.tag) return false;
    if (!this.result?.ok) {
      const own = from instanceof RenderWidget && (from.req.key === this.req.key || (from.mode === "below" && this.mode === "below"));
      if (!own) return false;
    }
    this.sync(dom, state, view);
    return true;
  }

  /** Classes, attributes and content from this widget, whatever the element showed before. */
  private sync(dom: HTMLElement, state: WidgetDom, view: EditorView): void {
    const { req, result, mode } = this;
    state.key = req.key;
    let cls = `lsp-lp-render lsp-lp-${req.kind}`;
    if (req.display) cls += " is-display";
    if (mode !== "inline") cls += " is-block";
    if (mode === "below") cls += " is-below";
    const loud = !!result && !result.ok && !result.quiet;
    if (!result) cls += " is-pending";
    else if (loud) cls += " is-error";
    dom.className = cls;
    if (loud) dom.title = result.message;
    else dom.removeAttribute("title");
    if (result?.ok) {
      dom.replaceChildren(result.node.cloneNode(true));
      state.rendered = true;
    } else if (loud && !state.rendered) {
      const msg = dom.ownerDocument.createElement("span");
      msg.className = "lsp-lp-message";
      msg.textContent = result.message;
      dom.replaceChildren(msg);
    }
    // Pending or quiet: whatever is shown stays.
    if (mode === "inline") {
      state.ro?.disconnect();
      state.ro = null;
    } else if (!state.ro) {
      observe(dom, state, view);
    }
  }

  destroy(dom: HTMLElement): void {
    widgetDoms.get(dom)?.ro?.disconnect();
  }

  get estimatedHeight(): number {
    if (this.mode === "inline") return -1;
    return heights.get(this.req.key) ?? 40 * this.req.src.split("\n").length;
  }

  ignoreEvent(): boolean {
    // Clicks go to CodeMirror: the cursor lands at the widget's side, which reveals it.
    return false;
  }
}

function observe(dom: HTMLElement, state: WidgetDom, view: EditorView): void {
  const RO = view.dom.ownerDocument.defaultView?.ResizeObserver;
  if (typeof RO !== "function") return;
  state.ro = new RO(() => {
    const h = dom.getBoundingClientRect().height;
    if (h <= 0) return;
    setHeight(state.key, h);
    // The first size is the one CodeMirror measured itself; later changes it missed.
    const changed = state.height >= 0 && Math.abs(h - state.height) > 0.5;
    state.height = h;
    if (changed) scheduleRemeasure(view);
  });
  state.ro.observe(dom);
}

/** Text in place of source: chips (`\ref`, `@label`), bullets, titles. */
export class TextWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly cls: string,
    readonly title?: string,
  ) {
    super();
  }

  eq(other: TextWidget): boolean {
    return other.text === this.text && other.cls === this.cls && other.title === this.title;
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = view.dom.ownerDocument.createElement("span");
    this.updateDOM(dom);
    return dom;
  }

  updateDOM(dom: HTMLElement): boolean {
    dom.className = this.cls;
    dom.textContent = this.text;
    if (this.title) dom.title = this.title;
    else dom.removeAttribute("title");
    return true;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const errorMark = Decoration.mark({ class: "lsp-lp-error" });

/**
 * The reveal rules for a construct drawn by the renderer (math, crops). A block (whole lines)
 * is replaced by a block widget and reveals over its lines, keeping a rendering below its
 * source (`below: false` drops it: a crop of a changed block would be stale); an inline
 * construct is replaced by an inline widget and reveals when touched (no render is asked for
 * while it is revealed). Never replaced: a construct with an error diagnostic (its lint
 * underline shows), one whose render failed (dotted `lsp-lp-error` underline, except for a
 * quiet failure or under an error diagnostic; the render hover shows the message), one still
 * pending (it stays source). A revealed block keeps its rendering below while an error
 * diagnostic is in it: the preview replaces nothing, and shows the last rendering (marked
 * `is-error` when the new source fails) while the source is typed.
 */
export function renderConstruct(
  ctx: LiveContext,
  c: Construct,
  req: RenderRequest,
  opts: { below?: boolean } = {},
): void {
  const error = ctx.hasError(c.from, c.to);
  const { doc } = ctx.state;
  if (c.block) {
    const from = doc.lineAt(c.from).from;
    const to = doc.lineAt(c.to).to;
    const revealed = ctx.touch(from, to);
    if (error && !revealed) return;
    const r = revealed && opts.below === false ? ctx.peek(req) : ctx.result(req);
    if (r && !r.ok && !r.quiet && !error) ctx.mark(c.from, c.to, errorMark);
    if (revealed) {
      if (opts.below !== false) {
        ctx.point(to, Decoration.widget({ widget: new RenderWidget(req, r, "below"), block: true, side: 1 }));
      }
    } else if (r?.ok) {
      ctx.replace(from, to, Decoration.replace({ widget: new RenderWidget(req, r, "block"), block: true }));
    }
    return;
  }
  if (error) return;
  const revealed = ctx.touch(c.from, c.to);
  const r = revealed ? ctx.peek(req) : ctx.result(req);
  if (r && !r.ok) {
    if (!r.quiet) ctx.mark(c.from, c.to, errorMark);
  } else if (r && !revealed) {
    ctx.replace(c.from, c.to, Decoration.replace({ widget: new RenderWidget(req, r, "inline") }));
  }
}

// ---- Extension and queries ----------------------------------------------------------------

class SchedulerPlugin {
  private store: RenderStore | null = null;

  constructor(private readonly view: EditorView) {
    this.attach();
    if (view.state.field(liveField, false)?.missing.size) this.store?.schedule();
  }

  update(u: ViewUpdate): void {
    this.attach();
    const value = u.state.field(liveField, false);
    if (!value?.missing.size) return;
    if (value !== u.startState.field(liveField, false) || u.viewportChanged) this.store?.schedule();
  }

  /** Follow the renderer through reconfigurations. */
  private attach(): void {
    const cfg = this.view.state.facet(liveConfig);
    const store = cfg ? storeFor(cfg.renderer) : null;
    if (store === this.store) return;
    this.store?.detach(this.view);
    this.store = store;
    store?.attach(this.view);
  }

  destroy(): void {
    this.store?.detach(this.view);
    this.store = null;
  }
}

const scheduler = ViewPlugin.fromClass(SchedulerPlugin);

/**
 * Live preview for one language and renderer. Put it in `livePreviewCompartment` (with
 * `liveInput()` mounted outside it). Binds no keys.
 */
export function livePreview<C extends Construct>(cfg: LivePreviewConfig<C>): Extension {
  return [
    liveConfig.of(cfg),
    liveField,
    enterBlocks,
    drawnViewport,
    generation,
    scheduler,
    EditorView.editorAttributes.of({ class: "lsp-lp-live" }),
  ];
}

/** Live preview is mounted (the compartment holds it). */
export function isLive(state: EditorState): boolean {
  return state.field(liveField, false) !== undefined;
}

/** Live preview is mounted and decorates: the document is within its `maxLines`. */
export function liveActive(state: EditorState): boolean {
  return state.field(liveField, false)?.active === true;
}

/** `pos` lies in (or at an end of) a range a live widget renders. */
export function replacedAt(state: EditorState, pos: number): boolean {
  const value = state.field(liveField, false);
  if (!value) return false;
  let found = false;
  const check = (from: number, to: number, d: Decoration) => {
    if (d.spec.widget && from <= pos && to >= pos) found = true;
    return found ? false : undefined;
  };
  value.inline.between(pos, pos, check);
  if (!found) value.blocks.between(pos, pos, check);
  return found;
}

export interface RenderStats {
  /** Renders run for this view's renderer. */
  renders: number;
  /** Renders held (this epoch's, and earlier epochs' still shown while their new render is pending). */
  cached: number;
  /** Cache hits and misses of the builds. */
  hits: number;
  misses: number;
  /** Requests the attached views still wait for. */
  pending: number;
  /** Render time percentiles, ms (async: request to result). */
  p50: number;
  p95: number;
  /**
   * Decoration builds (every edit, selection moves onto or off constructs, renders landing)
   * and their times, ms.
   */
  builds: number;
  buildP50: number;
  buildP95: number;
}

/** Numbers for "Show render statistics": zeros when the view is not live. */
export function renderStats(view: EditorView): RenderStats {
  const cfg = view.state.field(liveField, false) ? view.state.facet(liveConfig) : null;
  const s = cfg ? stores.get(cfg.renderer) : undefined;
  if (!s) return { renders: 0, cached: 0, hits: 0, misses: 0, pending: 0, p50: 0, p95: 0, builds: 0, buildP50: 0, buildP95: 0 };
  return {
    renders: s.renders,
    cached: s.size,
    hits: s.hits,
    misses: s.misses,
    pending: s.pending,
    p50: percentile(s.renderTimes, 0.5),
    p95: percentile(s.renderTimes, 0.95),
    builds: s.builds,
    buildP50: percentile(s.buildTimes, 0.5),
    buildP95: percentile(s.buildTimes, 0.95),
  };
}
