/**
 * 新規作成の**実際の導線**を叩く(P8)。
 *
 * 種類はボタンではなく `<select>` で選ぶ形になったので、test も同じ手順を踏む
 * ── 「select に入れて、新規を押す」。⚠ ここを直接 dispatch に替えてしまうと、
 * **導線が壊れていても test が緑**になる。
 *
 * ⚠ 封印中の種類(`features/sealed.ts`)は select に**出てこない**。
 * それを作る test は「導線ではなく dispatch で作る」と明示すること
 * (= 封印は導線を畳んだだけで、データは今も作れる、という事実を test が示す)。
 */
export function createByUi(root: ParentNode, archetype: string): void {
  const kind = root.querySelector<HTMLSelectElement>('[data-pkc-field="create-kind"]');
  if (!kind) throw new Error('create-kind select がシェルに無い');
  const has = [...kind.options].some((o) => o.value === archetype);
  if (!has) throw new Error(`種類 ${archetype} は選べない(封印中では?)`);
  kind.value = archetype;
  const btn = root.querySelector<HTMLElement>(
    '[data-pkc-region="create-bar"] [data-pkc-action="create-entry"]',
  );
  if (!btn) throw new Error('新規ボタンがシェルに無い');
  btn.click();
}
