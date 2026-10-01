import type { Extension, Text } from "@codemirror/state";
import { Prec } from "@codemirror/state";
import { EditorView, ViewPlugin, closeHoverTooltip, hoverTooltip, type Tooltip, type TooltipView, type ViewUpdate } from "@codemirror/view";
import { argText, parseTex, type TexNode } from "../export/texTree";
import type { TheoremGraph, TheoremNode, TheoremSource } from "../tex/theoremGraph";
import { scanLatex } from "./latexScan";

export interface TheoremReferenceTarget { from: number; to: number; key: string }
export interface TheoremGraphResult { graph: TheoremGraph; selectedId: string | null; key: string }
export interface TheoremGraphHoverOptions {
  load(view: EditorView, key: string, signal: AbortSignal, reference: TheoremReferenceTarget): Promise<TheoremGraphResult | null>;
  renderContent(view: EditorView, node: TheoremNode, signal: AbortSignal): HTMLElement | Promise<HTMLElement>;
  openSource(source: TheoremSource): void | Promise<void>;
  subscribe?(view: EditorView, onChange: () => void): () => void;
  hoverTime?: number;
}

const refs = new WeakMap<Text, readonly TheoremReferenceTarget[]>();
const sig = { macros: new Map([["ref", "s m"]]), envs: new Map<string, string>() };
function literalRef(source: string, node: TexNode, base: number): TheoremReferenceTarget | null {
  if (node.t !== "macro" || node.code || node.name !== "ref") return null;
  const key = argText(source, node.args[1]).trim();
  return key && !/[\\{}]/.test(key) ? { from: base + node.from, to: base + node.to, key } : null;
}
/** A graph-specific scan, including refs within math without interpreting comments or code. */
export function theoremReferences(doc: Text): readonly TheoremReferenceTarget[] {
  const cached = refs.get(doc); if (cached) return cached;
  const found: TheoremReferenceTarget[] = [];
  const descend = (source: string, nodes: readonly TexNode[], base: number, depth: number) => {
    if (depth > 8) return;
    for (const node of nodes) {
      const ref = literalRef(source, node, base); if (ref) found.push(ref);
      if (node.t === "macro" && node.code) continue;
      if (node.t === "math") {
        const inner = source.slice(node.srcFrom, node.srcTo);
        descend(inner, parseTex(inner, sig), base + node.srcFrom, depth + 1);
      } else if (node.t === "group") descend(source, node.body, base, depth + 1);
      else if (node.t === "macro" || node.t === "env") {
        for (const arg of node.args) if (arg.body) descend(source, arg.body, base, depth + 1);
        if (node.t === "env") descend(source, node.body, base, depth + 1);
      }
    }
  };
  for (const construct of scanLatex(doc)) {
    if (construct.kind !== "math" && !(construct.kind === "ref" && construct.command === "ref")) continue;
    const source = doc.sliceString(construct.from, construct.to);
    descend(source, parseTex(source, sig), construct.from, 0);
  }
  const unique = [...new Map(found.map(ref => [`${ref.from}:${ref.to}`, ref])).values()].sort((a, b) => a.from - b.from);
  refs.set(doc, unique); return unique;
}

/** Widget offsets can map through edits. Resolve its current DOM position, never trust old data. */
export function theoremReferenceAt(view: EditorView, pos: number, side: -1 | 1, widget?: HTMLElement | null): TheoremReferenceTarget | null {
  const list = theoremReferences(view.state.doc);
  if (widget?.dataset.llRefCommand === "ref" && view.contentDOM.contains(widget)) {
    try {
      const mapped = view.posAtDOM(widget);
      const key = widget.dataset.llRefKey;
      return list.find(ref => ref.key === key && ref.from <= mapped && mapped <= ref.to) ?? null;
    } catch { return null; }
  }
  return list.find(ref => ref.from <= pos && pos <= ref.to && !(side < 0 && pos <= ref.from) && !(side > 0 && pos >= ref.to)) ?? null;
}

