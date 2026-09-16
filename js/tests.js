/*
 * cards.js / game-logic.js の自己検証。
 * ブラウザでは tests.html から、コマンドラインでは `node js/tests.js` で走る。
 */
(function (global) {
  'use strict';

  if (typeof require === 'function' && !global.GameLogic) {
    global.Cards = require('./cards.js');
    global.GameLogic = require('./game-logic.js');
  }
  const C = global.Cards;
  const L = global.GameLogic;

  // ---- 最小テストハーネス ------------------------------------------------
  const results = [];
  function test(name, fn) {
    try {
      fn();
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, detail: e && e.message ? e.message : String(e) });
    }
  }
  function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
  }
  function assertEqual(actual, expected, msg) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error((msg ? msg + ': ' : '') + 'expected ' + b + ' but got ' + a);
  }
  function must(res, msg) {
    if (res.error) throw new Error((msg ? msg + ': ' : '') + 'unexpected error: ' + res.error);
    return res.room;
  }
  function mustFail(res, msg) {
    if (!res.error) throw new Error((msg ? msg + ': ' : '') + 'expected an error');
  }

  /** 決定的な擬似乱数(mulberry32) */
  function seeded(seed) {
    let t = seed >>> 0;
    return function () {
      t += 0x6D2B79F5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 全カードの保存則: 山札 + 河 + 全手札 + 固定meld (+ 宣言中は含まれる) = 120
  function assertConservation(room) {
    const r = room.round;
    let n = r.deck.length;
    const seen = {};
    const push = (id) => {
      if (seen[id]) throw new Error('duplicate card ' + id);
      seen[id] = true;
      n++;
    };
    r.deck.forEach((id) => { seen[id] = true; });
    n = r.deck.length;
    for (const uid of room.order) {
      L.cardsOf(r.hands[uid]).forEach(push);
      r.hands[uid].melds.forEach((m) => m.cards.forEach(push));
      r.discards[uid].forEach(push);
    }
    assertEqual(n, C.TOTAL_CARDS, 'card conservation');
  }

  function makeRoom(mode, n, seed) {
    let room = L.createRoom({ uid: 'p0', name: 'A', mode, now: 1000 });
    for (let i = 1; i < n; i++) room = must(L.joinRoom(room, 'p' + i, 'P' + i, 1000 + i));
    room = must(L.startGame(room, 'p0', { rng: seeded(seed || 1), startIndex: 0 }));
    return room;
  }
  function firstCard(room, uid) {
    return L.cardsOf(room.round.hands[uid])[0];
  }

  // ---- cards.js -----------------------------------------------------------
  test('デッキは120枚で id が重複しない', () => {
    const deck = C.buildDeck();
    assertEqual(deck.length, 120);
    assertEqual(new Set(deck).size, 120);
  });
  test('清音は各2枚・濁音/半濁音25種・拗音長音5種、「を」は無い', () => {
    const defs = C.CARD_DEFS;
    assertEqual(defs.filter((d) => d.kind === 'seion').length, 90);
    assertEqual(defs.filter((d) => d.kind === 'dakuon').length, 25);
    assertEqual(defs.filter((d) => d.kind === 'youon').length, 5);
    assert(!defs.some((d) => d.char === 'を'), 'を is excluded');
    assertEqual(defs.filter((d) => d.char === 'あ').length, 2);
  });
  test('shuffle は非破壊で同じ要素を持つ', () => {
    const deck = C.buildDeck();
    const s = C.shuffle(deck, seeded(3));
    assert(s !== deck);
    assertEqual(s.slice().sort(), deck.slice().sort());
    assert(s.join() !== deck.join(), 'order changed');
  });
  test('layoutToWords はスペースで区切る(連続・先頭末尾のスペースを無視)', () => {
    assertEqual(C.layoutToWords(['_', 'く1', 'つ1', '_', '_', 'た1', 'ぬ1', 'き2', '_']), ['くつ', 'たぬき']);
  });

  // ---- ロビー -------------------------------------------------------------
  test('部屋作成→参加→4人で満員、5人目は拒否', () => {
    let room = L.createRoom({ uid: 'h', name: 'host', mode: 'basic' });
    assertEqual(room.order, ['h']);
    room = must(L.joinRoom(room, 'a', 'A'));
    room = must(L.joinRoom(room, 'b', 'B'));
    room = must(L.joinRoom(room, 'c', 'C'));
    mustFail(L.joinRoom(room, 'd', 'D'));
    // 再入室は成功する
    assertEqual(must(L.joinRoom(room, 'a', 'A')).order.length, 4);
  });
  test('1人では開始できない・ホスト以外は開始できない', () => {
    const room = L.createRoom({ uid: 'h', mode: 'basic' });
    mustFail(L.startGame(room, 'h'));
    const room2 = must(L.joinRoom(room, 'a', 'A'));
    mustFail(L.startGame(room2, 'a'));
    must(L.startGame(room2, 'h', { rng: seeded(1) }));
  });
  test('退室でホストが抜けたら次の人がホストになる', () => {
    let room = L.createRoom({ uid: 'h', mode: 'basic' });
    room = must(L.joinRoom(room, 'a', 'A'));
    room = must(L.leaveRoom(room, 'h'));
    assertEqual(room.hostUid, 'a');
    assertEqual(room.order, ['a']);
  });

  // ---- 基本ルール ---------------------------------------------------------
  test('基本: 7枚ずつ配られ、phase=draw、山札は 120-7n', () => {
    const room = makeRoom('basic', 3, 1);
    for (const uid of room.order) assertEqual(L.cardsOf(room.round.hands[uid]).length, 7);
    assertEqual(room.round.deck.length, 120 - 21);
    assertEqual(room.round.phase, 'draw');
    assertConservation(room);
  });
  test('基本: ツモ→捨てで手番が回る、手番外は拒否', () => {
    let room = makeRoom('basic', 2, 2);
    mustFail(L.draw(room, 'p1'), '手番外');
    mustFail(L.discard(room, 'p0', firstCard(room, 'p0')), 'draw 前');
    room = must(L.draw(room, 'p0'));
    assertEqual(L.cardsOf(room.round.hands.p0).length, 8);
    assertEqual(room.round.phase, 'discard');
    assertEqual(room.round.drawnCard, room.round.hands.p0.layout[7]);
    mustFail(L.draw(room, 'p0'), '二重ツモ');
    const card = firstCard(room, 'p0');
    room = must(L.discard(room, 'p0', card));
    assertEqual(room.round.discards.p0, [card]);
    assertEqual(room.round.lastDiscard.cardId, card);
    assertEqual(room.round.phase, 'draw');
    assertEqual(L.currentUid(room), 'p1');
    assertConservation(room);
  });
  test('基本: 8枚でのみあがり宣言→成立で勝ち数+1・result', () => {
    let room = makeRoom('basic', 2, 3);
    mustFail(L.declareWin(room, 'p0', 'tsumo'), '7枚では不可');
    assert(!L.canDeclare(room, 'p0'));
    room = must(L.draw(room, 'p0'));
    assert(L.canDeclare(room, 'p0'));
    room = must(L.declareWin(room, 'p0', 'tsumo'));
    assertEqual(room.round.phase, 'declare');
    mustFail(L.confirmWin(room, 'p1'), '他人は確定不可');
    room = must(L.confirmWin(room, 'p0'));
    assertEqual(room.round.phase, 'result');
    assertEqual(room.round.winner, 'p0');
    assertEqual(room.players.p0.wins, 1);
    assertConservation(room);
  });
  test('基本: 宣言の取り消しで discard に戻り、続けて捨てられる', () => {
    let room = makeRoom('basic', 2, 4);
    room = must(L.draw(room, 'p0'));
    room = must(L.declareWin(room, 'p0', 'tsumo'));
    room = must(L.cancelWin(room, 'p0'));
    assertEqual(room.round.phase, 'discard');
    assertEqual(room.round.declaration, null);
    room = must(L.discard(room, 'p0', firstCard(room, 'p0')));
    assertEqual(L.currentUid(room), 'p1');
  });
  test('基本: ロン・ポン・パスは拒否される', () => {
    let room = makeRoom('basic', 2, 5);
    room = must(L.draw(room, 'p0'));
    room = must(L.discard(room, 'p0', firstCard(room, 'p0')));
    mustFail(L.declareWin(room, 'p1', 'ron'));
    mustFail(L.pon(room, 'p1', L.cardsOf(room.round.hands.p1).slice(0, 2)));
    mustFail(L.passClaim(room, 'p1'));
  });
  test('次の局は勝者から開始し、no が増え、勝ち数は引き継ぐ', () => {
    let room = makeRoom('basic', 3, 6);
    room = must(L.draw(room, 'p0'));
    room = must(L.discard(room, 'p0', firstCard(room, 'p0')));
    room = must(L.draw(room, 'p1'));
    room = must(L.declareWin(room, 'p1', 'tsumo'));
    room = must(L.confirmWin(room, 'p1'));
    mustFail(L.nextRound(room, 'p1'), 'ホスト以外');
    room = must(L.nextRound(room, 'p0', { rng: seeded(7) }));
    assertEqual(room.round.no, 2);
    assertEqual(L.currentUid(room), 'p1');
    assertEqual(room.players.p1.wins, 1);
    assertEqual(room.round.phase, 'draw');
    assertConservation(room);
  });
  test('山札が尽きたら河をシャッフルして続行', () => {
    let room = makeRoom('basic', 2, 8);
    // 山札を空にし、河にカードを入れた状態を作る
    const r = room.round;
    r.discards.p0 = r.deck.slice(0, 50);
    r.discards.p1 = r.deck.slice(50);
    r.deck = [];
    assertConservation(room);
    room = must(L.draw(room, 'p0', { rng: seeded(9) }));
    assertEqual(L.cardsOf(room.round.hands.p0).length, 8);
    assertEqual(room.round.deck.length, 120 - 14 - 1);
    assertEqual(room.round.discards.p0.length + room.round.discards.p1.length, 0);
    assertEqual(room.round.lastDiscard, null);
    assertConservation(room);
  });

  // ---- 上級ルール ---------------------------------------------------------
  test('上級: 13枚配布、捨てると claim 受付になる', () => {
    let room = makeRoom('advanced', 3, 10);
    for (const uid of room.order) assertEqual(L.cardsOf(room.round.hands[uid]).length, 13);
    room = must(L.draw(room, 'p0', { now: 1000 }));
    room = must(L.discard(room, 'p0', firstCard(room, 'p0'), { now: 1000 }));
    assertEqual(room.round.phase, 'claim');
    assertEqual(room.round.claim.deadline, 1000 + 5000);
    assertEqual(L.currentUid(room), 'p0', '受付中は手番は動かない');
    mustFail(L.draw(room, 'p1', { now: 2000 }), '受付中はツモ不可');
    assertConservation(room);
  });
  test('上級: 全員パスで次手番へ、自分の捨て札にはパスできない', () => {
    let room = makeRoom('advanced', 3, 11);
    room = must(L.draw(room, 'p0', { now: 1000 }));
    room = must(L.discard(room, 'p0', firstCard(room, 'p0'), { now: 1000 }));
    mustFail(L.passClaim(room, 'p0'));
    room = must(L.passClaim(room, 'p2'));
    assertEqual(room.round.phase, 'claim');
    room = must(L.passClaim(room, 'p1'));
    assertEqual(room.round.phase, 'draw');
    assertEqual(L.currentUid(room), 'p1');
  });
  test('上級: 締切超過なら次手番者がそのままツモできる', () => {
    let room = makeRoom('advanced', 2, 12);
    room = must(L.draw(room, 'p0', { now: 1000 }));
    room = must(L.discard(room, 'p0', firstCard(room, 'p0'), { now: 1000 }));
    mustFail(L.draw(room, 'p1', { now: 5999 }));
    room = must(L.draw(room, 'p1', { now: 6000 }));
    assertEqual(room.round.phase, 'discard');
    assertEqual(L.cardsOf(room.round.hands.p1).length, 14);
  });
  test('上級: ポンで meld 固定、ポンした人の捨て番→その次の人へ', () => {
    let room = makeRoom('advanced', 4, 13);
    room = must(L.draw(room, 'p0', { now: 1000 }));
    const thrown = firstCard(room, 'p0');
    room = must(L.discard(room, 'p0', thrown, { now: 1000 }));
    const two = L.cardsOf(room.round.hands.p2).slice(0, 2);
    mustFail(L.pon(room, 'p0', two), '自分の捨て札');
    mustFail(L.pon(room, 'p2', [two[0]]), '1枚では不可');
    room = must(L.pon(room, 'p2', two));
    assertEqual(room.round.hands.p2.melds.length, 1);
    assertEqual(room.round.hands.p2.melds[0].cards, [two[0], two[1], thrown]);
    assertEqual(L.cardsOf(room.round.hands.p2).length, 11);
    assertEqual(L.totalCount(room.round.hands.p2), 14);
    assertEqual(room.round.discards.p0, [], '河から消える');
    assertEqual(room.round.phase, 'discard');
    assertEqual(L.currentUid(room), 'p2');
    assert(L.canDeclare(room, 'p2'), 'ポン直後(14枚)は宣言可');
    room = must(L.discard(room, 'p2', firstCard(room, 'p2'), { now: 2000 }));
    room = must(L.passClaim(room, 'p0'));
    room = must(L.passClaim(room, 'p1'));
    room = must(L.passClaim(room, 'p3'));
    assertEqual(L.currentUid(room), 'p3', 'p2 の次は p3');
    assertConservation(room);
  });
  test('上級: ロン宣言→取り消しで河に戻り claim 継続、成立で勝ち', () => {
    let room = makeRoom('advanced', 2, 14);
    room = must(L.draw(room, 'p0', { now: 1000 }));
    const thrown = firstCard(room, 'p0');
    room = must(L.discard(room, 'p0', thrown, { now: 1000 }));
    assert(L.canDeclare(room, 'p1'), '13枚+捨て札=14');
    room = must(L.declareWin(room, 'p1', 'ron'));
    assertEqual(room.round.phase, 'declare');
    assertEqual(L.cardsOf(room.round.hands.p1).length, 14);
    assertEqual(room.round.discards.p0, []);
    assertConservation(room);
    let back = must(L.cancelWin(room, 'p1', { now: 3000 }));
    assertEqual(back.round.phase, 'claim');
    assertEqual(back.round.discards.p0, [thrown]);
    assertEqual(L.cardsOf(back.round.hands.p1).length, 13);
    assertEqual(back.round.claim.deadline, 8000);
    assertConservation(back);
    room = must(L.confirmWin(room, 'p1'));
    assertEqual(room.round.winner, 'p1');
    assertEqual(room.round.phase, 'result');
  });

  // ---- レイアウト ---------------------------------------------------------
  test('setLayout はスペース任意・同一カード集合のみ許可', () => {
    let room = makeRoom('basic', 2, 15);
    const cards = L.cardsOf(room.round.hands.p0);
    const layout = ['_', cards[2], '_', '_', cards[0], cards[1], cards[3], cards[4], cards[5], cards[6], '_'];
    room = must(L.setLayout(room, 'p0', layout));
    assertEqual(room.round.hands.p0.layout, layout);
    mustFail(L.setLayout(room, 'p0', cards.slice(1)), '欠け');
    mustFail(L.setLayout(room, 'p0', cards.concat(['ん1'])), '余分');
  });
  test('ツモは layout 末尾に追加され、スペースは保持される', () => {
    let room = makeRoom('basic', 2, 16);
    const cards = L.cardsOf(room.round.hands.p0);
    room = must(L.setLayout(room, 'p0', [cards[0], '_'].concat(cards.slice(1))));
    room = must(L.draw(room, 'p0'));
    const lay = room.round.hands.p0.layout;
    assertEqual(lay[1], '_');
    assertEqual(lay[lay.length - 1], room.round.drawnCard);
  });
  test('reconcileLayout は余分を除き欠けを末尾に足し、スペースを残す', () => {
    const out = L.reconcileLayout(['a', '_', 'x', 'b', '_'], ['b', 'a', 'c']);
    assertEqual(out, ['a', '_', 'b', '_', 'c']);
  });

  // ---- ランダム対局スモーク(保存則) --------------------------------------
  test('スモーク: ランダムに200手進めても保存則が保たれる(上級)', () => {
    const rng = seeded(99);
    let room = makeRoom('advanced', 4, 99);
    let now = 1000;
    for (let i = 0; i < 200; i++) {
      const r = room.round;
      const cur = L.currentUid(room);
      if (r.phase === 'draw') {
        room = must(L.draw(room, cur, { now, rng }));
      } else if (r.phase === 'discard') {
        const cards = L.cardsOf(r.hands[cur]);
        room = must(L.discard(room, cur, cards[Math.floor(rng() * cards.length)], { now }));
      } else if (r.phase === 'claim') {
        const others = room.order.filter((u) => u !== r.lastDiscard.uid);
        const who = others[Math.floor(rng() * others.length)];
        const cards = L.cardsOf(r.hands[who]);
        if (rng() < 0.3 && cards.length >= 2) {
          room = must(L.pon(room, who, [cards[0], cards[1]]));
        } else {
          now += 6000;
          room = must(L.resolveClaimTimeout(room, who, { now }));
        }
      }
      assertConservation(room);
    }
  });

  // ---- 出力 ---------------------------------------------------------------
  global.HiragajanTestResults = results;
  if (typeof process !== 'undefined' && process.stdout) {
    let pass = 0;
    for (const r of results) {
      if (r.ok) pass++;
      console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? '' : '\n      ' + r.detail));
    }
    console.log('\n' + pass + ' / ' + results.length + ' passed');
    if (pass !== results.length) process.exitCode = 1;
  }
})(typeof window !== 'undefined' ? window : globalThis);
