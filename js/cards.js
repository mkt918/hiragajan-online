// カード定義: 120枚のひらがなカード。Firebase/DOM に依存しない純粋モジュール。
// id は「文字 + 通し番号」(例: 'あ1', 'あ2', 'が1')で決定的に採番する。
// layout 配列の中でスペースを表すトークンは SPACE ('_')。

(function (global) {
  const SPACE = '_';

  // 清音 45 種 × 2 枚(「を」は含まない)
  const SEION = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわん';
  // 濁音・半濁音 25 種 × 1 枚
  const DAKUON = 'がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ';
  // 拗音・長音 5 種 × 1 枚
  const YOUON = 'っゃゅょー';

  const CARD_DEFS = [];
  for (const ch of SEION) {
    CARD_DEFS.push({ id: ch + '1', char: ch, kind: 'seion' });
    CARD_DEFS.push({ id: ch + '2', char: ch, kind: 'seion' });
  }
  for (const ch of DAKUON) CARD_DEFS.push({ id: ch + '1', char: ch, kind: 'dakuon' });
  for (const ch of YOUON) CARD_DEFS.push({ id: ch + '1', char: ch, kind: 'youon' });

  const CARD_BY_ID = Object.create(null);
  for (const c of CARD_DEFS) CARD_BY_ID[c.id] = c;

  const TOTAL_CARDS = CARD_DEFS.length; // 120

  function charOf(id) {
    if (id === SPACE) return '';
    const def = CARD_BY_ID[id];
    return def ? def.char : '?';
  }

  function isCardId(token) {
    return token !== SPACE && !!CARD_BY_ID[token];
  }

  // 未シャッフルの山札(id 配列)
  function buildDeck() {
    return CARD_DEFS.map((c) => c.id);
  }

  // Fisher-Yates。非破壊。rng は [0,1) を返す関数(テストでは固定値を注入)
  function shuffle(items, rng) {
    const r = rng || Math.random;
    const arr = items.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // layout(カードid と SPACE の列)を、スペース位置で言葉ごとの文字列に分割する。
  // 例: ['く1','つ1','_','た1','ぬ1','き2'] → ['くつ', 'たぬき']
  function layoutToWords(layout) {
    const words = [];
    let cur = '';
    for (const t of layout) {
      if (t === SPACE) {
        if (cur) words.push(cur);
        cur = '';
      } else {
        cur += charOf(t);
      }
    }
    if (cur) words.push(cur);
    return words;
  }

  const Cards = {
    SPACE,
    CARD_DEFS,
    TOTAL_CARDS,
    charOf,
    isCardId,
    buildDeck,
    shuffle,
    layoutToWords,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Cards;
  } else {
    global.Cards = Cards;
  }
})(typeof window !== 'undefined' ? window : globalThis);
