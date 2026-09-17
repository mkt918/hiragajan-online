// ゲームロジック: Firebase/DOM に一切依存しない純粋関数群。
// すべての関数は room(Firestore の rooms/{code} ドキュメント全体)を受け取り、
// 非破壊で { room: 新しいroom } または { error: 'メッセージ' } を返す。
// 役(2+3+3 など)の妥当性は判定しない(あがりは手動判定)。枚数だけ検査する。
//
// room の形:
// {
//   hostUid, status: 'lobby'|'playing',
//   settings: { mode: 'basic'|'advanced', openHands: bool, claimSeconds: number },
//   players: { [uid]: { name, wins, joinedAt } },
//   order: [uid...],
//   round: {
//     no, turnIndex, phase: 'draw'|'discard'|'claim'|'declare'|'result',
//     deck: [id], hands: { [uid]: { layout: [id|'_'], melds: [{cards:[id,id,id]}] } },
//     discards: { [uid]: [id] }, lastDiscard: {uid, cardId, at}|null,
//     claim: { passed: [uid], deadline: ms }|null,
//     declaration: { uid, type:'tsumo'|'ron', cardId?, fromUid? }|null,
//     winner: uid|null, drawnCard: id|null, version
//   }
// }

(function (global) {
  const Cards = typeof require === 'function' && typeof module !== 'undefined'
    ? require('./cards.js')
    : global.Cards;
  const SPACE = Cards.SPACE;

  const MAX_PLAYERS = 8;
  const MIN_PLAYERS = 2;

  function dealCount(mode) { return mode === 'advanced' ? 13 : 7; }
  function winningCount(mode) { return mode === 'advanced' ? 14 : 8; }

  function clone(obj) {
    return typeof structuredClone === 'function'
      ? structuredClone(obj)
      : JSON.parse(JSON.stringify(obj));
  }
  function err(message) { return { error: message }; }
  function ok(room) { return { room }; }

  // ---- 参照系ヘルパー(UI からも使う) ----
  function cardsOf(hand) {
    return (hand && hand.layout ? hand.layout : []).filter((t) => t !== SPACE);
  }
  function meldCount(hand) {
    return hand && hand.melds ? hand.melds.length : 0;
  }
  function totalCount(hand) {
    return cardsOf(hand).length + meldCount(hand) * 3;
  }
  function currentUid(room) {
    return room.round ? room.order[room.round.turnIndex] : null;
  }
  function isPlayer(room, uid) {
    return room.order.indexOf(uid) >= 0;
  }
  function allOthersPassed(room) {
    const r = room.round;
    if (!r.claim || !r.lastDiscard) return false;
    const others = room.order.filter((u) => u !== r.lastDiscard.uid);
    return others.every((u) => r.claim.passed.indexOf(u) >= 0);
  }
  // claim 中に次手番者がツモできる条件(全員パス or 締切超過)
  function claimExpired(room, now) {
    const r = room.round;
    if (r.phase !== 'claim') return false;
    return allOthersPassed(room) || now >= r.claim.deadline;
  }
  // 「あがり」宣言ができるか(ボタン活性判定用)
  function canDeclare(room, uid) {
    const r = room.round;
    if (!r) return false;
    const hand = r.hands[uid];
    if (!hand) return false;
    const need = winningCount(room.settings.mode);
    if (r.phase === 'discard' && currentUid(room) === uid) {
      return totalCount(hand) === need;
    }
    if (r.phase === 'claim' && room.settings.mode === 'advanced' && r.lastDiscard && r.lastDiscard.uid !== uid) {
      return totalCount(hand) + 1 === need; // ロン
    }
    return false;
  }

  // ---- 局の生成 ----
  function createRound(room, opts) {
    const o = opts || {};
    const rng = o.rng || Math.random;
    const next = clone(room);
    const mode = next.settings.mode;
    let deck = Cards.shuffle(Cards.buildDeck(), rng);
    const hands = {};
    const discards = {};
    for (const uid of next.order) {
      hands[uid] = { layout: deck.slice(0, dealCount(mode)), melds: [] };
      deck = deck.slice(dealCount(mode));
      discards[uid] = [];
    }
    const prevNo = next.round ? next.round.no : 0;
    let startIndex = typeof o.startIndex === 'number' ? o.startIndex : Math.floor(rng() * next.order.length);
    startIndex = ((startIndex % next.order.length) + next.order.length) % next.order.length;
    next.round = {
      no: prevNo + 1,
      turnIndex: startIndex,
      phase: 'draw',
      deck,
      hands,
      discards,
      lastDiscard: null,
      claim: null,
      declaration: null,
      winner: null,
      drawnCard: null,
      version: 0,
    };
    next.status = 'playing';
    return ok(next);
  }

  // ホストがロビーから開始
  function startGame(room, uid, opts) {
    if (room.hostUid !== uid) return err('ホストだけが開始できます');
    if (room.status !== 'lobby') return err('すでに開始しています');
    if (room.order.length < MIN_PLAYERS) return err('2人以上必要です');
    return createRound(room, opts);
  }

  // ホストが結果画面から次の局へ(前局の勝者から開始)
  function nextRound(room, uid, opts) {
    if (room.hostUid !== uid) return err('ホストだけが次の局を始められます');
    if (!room.round || room.round.phase !== 'result') return err('まだ局が終わっていません');
    const winnerIndex = room.round.winner ? room.order.indexOf(room.round.winner) : room.round.turnIndex;
    return createRound(room, Object.assign({}, opts, { startIndex: winnerIndex }));
  }

  // ---- 手番の進行 ----
  function advanceTurn(round, n) {
    round.turnIndex = (round.turnIndex + 1) % n;
    round.claim = null;
    round.phase = 'draw';
    round.drawnCard = null;
  }

  function reshuffleDiscards(round, rng) {
    let pool = [];
    for (const uid of Object.keys(round.discards)) {
      pool = pool.concat(round.discards[uid]);
      round.discards[uid] = [];
    }
    round.deck = Cards.shuffle(pool, rng);
    round.lastDiscard = null;
  }

  // 山札から1枚引く。claim 中でも条件を満たせば手番を進めてから引く。
  function draw(room, uid, opts) {
    const o = opts || {};
    const now = o.now || Date.now();
    const next = clone(room);
    const r = next.round;
    if (!r) return err('局が始まっていません');
    if (r.phase === 'claim') {
      if (!claimExpired(next, now)) return err('ポン・ロンの受付中です');
      advanceTurn(r, next.order.length);
    }
    if (r.phase !== 'draw') return err('今は引けません');
    if (currentUid(next) !== uid) return err('あなたの番ではありません');
    if (r.deck.length === 0) reshuffleDiscards(r, o.rng);
    if (r.deck.length === 0) return err('山札がありません');
    const card = r.deck[0];
    r.deck = r.deck.slice(1);
    r.hands[uid].layout = r.hands[uid].layout.concat([card]);
    r.drawnCard = card;
    r.phase = 'discard';
    r.version++;
    return ok(next);
  }

  function removeFromLayout(layout, cardId) {
    const i = layout.indexOf(cardId);
    if (i < 0) return null;
    return layout.slice(0, i).concat(layout.slice(i + 1));
  }

  function discard(room, uid, cardId, opts) {
    const o = opts || {};
    const now = o.now || Date.now();
    const next = clone(room);
    const r = next.round;
    if (!r || r.phase !== 'discard') return err('今は捨てられません');
    if (currentUid(next) !== uid) return err('あなたの番ではありません');
    const layout = removeFromLayout(r.hands[uid].layout, cardId);
    if (!layout) return err('そのカードは手札にありません');
    r.hands[uid].layout = layout;
    r.discards[uid] = r.discards[uid].concat([cardId]);
    r.lastDiscard = { uid, cardId, at: now };
    r.drawnCard = null;
    if (next.settings.mode === 'advanced') {
      r.phase = 'claim';
      r.claim = { passed: [], deadline: now + (next.settings.claimSeconds || 0) * 1000 };
    } else {
      advanceTurn(r, next.order.length);
    }
    r.version++;
    return ok(next);
  }

  // 上級: ポン/ロンをしない意思表示。全員パスで次手番へ。
  function passClaim(room, uid) {
    const next = clone(room);
    const r = next.round;
    if (!r || r.phase !== 'claim') return err('今はパスできません');
    if (!isPlayer(next, uid)) return err('参加者ではありません');
    if (r.lastDiscard.uid === uid) return err('自分の捨て札にはパスできません');
    if (r.claim.passed.indexOf(uid) < 0) r.claim.passed = r.claim.passed.concat([uid]);
    if (allOthersPassed(next)) advanceTurn(r, next.order.length);
    r.version++;
    return ok(next);
  }

  // 上級: 締切超過で次手番へ(誰が呼んでもよい)
  function resolveClaimTimeout(room, uid, opts) {
    const now = (opts && opts.now) || Date.now();
    const next = clone(room);
    const r = next.round;
    if (!r || r.phase !== 'claim') return err('受付中ではありません');
    if (!claimExpired(next, now)) return err('まだ受付中です');
    advanceTurn(r, next.order.length);
    r.version++;
    return ok(next);
  }

  // 上級: ポン。捨て札 + 手札2枚を場に固定し、ポンした人の捨て番に。
  function pon(room, uid, cardIds) {
    const next = clone(room);
    const r = next.round;
    if (next.settings.mode !== 'advanced') return err('基本ルールではポンできません');
    if (!r || r.phase !== 'claim') return err('今はポンできません');
    if (!isPlayer(next, uid)) return err('参加者ではありません');
    if (r.lastDiscard.uid === uid) return err('自分の捨て札はポンできません');
    if (!Array.isArray(cardIds) || cardIds.length !== 2 || cardIds[0] === cardIds[1]) {
      return err('手札から2枚選んでください');
    }
    let layout = r.hands[uid].layout;
    for (const id of cardIds) {
      layout = removeFromLayout(layout, id);
      if (!layout) return err('そのカードは手札にありません');
    }
    const taken = r.lastDiscard.cardId;
    const from = r.lastDiscard.uid;
    r.discards[from] = r.discards[from].slice(0, -1);
    r.hands[uid].layout = layout;
    r.hands[uid].melds = r.hands[uid].melds.concat([{ cards: [cardIds[0], cardIds[1], taken], from }]);
    r.lastDiscard = null;
    r.claim = null;
    r.turnIndex = next.order.indexOf(uid);
    r.phase = 'discard';
    r.drawnCard = taken;
    r.version++;
    return ok(next);
  }

  // あがり宣言。type: 'tsumo'(自分の番) | 'ron'(上級・他人の捨て札)
  function declareWin(room, uid, type) {
    const next = clone(room);
    const r = next.round;
    if (!r) return err('局が始まっていません');
    const need = winningCount(next.settings.mode);
    const hand = r.hands[uid];
    if (!hand) return err('参加者ではありません');
    if (type === 'ron') {
      if (next.settings.mode !== 'advanced') return err('基本ルールではロンできません');
      if (r.phase !== 'claim') return err('今はロンできません');
      if (r.lastDiscard.uid === uid) return err('自分の捨て札ではロンできません');
      if (totalCount(hand) + 1 !== need) return err('枚数が合いません');
      const taken = r.lastDiscard.cardId;
      const from = r.lastDiscard.uid;
      r.discards[from] = r.discards[from].slice(0, -1);
      hand.layout = hand.layout.concat([taken]);
      r.declaration = { uid, type: 'ron', cardId: taken, fromUid: from };
    } else {
      if (r.phase !== 'discard') return err('今はあがり宣言できません');
      if (currentUid(next) !== uid) return err('あなたの番ではありません');
      if (totalCount(hand) !== need) return err('枚数が合いません(' + need + '枚で宣言できます)');
      r.declaration = { uid, type: 'tsumo' };
    }
    r.phase = 'declare';
    r.version++;
    return ok(next);
  }

  function confirmWin(room, uid) {
    const next = clone(room);
    const r = next.round;
    if (!r || r.phase !== 'declare') return err('宣言中ではありません');
    if (r.declaration.uid !== uid) return err('宣言者だけが確定できます');
    r.winner = uid;
    r.phase = 'result';
    r.claim = null;
    r.lastDiscard = null;
    next.players[uid].wins = (next.players[uid].wins || 0) + 1;
    r.version++;
    return ok(next);
  }

  function cancelWin(room, uid, opts) {
    const now = (opts && opts.now) || Date.now();
    const next = clone(room);
    const r = next.round;
    if (!r || r.phase !== 'declare') return err('宣言中ではありません');
    if (r.declaration.uid !== uid) return err('宣言者だけが取り消せます');
    const d = r.declaration;
    if (d.type === 'ron') {
      r.hands[uid].layout = removeFromLayout(r.hands[uid].layout, d.cardId);
      r.discards[d.fromUid] = r.discards[d.fromUid].concat([d.cardId]);
      r.phase = 'claim';
      // 取り消し後も他の人がポンできるよう締切を延長する
      r.claim = { passed: [], deadline: now + (next.settings.claimSeconds || 0) * 1000 };
    } else {
      r.phase = 'discard';
    }
    r.declaration = null;
    r.version++;
    return ok(next);
  }

  // ---- 手札の並び(スペース含む)の更新 ----
  // 同じカード集合であれば任意の順序・任意個のスペースを許可する。version は増やさない。
  function setLayout(room, uid, layout) {
    const hand = room.round && room.round.hands[uid];
    if (!hand) return err('参加者ではありません');
    if (!sameCards(cardsOf(hand), layout.filter((t) => t !== SPACE))) {
      return err('手札の内容が一致しません');
    }
    const next = clone(room);
    next.round.hands[uid].layout = layout.slice();
    return ok(next);
  }

  function sameCards(a, b) {
    if (a.length !== b.length) return false;
    const sa = a.slice().sort();
    const sb = b.slice().sort();
    return sa.every((v, i) => v === sb[i]);
  }

  // ローカルの並び(layout)とサーバー上のカード集合(cards)の不整合を自己修復する。
  // 余分なカードは除去し、欠けたカードは末尾に追加。スペースはそのまま残す。
  function reconcileLayout(layout, cards) {
    const remaining = cards.slice();
    const out = [];
    for (const t of layout) {
      if (t === SPACE) { out.push(t); continue; }
      const i = remaining.indexOf(t);
      if (i >= 0) { out.push(t); remaining.splice(i, 1); }
    }
    return out.concat(remaining);
  }

  // ---- 部屋(ロビー)操作 ----
  function createRoom(opts) {
    const o = opts || {};
    return {
      hostUid: o.uid,
      status: 'lobby',
      settings: {
        mode: o.mode === 'advanced' ? 'advanced' : 'basic',
        openHands: o.openHands !== false,
        claimSeconds: typeof o.claimSeconds === 'number' ? o.claimSeconds : 5,
      },
      players: { [o.uid]: { name: o.name || 'プレイヤー', wins: 0, joinedAt: o.now || Date.now() } },
      order: [o.uid],
      round: null,
    };
  }

  function joinRoom(room, uid, name, now) {
    if (isPlayer(room, uid)) return ok(clone(room)); // 再入室
    if (room.status !== 'lobby') return err('このゲームはすでに始まっています');
    if (room.order.length >= MAX_PLAYERS) return err('部屋は満員です(最大8人)');
    const next = clone(room);
    next.players[uid] = { name: name || 'プレイヤー', wins: 0, joinedAt: now || Date.now() };
    next.order = next.order.concat([uid]);
    return ok(next);
  }

  function leaveRoom(room, uid) {
    if (!isPlayer(room, uid)) return err('参加者ではありません');
    if (room.status !== 'lobby') return err('ゲーム中は退室できません');
    const next = clone(room);
    delete next.players[uid];
    next.order = next.order.filter((u) => u !== uid);
    if (next.hostUid === uid) next.hostUid = next.order[0] || null;
    return ok(next);
  }

  function updateSettings(room, uid, settings) {
    if (room.hostUid !== uid) return err('ホストだけが設定を変えられます');
    if (room.status !== 'lobby') return err('ゲーム中は設定を変えられません');
    const next = clone(room);
    Object.assign(next.settings, settings);
    return ok(next);
  }

  const GameLogic = {
    MAX_PLAYERS,
    MIN_PLAYERS,
    SPACE,
    dealCount,
    winningCount,
    cardsOf,
    meldCount,
    totalCount,
    currentUid,
    isPlayer,
    allOthersPassed,
    claimExpired,
    canDeclare,
    createRoom,
    joinRoom,
    leaveRoom,
    updateSettings,
    startGame,
    nextRound,
    createRound,
    draw,
    discard,
    passClaim,
    resolveClaimTimeout,
    pon,
    declareWin,
    confirmWin,
    cancelWin,
    setLayout,
    reconcileLayout,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = GameLogic;
  } else {
    global.GameLogic = GameLogic;
  }
})(typeof window !== 'undefined' ? window : globalThis);
