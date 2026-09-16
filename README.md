# ひらがじゃん オンライン

ひらがなカード120枚で、麻雀のように「言葉」を揃えるカードゲーム「ひらがじゃん」の Web アプリ版。
2〜4人がスマホ/PC から部屋コードで集まり、リアルタイムで対戦する。Firebase(Firestore + 匿名認証)+ GitHub Pages。

## 現在の状況(2026-09-16)

| 項目 | 状態 |
|---|---|
| ゲームロジック(基本/上級、ポン/ロン、宣言/取り消し、山札切れ再シャッフル) | 完成・`node js/tests.js` 23件 PASS |
| 手札 UI(タップ/ドラッグ並べ替え、スペース挿入、もどす) | 完成(土台) |
| Firebase 同期(部屋作成/参加、トランザクション、並びのデバウンス送信) | 完成(土台) |
| Firebase プロジェクト `hiragajan-online`(Firestore asia-northeast1、匿名認証) | 作成済み・ルール適用済み |
| 画面の見た目・ロビー・結果画面・モバイル調整 | **Phase B(未着手)** |
| GitHub リポジトリ・GitHub Pages 公開 | **Phase B(未着手)** |

### Phase B でやること(Sonnet)

計画ファイル: `C:\Users\nagoy\.claude\plans\web-4-firebase-13-14-mutable-book.md` の「UI/UX 方針」「Phase B」を参照。

1. hallmark スキルで `css/tokens.css` を生成して差し替え(現在は 02_動物将棋 の仮コピー)。`style.css` を UI/UX 方針どおりに整える
2. ロビー/待機画面の見た目(部屋コード巨大表示、参加者リスト、ルールトグル)
3. ゲーム画面の作り込み: `js/app.js` の `renderBanner` / `renderOthers` / `renderActions` / `renderModal` が拡張ポイント。ロジックや同期の仕組みは触らなくてよい
4. 上級ルール UI の磨き込み(ポン時の2枚選択、カウントダウン表示、meld の見せ方)
5. 手札非公開モードの見た目(裏面カード)
6. モバイル調整(14枚+スペースの折り返し、44px タップ領域、横スクロール禁止)
7. `docs/rules.md`(裁定表)、README の遊び方、`gh` でリポジトリ作成 → GitHub Pages 公開、Actions Secret `FIREBASE_TOKEN`

## ルール

- カード: 清音45種×2枚 + 濁音・半濁音25種×1枚 + っゃゅょー×1枚 = 120枚(「を」なし)
- **きほん**: 7枚配布。山札から1枚引いて8枚にし、「2文字 + 3文字 + 3文字」の実在する言葉ができたらあがり。できなければ1枚捨てて次の人へ
- **じょうきゅう**: 13枚配布。14枚で「2 + 3 + 3 + 3 + 3」または「2×7(七対子)」。誰の捨て札でもポン(捨て札+手札2枚を場に固定→1枚捨てる→ポンした人の次から再開)。他人の捨て札であがる「ロン」もあり
- **あがりの判定は手動**: 宣言すると全員の画面に手札が言葉ごとに区切って大きく表示される。口頭で相談し、宣言者が「成立」か「取り消し」を押す(アプリは枚数しか見ない)
- 山札が尽きたら全員の捨て札をシャッフルして山札に戻す
- 最初の手番はランダム、以降は前の局の勝者から。勝ち数は部屋内で累計

## ファイル構成

```
index.html               ロビー / 待機 / ゲーム画面(1ページ切替)
tests.html               自己検証 + 手札UIの手動確認
css/tokens.css           デザイントークン(Phase B で hallmark 生成に差し替え)
css/style.css            スタイル
js/firebase-config.js    Firebase クライアント設定(公開情報。コミット可)
js/cards.js              120枚の定義、山札生成、シャッフル、layout→言葉分割
js/game-logic.js         ルールエンジン(Firebase/DOM 非依存の純粋関数)
js/hand-ui.js            手札レイアウト編集コンポーネント(DOM のみ)
js/app.js                Firebase 接続・部屋・購読・トランザクション・描画
js/tests.js              テスト(node js/tests.js / tests.html)
firestore.rules          Firestore セキュリティルール
firebase.json .firebaserc
.github/workflows/deploy-firestore-rules.yml  rules 変更時に自動デプロイ
```

## 設計メモ

### データ構造(Firestore `rooms/{code}` 1ドキュメント)

```js
{
  code, hostUid, status: 'lobby'|'playing',
  settings: { mode: 'basic'|'advanced', openHands: bool, claimSeconds: number },
  players: { [uid]: { name, wins, joinedAt } },
  order: [uid...],            // 席順。手番はこの index で回す
  round: {
    no, turnIndex, phase: 'draw'|'discard'|'claim'|'declare'|'result',
    deck: [id],               // 先頭から引く
    hands: { [uid]: { layout: [id|'_'], melds: [{ cards: [id,id,id], from }] } },
    discards: { [uid]: [id] }, lastDiscard: { uid, cardId, at }|null,
    claim: { passed: [uid], deadline }|null,
    declaration: { uid, type: 'tsumo'|'ron', cardId?, fromUid? }|null,
    winner, drawnCard, version
  }
}
```

- `layout` が手札の唯一のソース。`'_'` がスペースで、カード = layout から `'_'` を除いたもの
- `melds` は「配列の配列」が Firestore に置けないため `{ cards: [...] }` の配列

### 同期

- ゲーム操作は `runAction('関数名', ...args)`: `runTransaction` 内で doc を読み `GameLogic[関数名](room, uid, ...)` を適用して書き戻す。競合(ポン vs ツモ など)は Firestore のトランザクションが解決する
- 自分の手札の並びだけはトランザクションなしで `round.hands.{uid}.layout` を 400ms デバウンスで更新。**操作前に必ず `flushLayout()`** を呼ぶ(古い並びで上書きされるのを防ぐ)
- 手札は本来「全員に見える」ゲームなので DB 上に全員分ある。非公開設定はクライアント側で伏せるだけ(信頼ベース)。山札の順序も DB 上では見える

## セットアップ

Firebase プロジェクト `hiragajan-online` は作成済み。別プロジェクトで動かす場合:

1. Firebase コンソールでプロジェクト作成 → Authentication で「匿名」を有効化 → Firestore を作成
2. プロジェクトの設定 > マイアプリ(ウェブ)の設定値を `js/firebase-config.js` に貼る
3. `firestore.rules` を適用(`firebase deploy --only firestore:rules`、または GitHub Actions の Secret `FIREBASE_TOKEN` に `firebase login:ci` のトークンを登録すると rules 変更時に自動適用)

## ローカルで動かす

Firebase SDK を CDN から読むため `file://` では動かない。ローカルサーバー経由で開く。

```bash
npx serve .
```

`http://localhost:3000/` を 2〜4 タブ(またはスマホ)で開き、片方で部屋をつくって片方でコードを入れる。ロジックだけなら:

```bash
node js/tests.js
```

## GitHub Pages で公開(Phase B)

`gh repo create` → push → Settings > Pages で `main` / `/ (root)` を指定。

## 今後決めること

- 切断検知(Firestore に onDisconnect は無い。必要なら Realtime Database のプレゼンス、または `lastSeenAt` ハートビート + ホストの手番スキップ)
- 古い部屋の掃除(Firestore の TTL ポリシーを `createdAt` に設定)
- 山札の順序が DB 上で見える点をどこまで気にするか
