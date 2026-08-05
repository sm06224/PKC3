/**
 * 新規作成の**実際の導線**を叩く(P8 → P10 で分割ボタンへ)。
 *
 * 🔴 **user と同じ手順を踏む**(P10)── `▼` を押して種類を選び、本体を押す。
 * ⚠ `<select>` に値を入れて押すのは**もう正しくない** ── 本体のボタンが
 * `data-pkc-archetype` を持ち、binder はそちらを**先に**見るので、
 * select だけ変えると「選んだ種類と出来るものが別」になる(実際に踏んだ)。
 * ⚠ ここを直接 dispatch に替えてしまうと、**導線が壊れていても test が緑**になる。
 *
 * ⚠ 封印中の種類(`features/sealed.ts`)は一覧に**出てこない**。
 * それを作る test は「導線ではなく dispatch で作る」と明示すること
 * (= 封印は導線を畳んだだけで、データは今も作れる、という事実を test が示す)。
 */
export function createByUi(root: ParentNode, archetype: string): void {
  const pick = root.querySelector<HTMLElement>('[data-pkc-field="create-pick"]');
  if (!pick) throw new Error('種類を選ぶ ▼ がシェルに無い');
  pick.click();
  const item = root.querySelector<HTMLElement>(
    `[data-pkc-region="create-menu"] [data-pkc-archetype="${archetype}"]`,
  );
  if (!item) throw new Error(`種類 ${archetype} は選べない(封印中では?)`);
  item.click();
  const btn = root.querySelector<HTMLElement>('[data-pkc-field="create-run"]');
  if (!btn) throw new Error('新規ボタンがシェルに無い');
  btn.click();
}