let popupId = 0;
const title = (node: TheoremNode) => `${node.name}${node.number ? ` ${node.number}` : ""}${node.title ? ` (${node.title})` : ""}`;
const sourceName = (source: TheoremSource) => `${source.file.split(/[\\/]/).at(-1)}:${source.line}`;
const composing = (view: EditorView) => view.composing || view.compositionStarted;

/** Dedicated to LaTeX: no keys, shared-widget edits, graph writes, or external KG provider. */
export function theoremGraphHover(options: TheoremGraphHoverOptions): Extension {
  let hover: ReturnType<typeof hoverTooltip>;
  const lifecycle = ViewPlugin.define(view => new HoverLife(view, options, () => {
    queueMicrotask(() => { if (view.plugin(lifecycle)) view.dispatch({ effects: closeHoverTooltip(hover) }); });
  }), {
    eventHandlers: {
      mousemove(event, view) {
        const target = event.target as Element | null;
        const life = view.plugin(lifecycle);
        if (life && !target?.closest?.(".ll-theorem-graph")) life.widget = target?.closest?.("[data-ll-ref-key]") as HTMLElement | null;
        return false;
      },
      compositionstart(_event, view) { view.plugin(lifecycle)?.invalidate(); return false; },
      mousedown(event, view) {
        if (!(event.target as Element | null)?.closest?.(".ll-theorem-graph")) view.plugin(lifecycle)?.down();
        return false;
      },
    },
  });
  hover = hoverTooltip((view, pos, side) => {
    const life = view.plugin(lifecycle);
    if (!life || life.holding || composing(view)) return null;
    const target = theoremReferenceAt(view, pos, side, life.widget);
    return target ? life.load(target) : null;
  }, { hoverTime: options.hoverTime ?? 300, hideOnChange: true });
  return [lifecycle, Prec.high(hover)];
}

class HoverLife {
  widget: HTMLElement | null = null;
  holding = false;
  private controller: AbortController | null = null;
  private popup: { destroy(): void } | null = null;
  private generation = 0;
  private stopped = false;
  private wasComposing = false;
  private unsubscribe?: () => void;
  private readonly win: Window;
  constructor(private view: EditorView, private options: TheoremGraphHoverOptions, private close: () => void) {
    this.win = view.dom.ownerDocument.defaultView ?? window;
    this.win.addEventListener("mouseup", this.up, true);
    this.win.addEventListener("pointercancel", this.up, true);
    this.win.addEventListener("blur", this.up);
    this.unsubscribe = options.subscribe?.(view, () => this.invalidate());
  }
  down(): void { this.holding = true; this.invalidate(); }
  private readonly up = () => { this.holding = false; };
  update(update: ViewUpdate): void {
    const now = composing(update.view), entered = now && !this.wasComposing; this.wasComposing = now;
    if (update.docChanged || update.selectionSet || entered) this.invalidate();
  }
  invalidate(): void {
    const active = !!this.controller || !!this.popup;
    this.generation++; this.controller?.abort(); this.controller = null;
    this.popup?.destroy(); this.popup = null; if (active) this.close();
  }
  async load(target: TheoremReferenceTarget): Promise<Tooltip | null> {
    this.controller?.abort();
    const controller = this.controller = new AbortController();
    const generation = ++this.generation;
    const doc = this.view.state.doc, selection = this.view.state.selection;
    const valid = () => !this.stopped && !this.holding && !controller.signal.aborted && generation === this.generation && !composing(this.view) && doc === this.view.state.doc && selection.eq(this.view.state.selection);
    try {
      const result = await this.options.load(this.view, target.key, controller.signal, target);
      if (!result || !valid()) return null;
      return { pos: target.from, end: target.to, above: true, create: () => {
        if (!valid()) { this.close(); const dom = this.view.dom.ownerDocument.createElement("div"); dom.hidden = true; return { dom }; }
        const popup = new GraphPopup(this.view, this.options, result, () => this.invalidate());
        this.popup?.destroy(); this.popup = popup;
        return popup;
      } };
    } catch (error) {
      if (!valid()) return null;
      return { pos: target.from, end: target.to, above: true, create: () => {
        if (!valid()) { this.close(); const dom = this.view.dom.ownerDocument.createElement("div"); dom.hidden = true; return { dom }; }
        const dom = this.view.dom.ownerDocument.createElement("div"); dom.className = "ll-theorem-graph is-error";
        dom.textContent = `引用关系无法读取：${error instanceof Error ? error.message : String(error)}`;
        const errorView = { dom, destroy: () => { dom.remove(); if (this.popup === errorView) this.popup = null; } };
        this.popup = errorView; return errorView;
      } };
    }
  }
  destroy(): void {
    this.stopped = true; this.generation++; this.controller?.abort(); this.popup?.destroy(); this.unsubscribe?.();
    this.win.removeEventListener("mouseup", this.up, true);
    this.win.removeEventListener("pointercancel", this.up, true);
    this.win.removeEventListener("blur", this.up);
  }
}

