/**
 * 🔴 **関係グラフの面**(#281 ①。user 指示 2026-08-19
 * 「office、ファイラ兼エクスプローラ、シェル、PDF エディタ、**関連性グラフビューワ**、…は組み込みアプリでリリースしたい」)。
 *
 * ## どこに在るか ── 左の列のタブと、別ウィンドウの面の 2 か所
 *
 * 連絡先 / 録ったものと同じ形(`contacts.ts` の docstring)。⚠ この描画器は同じ document に 2 つ生きうる
 * (左のタブ + 中央の面)ので、`data-pkc-region` を焼かない。見方(全体 / 手先の数)は **state**
 * (`graphView`)が持つ ── 描画器に覚えさせると、片方で変えた結果がもう片方に届かない。
 *
 * ## 情報ペインの「つながりの図」との違い
 *
 * あちらは選んだノートの 2 手先まで(固定・右の列)。こちらは **全体**、または **選んだノートから 1〜6 手先**。
 * 作りは同じ ── 節点は `<button>`(押すとそのノートを開く = 既存の `select-entry`)、辺は 1 枚の `<svg>`。
 * ⚠ 節点を押せることが要件なので、図を PNG の `<img>` に焼かない(焼くと「形は見えるが辿れない図」になる。
 *   `relation-map.ts` と同じ判断)。件数は `GRAPH_MAX_NODES` で打ち切り、**切ったらそう言う**。
 * ⚠ 配置は `features/relation/graph-view.ts`(pure)が決める ── ここは受け取った比を器に当てるだけ。
 *
 * ## 辺の出どころ
 *
 * - 関係(居場所の親子は除く)── 全ノートぶん
 * - 本文のリンク ── **選んでいるノートの分だけ**(出ていく = 開いている本文 / 入ってくる = 被リンク)。
 *   全ノートの本文を舐めるには worker の走査が要り、図を開くたびに走らせない(情報ペインの図と同じ判断)。
 *   ⚠ だから「全体」には本文のリンクが出ない ── 面の注記でそう言う。
 */
import type { AppState } from '@adapter/state/app-state';
import { buildGraphView, GRAPH_MAX_DEPTH } from '@features/relation/graph-view';
import { STRUCTURAL, relationLabel } from '@features/relation/kinds';
import { bodyLinkTargets } from '@features/entry-ref/body-links';
import { BODY_LINK_KIND } from './relation-map';
import { buildPressedButton } from './choice-buttons';

/** 図の器の比(高さ / 幅)。 */
const ASPECT = 0.82;

function edgeLabel(kind: string): string {
  return kind === BODY_LINK_KIND ? '本文のリンク' : relationLabel(kind);
}

export class GraphRenderer {
  private readonly host: HTMLElement;
  private bar: HTMLElement | null = null;
  private note: HTMLElement | null = null;
  private box: HTMLElement | null = null;
  private last: unknown[] = [];

  constructor(host: HTMLElement) {
    this.host = host;
  }

