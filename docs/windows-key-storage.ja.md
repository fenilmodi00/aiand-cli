[English](windows-key-storage.md) | **日本語**

# Windows でのキーの保存: コスト、リスク、テスト計画

Windows の DPAPI 方式がどのように動くかは、`CONTEXT.md`(Storage tier)と README([API キーの保存場所](../README.ja.md#api-キーの保存場所))にあります。このメモは、実際の多数のマシンに展開して運用する方に向けたものです。

## 読み取りのコスト

DPAPI へは、Windows PowerShell 5.1(`powershell.exe -NoProfile -NonInteractive -Command ...`。シークレットは標準入力だけで渡します)経由でアクセスします。ネイティブモジュールはありません。そのため、次のようになります。

- **コールドスタート時の読み取り**(キーが必要な、新しく起動した `aiand` プロセス)のたびに、PowerShell が 1 回起動します。**書き込み**のたびにも 1 回起動します。Windows PowerShell 5.1 は Node ではなく .NET Framework です。起動直後のマシンや、プロセスの起動をスキャンするエンドポイントセキュリティが動いているマシンでは、この起動に 1 秒以上かかることがあります(`DPAPI_TIMEOUT_MS` は 20 秒まで許容します)。
- 同じプロセスの中では、平文がキャッシュされます(`src/secrets.ts` の `dpapiPlaintext`)。キャッシュは、元になった暗号文をキーにしています。保存のあとに読み取る場合や、何度も読み取る場合でも、PowerShell は 1 回しか起動しません。ほかのプロセスがストアを書き換えたあと(トークンのローテーションやサインアウト)の読み取りでは、古いキャッシュを返さず、改めて復号します。`test/secrets-windows.test.mjs` がこれを検証しています("what a DPAPI read costs")。
- Codex は、**セッションごとに** `aiand key export` を認証コマンドとして実行します。それぞれが新しいプロセスなので、毎回 1 回のコールドスタート時の読み取りのコストがかかります。注意すべきコストはこれです。
- キャッシュはメモリ上だけです。このコストを隠すために、**ディスク上の平文キャッシュを追加しないでください。** 追加すると、ファイルのアクセス権だけでキーを守ることになり、これは DPAPI 方式が避けようとしているものです。設定フォルダー内のどのファイルにもキーが含まれていないことを、テストで検証しています。
- DPAPI への移行に失敗したファイル形式のキーは `credentials.json` に記録されるため、応答しない PowerShell の待ち時間(20 秒)は、プロセスごと(Codex のセッションはそれぞれ新しいプロセスです)ではなく 1 回で済みます。制約付き言語モード (Constrained Language Mode) は `storage_fallback: "clm"` として記録され、ポリシーによるものなので、読み取りでは再試行されません。それ以外(タイムアウト、PowerShell を起動できない)は、10 分先の `dpapi_retry_after` とともに `storage_fallback: "unavailable"` として記録されます。それまでの読み取りではキーはファイルに残り、`aiand status` がその理由を表示します。再試行の時刻が 10 分より先になっている場合は、時計が戻されたものとみなして無視します。次のサインインは、何が記録されていても DPAPI を試します。トークンの更新もキーを保存するので同様です。`AIAND_KEY_STORAGE=file` を設定すると、aiand は一切試しません。

## ロールバック

DPAPI に移ったキーは、古い aiand からは見えません。ファイルのストアに何も見つからないため、古い `aiand logout` は「not signed in」と表示するだけで、セッションの revoke も削除も行わず、リフレッシュトークンが `secret-store.dpapi.json` に残ります。ダウングレードする**前に** `aiand logout` を実行してください。ダウングレードしたあとにもう一度サインインするだけでは足りません。古いセッションはサーバー側でまだ有効で、そのトークンも DPAPI のストアに残っているからです。

## 所有者のみの ACL

設定フォルダー、キーのストア、起動するエージェントにキーを渡すための一時フォルダーは、現在のユーザーだけがアクセスできるように制限されます。`/inheritance:r` が削除するのは継承されたエントリだけで、`/grant:r` が置き換えるのはユーザー自身のエントリだけです。そのため、フォルダーに直接設定された SYSTEM や Administrators のエントリ(管理者権限のプロセスが作ったフォルダーや、GitHub がホストするランナーの一時フォルダーなど)は、どちらの操作でも残ります。aiand は、権限を付与したあとに ACL を一覧表示し、残っているそれ以外のプリンシパルをすべて削除します。`installer-windows` ジョブのスモークスクリプトは、実際の `icacls` でその結果を検証します。

ACL の変更では防げないことが 1 つあります。制限をかける前にほかのプロセスが開いたハンドルは、そのとき付与されたアクセス権を保ち続けます。Windows が ACL を確認するのは、ハンドルを開くときだけだからです。一時フォルダーについては、aiand は何かを書き込む前にフォルダーを制限し、そのあとでまだ空であることを確認し、各ファイルを排他的に作成します。そのため、継承された ACL の下で置かれたファイルや開かれたままのファイルには、書き込まずに拒否します。`TEMP` が他のユーザーも書き込めるフォルダーになっているマシンでは、自分だけが使えるフォルダーを `TEMP` に指定してください。

## エンドポイントセキュリティと AMSI

`-Command` のテキストは `[System.Security.Cryptography.ProtectedData]` を名指しして `Unprotect` を呼び出し、標準入力で base64 を受け取ります。この形は認証情報を盗むツールに似ているため、Microsoft Defender、サードパーティの EDR、AMSI が検知またはブロックすることがあります。ブロックされると、aiand から見ると通常の PowerShell の失敗と同じ `unavailable` になります。そのあとの動作は、aiand が書き込み中だったか、読み取り中だったかで変わります。

- **書き込み**(`aiand login`、トークンの更新)の場合: 警告が表示され、キーは所有者のみが読めるファイルに保存され、DPAPI は次の保存時にもう一度試されます。
- **読み取り**(すでに DPAPI にあるキーの読み取り)の場合: 新しく書き込めるものはありません。所有者のみが読めるファイルにコピーがあれば(DPAPI への移行が中断されると残ります)、それを使います。なければ、DPAPI が保存されたキーを復号できなかったという警告が表示され、もう一度 `aiand login` を実行するまでサインアウトした状態になります。

行わないこと: スクリプトを難読化したり、型名を断片から組み立てたりして、スキャナーをすり抜けることはしません。検知は、ユーザーのセキュリティチームが確認すべきシグナルであり、許可リストへの登録はチームが判断することです。

用意されている対策:

- `AIAND_KEY_STORAGE=file` を設定すると、新しい書き込みでは DPAPI と PowerShell を使いません(`AIAND_SECRET_STORE_MASTER_KEY` を指定すると、フォルダーのコピーに対してファイルが暗号化されます)。フォールバックの警告にもこの変数が示されます。ただし、すでに DPAPI にあるキーの**読み取り**で PowerShell が起動するのは止められません。プロファイルは、サインインしたときの保存先を記録しているためです。プロファイルを DPAPI から移すには、`AIAND_API_KEY` を未設定にして `AIAND_KEY_STORAGE=file` を設定し、そのプロファイルに対して `aiand login --force` を実行してください。サインインの際、古いキーを読むために PowerShell が 1 回起動することがあります。
- コマンドラインは固定で、識別できます。常に `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -Command <dpapiScript>` であり、`-ExecutionPolicy Bypass` や `-EncodedCommand` は使わず、シークレットは argv にも環境変数にも含まれません。セキュリティチームは、これを基準に許可リストへ登録できます。

## 実際の Windows マシンでのテスト計画

> **このテスト計画では PowerShell 7 を使ってください。** 以下のコマンドは、aiand のドキュメントにあるほかの PowerShell コマンドと同じく、PowerShell 7(`pwsh`)向けに書かれています。Windows PowerShell 5.1 にはセキュリティ修正しか提供されないため、Microsoft は PowerShell 7 のインストールを推奨しています: <https://learn.microsoft.com/ja-jp/powershell/scripting/install/install-powershell-on-windows>(Windows PowerShell 5.1 も、起動のたびにこのページへ誘導する <https://aka.ms/PSWindows> を表示します)。これは、コマンドを入力するシェルについての話です。aiand は引き続き DPAPI のために Windows PowerShell 5.1 を使います(Windows に付属しているので、インストールは不要です)。また、ワンライナーの `irm … | iex` を含む `install.ps1` は、5.1 でも動作し続けます。
>
> これらの手順では、キーを画面に表示してはいけません。`aiand key export` はキーを標準出力に書き出すため、以下ではその出力を破棄し、代わりに `$LASTEXITCODE` を確認します。キーをチケットやトランスクリプトに貼り付けないでください。

上記はすべて、macOS と Linux でスタブを使ってテストしています。ユニットテストでは、Defender、AMSI、実際の DPAPI のタイミングは確認できません。この方式を変更するリリースの前に、Windows 11 で、Defender のリアルタイム保護をオン、クラウド保護を既定の設定にして、次を実施してください。

1. `npm ci && npm run build && node scripts/windows-secrets-smoke.mjs`: 実際の DPAPI でのラウンドトリップ、ACL、制約付き言語モードへのフォールバックを確認します。`installer-windows` の CI ジョブは、Defender が有効な `windows-latest` でこれを実行するため、そこで検知されるとジョブが失敗します。
2. `aiand login` を実行し、`aiand status` を実行します。`storage  Windows DPAPI` と表示されることを確認します。Defender の通知がなく、保護の履歴にも何も記録されていないことを確認します。
3. コールドスタート時の読み取りの時間を、再起動の直後と、ウォーム状態の両方で、それぞれ 3 回計測し、どちらも記録します。`AIAND_KEY_STORAGE=file` と比較します: `Measure-Command { aiand key export | Out-Null; if ($LASTEXITCODE -ne 0) { throw "key export exited $LASTEXITCODE" } }`。
4. `aiand key export` のプロセスを 10 個同時に実行します: `1..10 | ForEach-Object -ThrottleLimit 10 -Parallel { aiand key export | Out-Null; $LASTEXITCODE }` は、プロセスごとに 1 つの終了コードを出力します。すべて `0` であり、`credentials.json` と両方のキーストアが壊れていないことを確認します。
5. Defender の Controlled folder access、Attack surface reduction ルール(LSASS からの認証情報の窃取をブロック、PSExec/WMI からのプロセス作成をブロック、難読化されたスクリプトをブロック)、Tamper protection をオンにして、手順 2 と 3 を繰り返します。aiand を親とする `powershell.exe` に対する ASR の監査イベントは、すべてレポートに含めてください。
6. Defender の Advanced Hunting またはイベントビューアー(Microsoft-Windows-Windows Defender/Operational、AMSI のイベント)で、`ProtectedData` を名指しした検知がないことを確認します。
7. わざとブロックします: `node.exe` から起動された `powershell.exe` をブロックする Defender のカスタムインジケーターを追加するか、`__PSLockdownPolicy=4` をマシン全体に設定します(`setx /M __PSLockdownPolicy 4` を実行して、新しいセッションを開きます)。プロセス単位の値は Server 2022 の Windows PowerShell には効かないため、スモークスクリプトはそこでロックダウンの確認を省略します。そのうえで `aiand login` を実行し直し、フォールバックを確認します。1 行の警告が表示され、キーが所有者のみが読めるファイルに保存され、`aiand status` が `file (owner-only, ...)` と表示されることを確認します。ロックダウンの場合は、制約付き言語モードの注記も表示されます。(PowerShell がブロックされている間は、すでに DPAPI にあるキーは自動では移動しません。その読み取りでは、復号できなかったと表示され、前述のとおりもう一度サインインするよう求められます。)ブロックを解除して `aiand login` を再度実行すると、キーが DPAPI に戻ります。
8. 共有フォルダー: 設定フォルダーを WSL と共有している場合(`AIAND_CONFIG_DIR=/mnt/c/Users/<you>/.config/aiand`)、Windows でサインインしたあとに WSL で `aiand status` を実行すると、キーが Windows DPAPI で保存されているのでもう一度サインインするよう表示され、プロセスは起動されません。
9. 展開先にサードパーティの EDR がある場合は、それでも 2 と 3 を繰り返します。

手順 2 または 6 で検知された場合は、リリースを保留してください。コードを変更する前に、上記のコマンドラインを許可リストへ登録することについて、セキュリティチームと相談してください。