interface Card { dom: HTMLElement; button: HTMLButtonElement; body: HTMLElement; node: TheoremNode; open: boolean; controller?: AbortController; rendered?: HTMLElement }
class GraphPopup implements TooltipView {
  readonly dom: HTMLElement;
  private readonly diagram: HTMLElement;
  private readonly notices: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly cards = new Map<string, Card>();
  private readonly expanded = new Set<string>();
  private selected: string | null;
  private key: string;
  private destroyed = false;
  private observer?: ResizeObserver;
  private frame: number | null = null;
  private readonly marker = `ll-theorem-arrow-${++popupId}`;
  constructor(private view: EditorView, private options: TheoremGraphHoverOptions, private result: TheoremGraphResult, private close: () => void) {
    const doc = view.dom.ownerDocument;
    this.selected = result.selectedId; this.key = result.key;
    this.dom = doc.createElement("div"); this.dom.className = "ll-theorem-graph";
    this.dom.setAttribute("role", "dialog"); this.dom.setAttribute("aria-label", "证明引用关系");
    const head = this.dom.appendChild(doc.createElement("div")); head.className = "ll-theorem-graph-head";
    head.append(this.element("strong", "证明引用关系"), this.button("关闭", () => this.close()));
    this.dom.append(this.element("p", "箭头：某个定理的证明 → 被引用的定理。仅展示证明中显式的 \\ref。", "ll-theorem-graph-help"));
    this.notices = this.dom.appendChild(doc.createElement("div")); this.notices.className = "ll-theorem-graph-notices";
    this.diagram = this.dom.appendChild(doc.createElement("div")); this.diagram.className = "ll-theorem-diagram";
    this.svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg"); this.svg.classList.add("ll-theorem-arrows"); this.svg.setAttribute("aria-hidden", "true");
    this.dom.addEventListener("mousedown", event => event.stopPropagation());
    this.dom.addEventListener("click", event => {
      const link = (event.target as Element | null)?.closest?.("a[data-ll-theorem-key]") as HTMLElement | null;
      if (!link || !this.dom.contains(link)) return;
      event.preventDefault(); event.stopPropagation();
      const key = link.dataset.llTheoremKey!; const ids = this.result.graph.byLabel.get(key) ?? [];
      this.select(ids.length === 1 ? ids[0] : null, key);
    });
    if (this.selected) this.expanded.add(this.selected);
    this.draw();
  }
  private element(tag: string, text: string, cls?: string): HTMLElement {
    const element = this.dom.ownerDocument.createElement(tag); element.textContent = text; if (cls) element.className = cls; return element;
  }
  private button(label: string, action: () => void): HTMLButtonElement {
    const button = this.dom.ownerDocument.createElement("button"); button.type = "button"; button.textContent = label;
    button.addEventListener("click", action); return button;
  }
  private select(id: string | null, key: string): void {
    this.selected = id; this.key = key; this.expanded.clear(); if (id) this.expanded.add(id);
    this.draw();
    if (id) { const card = this.cards.get(id); if (card) { card.button.focus(); void this.toggle(card, true); } }
  }
  private card(node: TheoremNode): Card {
    let card = this.cards.get(node.id); if (card) return card;
    const dom = this.element("div", "", "ll-theorem-node"); dom.dataset.nodeId = node.id;
    const button = this.button(title(node), () => { void this.toggle(card!); }); button.className = "ll-theorem-node-title ll-theorem-graph-node"; button.dataset.nodeId = node.id; button.setAttribute("aria-expanded", "false");
    const actions = this.element("div", "", "ll-theorem-node-actions");
    const source = this.button("源文件", () => { void Promise.resolve(this.options.openSource(node.statement)).catch(() => {}); }); source.className = "ll-theorem-graph-source";
    const expand = this.button("显示引用", () => { this.expanded.add(node.id); this.draw(); card!.button.focus(); }); expand.className = "ll-theorem-graph-expand";
    actions.append(source, expand);
    dom.append(button, this.element("small", sourceName(node.statement)), actions);
    const body = this.element("div", "", "ll-theorem-content ll-theorem-graph-detail"); body.hidden = true; dom.append(body);
    card = { dom, button, body, node, open: false }; this.cards.set(node.id, card); return card;
  }
  private async toggle(card: Card, force = false): Promise<void> {
    if (this.destroyed || composing(this.view)) return;
    card.open = force || !card.open; card.body.hidden = !card.open; card.button.setAttribute("aria-expanded", String(card.open));
    if (!card.open) { card.controller?.abort(); card.controller = undefined; this.measure(); return; }
    if (card.rendered) { this.measure(); return; }
    card.controller?.abort(); const controller = card.controller = new AbortController();
    card.body.replaceChildren(this.element("p", "正在加载陈述与证明…")); this.measure();
    try {
      const content = await this.options.renderContent(this.view, card.node, controller.signal);
      if (this.destroyed || controller.signal.aborted || !card.open || composing(this.view)) return;
      card.rendered = content; card.body.replaceChildren(content); this.measure();
    } catch (error) {
      if (!this.destroyed && !controller.signal.aborted) { card.body.replaceChildren(this.element("p", `内容无法读取：${error instanceof Error ? error.message : String(error)}`)); this.measure(); }
    }
  }
  private draw(): void {
    const graph = this.result.graph;
    const focused = this.dom.contains(this.dom.ownerDocument.activeElement) ? this.dom.ownerDocument.activeElement as HTMLElement : null;
    this.notices.replaceChildren(); this.diagram.replaceChildren(this.svg);
    if (!this.selected || !graph.nodes.has(this.selected)) {
      const ids = graph.byLabel.get(this.key) ?? [];
      this.notices.append(this.element("p", ids.length > 1 ? `标签 ${this.key} 有多个定理来源，请选择。` : `标签 ${this.key} 未解析到当前项目的定理。`));
      for (const id of ids.slice(0, 25)) { const node = graph.nodes.get(id); if (node) this.notices.append(this.button(`${title(node)} · ${sourceName(node.statement)}`, () => this.select(id, this.key))); }
      if (ids.length > 25) this.notices.append(this.element("p", "仅显示前 25 个候选。"));
      return;
    }
    const depths = new Map([[this.selected, 0]]); const queue = [this.selected]; let truncated = false;
    while (queue.length) {
      const id = queue.shift()!; if (!this.expanded.has(id)) continue;
      for (const edge of graph.edges.filter(edge => edge.from === id)) {
        if (!graph.nodes.has(edge.to) || depths.has(edge.to)) continue;
        if (depths.size >= 25) { truncated = true; continue; }
        depths.set(edge.to, depths.get(id)! + 1); queue.push(edge.to);
      }
    }
    const columns = new Map<number, HTMLElement>();
    for (const [id, depth] of depths) {
      let column = columns.get(depth); if (!column) { column = this.element("div", "", "ll-theorem-column"); columns.set(depth, column); this.diagram.append(column); }
      const card = this.card(graph.nodes.get(id)!); card.dom.classList.toggle("is-selected", id === this.selected); column.append(card.dom);
      const more = card.dom.querySelector<HTMLButtonElement>(".ll-theorem-node-actions button:last-child")!;
      more.disabled = this.expanded.has(id) || !graph.edges.some(edge => edge.from === id);
    }
    const visibleEdges = graph.edges.filter(edge => depths.has(edge.from) && depths.has(edge.to));
    this.svg.dataset.edges = String(visibleEdges.length);
    if (visibleEdges.some(edge => depths.get(edge.to)! <= depths.get(edge.from)!)) this.notices.append(this.element("p", "存在回环或共享引用；同一定理只显示一次。"));
    if (truncated) this.notices.append(this.element("p", "节点较多，当前小窗最多显示 25 个节点。"));
    const relevant = graph.unresolved.filter(diag => diag.key === this.key || diag.targets?.some(id => depths.has(id)) || [...depths.keys()].some(id => {
      const node = graph.nodes.get(id)!;
      return [node.statement, ...node.proofs].some(source => source.file === diag.source.file && source.from <= diag.source.from && source.to >= diag.source.to);
    }));
    for (const diag of relevant.slice(0, 8)) this.notices.append(this.element("p", diag.message, `ll-theorem-diagnostic is-${diag.kind}`));
    if (focused?.isConnected && !(focused.tagName === "BUTTON" && (focused as HTMLButtonElement).disabled)) focused.focus();
    this.measure();
  }
  mount(): void {
    const win = this.dom.ownerDocument.defaultView;
    if (win?.ResizeObserver) { this.observer = new win.ResizeObserver(() => this.measure()); this.observer.observe(this.diagram); }
    this.measure();
  }
  update(): void { this.measure(); }
  private measure(): void {
    if (this.destroyed || this.frame !== null) return;
    const win = this.dom.ownerDocument.defaultView;
    if (!win) return;
    this.frame = win.requestAnimationFrame(() => { this.frame = null; if (!this.destroyed && this.dom.isConnected) this.arrows(); });
    this.view.requestMeasure();
  }
  private arrows(): void {
    const doc = this.dom.ownerDocument; const box = this.diagram.getBoundingClientRect();
    const width = Math.max(this.diagram.scrollWidth, box.width, 1), height = Math.max(this.diagram.scrollHeight, box.height, 1);
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`); this.svg.setAttribute("width", String(width)); this.svg.setAttribute("height", String(height));
    this.svg.replaceChildren(); const defs = doc.createElementNS(this.svg.namespaceURI, "defs"); const marker = doc.createElementNS(this.svg.namespaceURI, "marker");
    marker.setAttribute("id", this.marker); marker.setAttribute("viewBox", "0 0 10 10"); marker.setAttribute("refX", "9"); marker.setAttribute("refY", "5"); marker.setAttribute("markerWidth", "7"); marker.setAttribute("markerHeight", "7"); marker.setAttribute("orient", "auto");
    const triangle = doc.createElementNS(this.svg.namespaceURI, "path"); triangle.setAttribute("d", "M 0 0 L 10 5 L 0 10 z"); triangle.setAttribute("fill", "currentColor"); marker.append(triangle); defs.append(marker); this.svg.append(defs);
    for (const edge of this.result.graph.edges) {
      const from = this.cards.get(edge.from), to = this.cards.get(edge.to);
      if (!from || !to || !this.diagram.contains(from.dom) || !this.diagram.contains(to.dom)) continue;
      const a = from.button.getBoundingClientRect(), b = to.button.getBoundingClientRect(); const forward = b.left > a.left;
      const fromBox = from.dom.getBoundingClientRect(), toBox = to.dom.getBoundingClientRect();
      const x0 = fromBox.right - box.left, y0 = (a.top + a.bottom) / 2 - box.top;
      const x1 = (forward ? toBox.left : toBox.right) - box.left, y1 = (b.top + b.bottom) / 2 - box.top;
      const bend = forward ? Math.max(10, (x1 - x0) / 2) : 18;
      const path = doc.createElementNS(this.svg.namespaceURI, "path"); path.setAttribute("d", `M ${x0} ${y0} C ${x0 + bend} ${y0}, ${forward ? x1 - bend : x1 + bend} ${y1}, ${x1} ${y1}`); path.setAttribute("marker-end", `url(#${this.marker})`); this.svg.append(path);
    }
  }
  destroy(): void {
    if (this.destroyed) return; this.destroyed = true; this.observer?.disconnect();
    if (this.frame !== null) this.dom.ownerDocument.defaultView?.cancelAnimationFrame(this.frame);
    for (const card of this.cards.values()) card.controller?.abort();
  }
}