  private ensureFrame(): void {
    if (this.box !== null) return;
    const bar = document.createElement('div');
    bar.setAttribute('data-pkc-field', 'graph-bar');
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'graph-note');
    const box = document.createElement('div');
    box.setAttribute('data-pkc-field', 'graph-body');
    this.host.append(bar, note, box);
    this.bar = bar;
    this.note = note;
    this.box = box;
  }

  render(state: AppState): void {
    this.ensureFrame();
    const { all, depth } = state.graphView;
    const center = all ? null : state.selectedLid;
    // 本文のリンクは選んでいるノートの分だけ(上の docstring)
    const openBody =
      center !== null && state.openBody?.lid === center ? state.openBody.body : null;
    const back = center !== null && state.backlinks?.lid === center ? state.backlinks : null;
    // ⚠ 指紋は参照で見る(全ノートぶんの写しを作らない)。同じなら触らない
    const key: unknown[] = [
      all,
      depth,
      center,
      state.relations,
      state.entryMetas,
      state.cid,
      openBody,
      back,
    ];
    if (key.length === this.last.length && key.every((v, i) => v === this.last[i])) return;
    this.last = key;

    this.paintBar(all, depth);

    const edges: { fromLid: string; toLid: string; kind: string }[] = state.relations
      .filter((r) => r.kind !== STRUCTURAL)
      .map((r) => ({ fromLid: r.fromLid, toLid: r.toLid, kind: r.kind }));
    if (center !== null) {
      if (openBody !== null) {
        for (const to of bodyLinkTargets(openBody, state.cid)) {
          edges.push({ fromLid: center, toLid: to, kind: BODY_LINK_KIND });
        }
      }
      if (back !== null) {
        for (const from of back.lids) {
          edges.push({ fromLid: from, toLid: center, kind: BODY_LINK_KIND });
        }
      }
    }
    const metas = state.entryMetas;
    const view = buildGraphView({
      center,
      depth,
      edges,
      titles: { has: (lid) => metas.has(lid), get: (lid) => metas.get(lid)?.title },
    });

    const box = this.box!;
    const note = this.note!;
    box.textContent = '';
    if (!all && center === null) {
      note.textContent = 'ノートを選ぶと、そのノートからつながりを描きます(「全体」でノート全部のつながりも見られます)';
      return;
    }
    if (!all && !metas.has(center!)) {
      note.textContent = '選んだノートが見つかりません';
      return;
    }
    if (view.nodes.length <= 1) {
      note.textContent = all
        ? 'つながり(関係)を持つノートがまだありません'
        : 'このノートにはつながり(関係・本文のリンク)がありません';
      return;
    }
    const cut = view.truncated
      ? `つながりが多いので ${view.nodes.length} 件までにしています(全部で ${view.total} 件${all ? '。つながりの多い順' : '。近い順'})`
      : '';
    note.textContent = [
      all
        ? `全体 ${view.nodes.length} 件 / 本文のリンクは、ノートを選んだ見方でだけ出ます`
        : `${view.nodes.length} 件`,
      cut,
    ]
      .filter((t) => t !== '')
      .join('。');

    const fig = document.createElement('div');
    fig.setAttribute('data-pkc-field', 'graph-map');
    fig.style.position = 'relative';
    fig.style.width = '100%';
    fig.style.aspectRatio = `1 / ${ASPECT}`;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 100 ${100 * ASPECT}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('data-pkc-field', 'graph-edges');
    svg.style.position = 'absolute';
    svg.style.inset = '0';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.pointerEvents = 'none';
    const at = new Map(view.nodes.map((p) => [p.lid, p]));
    for (const e of view.edges) {
      const a = at.get(e.fromLid);
      const b = at.get(e.toLid);
      if (!a || !b) continue;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(a.x * 100));
      line.setAttribute('y1', String(a.y * 100 * ASPECT));
      line.setAttribute('x2', String(b.x * 100));
      line.setAttribute('y2', String(b.y * 100 * ASPECT));
      line.setAttribute('stroke', 'currentColor');
      line.setAttribute('stroke-width', '0.4');
      line.setAttribute('opacity', '0.45');
      // 本文のリンクは色ではなく破線で分ける(地は無彩色)
      if (e.kind === BODY_LINK_KIND) line.setAttribute('stroke-dasharray', '2 1.5');
      line.setAttribute('data-pkc-field', 'graph-edge');
      line.setAttribute('data-pkc-relation-kind', e.kind);
      svg.append(line);
    }
    fig.append(svg);
    for (const p of view.nodes) {
      const btn = document.createElement('button');
      btn.type = 'button';
      // ⚠ 既存の `select-entry` に乗る(開く口を増やさない)
      btn.setAttribute('data-pkc-action', 'select-entry');
      btn.setAttribute('data-pkc-entry', p.lid);
      btn.setAttribute('data-pkc-field', p.lid === state.selectedLid ? 'graph-node-current' : 'graph-node');
      btn.setAttribute('data-pkc-ring', String(p.ring));
      if (p.lid === state.selectedLid) btn.setAttribute('aria-current', 'true');
      btn.textContent = p.title === '' ? '(無題)' : p.title;
      btn.title = p.title;
      btn.style.position = 'absolute';
      btn.style.left = `${p.x * 100}%`;
      btn.style.top = `${p.y * 100}%`;
      btn.style.transform = 'translate(-50%, -50%)';
      btn.style.maxWidth = all ? '24%' : '42%';
      btn.style.overflow = 'hidden';
      btn.style.textOverflow = 'ellipsis';
      btn.style.whiteSpace = 'nowrap';
      fig.append(btn);
    }
    box.append(fig);
    const kinds = new Map<string, number>();
    for (const e of view.edges) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
    if (kinds.size > 0) {
      const legend = document.createElement('p');
      legend.setAttribute('data-pkc-field', 'graph-legend');
      legend.textContent = [...kinds].map(([k, n]) => `${edgeLabel(k)} ${n}`).join(' / ');
      box.append(legend);
    }
  }

  /** 見方のボタン(全体 / 選んだノートから + 手先の数)。state が正で、毎回合わせ直す。 */
  private paintBar(all: boolean, depth: number): void {
    const bar = this.bar!;
    bar.textContent = '';
    bar.append(
      buildPressedButton({
        action: 'graph-scope',
        dataAttr: 'data-pkc-graph-scope',
        value: 'selected',
        label: '選んだノートから',
        pressed: !all,
        title: '選んでいるノートを中心に、つながりを手先の数だけたどって描きます',
      }),
      buildPressedButton({
        action: 'graph-scope',
        dataAttr: 'data-pkc-graph-scope',
        value: 'all',
        label: '全体',
        pressed: all,
        title: 'つながり(関係)を持つノートを、つながりの多い順に上限まで描きます',
      }),
    );
    if (all) return;
    for (let n = 1; n <= GRAPH_MAX_DEPTH; n += 1) {
      bar.append(
        buildPressedButton({
          action: 'graph-depth',
          dataAttr: 'data-pkc-graph-depth',
          value: String(n),
          label: `${n} 手`,
          pressed: n === depth,
          title: `選んだノートから ${n} 手先までたどります`,
        }),
      );
    }
  }
}
