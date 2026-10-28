# qq-dsh

QQ 本地单群归档。

独立的本机只读采集器，通过用户手动安装的 SnowLuma OneBot WebSocket 接收 QQ 群 `1072362245` 的新消息。它不是 QQ 官方组件；使用第三方客户端可能违反 QQ 服务条款或导致账号受限。群管理者许可已确认；启用前仍须确保群成员已获知采集用途、范围和保留时间。

采集器只接受 OneBot 群消息事件中 `group_id=1072362245` 的纯文字段；包含提及时以 `[提及]` 替代，不保存 QQ 号、昵称、图片、语音、文件或其他群的消息。群内你自己的文字发言也会保存。它不读取历史、不回复、不发消息、不调用群管理 API。采集器只连接 `127.0.0.1` 或 `::1`，自身不访问云端 LLM、搜索或遥测。这些只读限制只约束本包的代码路径，不会把 SnowLuma OneBot 连接或登录 QQ 账号变成平台级只读权限。

## 安装与状态

需要 Node.js 22.19 或更新版本。SnowLuma 必须由你手动下载、安装并扫码登录；本包不会代替你登录。可选 Windows 启动器只启动已安装的 SnowLuma，不下载或安装客户端。请在 SnowLuma 中启用 OneBot WebSocket 服务并配置 loopback 地址和访问令牌；默认地址为 `ws://127.0.0.1:3001/`，实际端口以 SnowLuma 显示值为准。

```powershell
cd "$env:USERPROFILE\.dsh\plugins\dsh-qq-archive"
npm install --ignore-scripts --no-audit --no-fund
node src/cli.js setup
node src/cli.js status
```

默认配置固定目标群并保持 `enabled: false`，因此上述命令不会连接 QQ。首次设置会在 `%USERPROFILE%\.dsh\data\qq-archive` 创建本地 SQLite 档案和发言者匿名化密钥。部署时应将该数据目录及 `config.json` 的 ACL 限制为当前 Windows 用户、SYSTEM 和本机 Administrators；Node 在 Windows 上不保证 `0o600` 文件模式能够替代 ACL。

## 启动、暂停与恢复

在 SnowLuma 正在运行、群内告知已完成后，在 PowerShell 中以安全提示读取访问令牌并启动采集器。令牌仅进入当前进程环境，不要发到聊天或命令行参数中：

```powershell
$secure = Read-Host 'SnowLuma access token' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:SNOWLUMA_ACCESS_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  node src/cli.js start --enable
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  Remove-Item Env:SNOWLUMA_ACCESS_TOKEN -ErrorAction SilentlyContinue
}
```

采集在前台运行。另开 PowerShell 窗口可运行 `node src/cli.js status` 查看连接、消息计数和断线区间，运行 `node src/cli.js pause` 暂停，或 `node src/cli.js resume` 恢复；运行中的进程每秒检查一次本地设置。按 `Ctrl+C` 停止进程。

如果 SnowLuma 没有显示 OneBot 服务已连接、令牌不匹配或端口错误，采集器会重试并显示断线区间。断线、程序未运行和平台事件范围限制都会造成缺口；本地记录不是完整群聊证明。此包尚未在你的 SnowLuma 实例上验证事件覆盖范围，所以不要在确认收到目标群事件之前把它当作正在归档。

## Windows 联合启动

创建 `%USERPROFILE%\.dsh\data\qq-archive\launcher-settings.json`，填入本机 SnowLuma 和 DeepSeek Harness 安装目录；不要把访问令牌写入此文件：

```json
{
  "snowLumaRoot": "C:\\Path\\to\\SnowLuma",
  "dshRoot": "C:\\Path\\to\\deepseek-harness"
}
```

运行 `scripts/install-desktop-shortcut.ps1` 创建 `DSH + QQ 群归档` 桌面入口。该入口复用或启动 SnowLuma，等 `127.0.0.1:5099` 与 OneBot `127.0.0.1:3001` 由同一 SnowLuma 进程监听后启动归档器，再在 DSH Web 尚未运行时执行 `pnpm dsh web`。检测到端口冲突、DeepSeek 出机开启，或 SnowLuma 的 `statusCommand.enabled` 不为 `false` 时会停止，不会启动重复实例。SnowLuma 的内置 `statusCommand` 默认启用，精确收到 `#sl` 时会由 SnowLuma 自己调用 OneBot 发消息；这不是归档器或 DSH 工具发出的。只读归档必须关闭该命令；启动器也会拒绝它仍开启的配置。此检查只覆盖该状态命令，不能限制其他能访问 SnowLuma/OneBot 令牌的代码。直接运行 `pnpm dsh web` 不会触发此启动流程。

启动 SnowLuma 可能预热该账号其他群的成员信息；此处理范围大于本归档器保存的单群消息。启动器从 SnowLuma 本地配置读取 OneBot 令牌，不把令牌放入命令行、快捷方式或 Git 文件。

## DSH 模型归总

独立 DSH 工具包只安装到 `web` profile，不修改 DeepSeek Harness 主仓库：

```powershell
pnpm dsh plugin --profile web add "link:C:/Users/Administrator/.dsh/plugins/dsh-qq-archive"
pnpm dsh --profile web --dump-config
```

确认 dump 中出现 `dsh-qq-local-archive` 后重启 DSH Web。工具默认只允许 `qq_archive_status` 查看状态；读取开关 `modelExportEnabled` 默认关闭。只有在群成员已获知消息会发送至当前 DSH 模型提供方后，才手动运行：

```powershell
node C:/Users/Administrator/.dsh/plugins/dsh-qq-archive/src/cli.js enable-model-export --confirm-group-notice 1072362245
```

此后用户请求群聊归总时，模型可调用 `qq_archive_read` 按日期分页读取文字。读取工具固定群号、每次最多 31 天、每页最多 50 条、每条最多 500 字、每次结果最多 20 KB。可用 `disable-model-export` 立即关闭出机读取；该开关与采集启停分开。没有 QQ 发送/回复工具。

读取到的消息会进入当前 DSH 会话日志，并发送给 profile 中配置的模型提供方（当前是 `deepseek-official / deepseek-v4-flash`）。已确认的群内告知必须涵盖这项出机处理；摘要也可能引用消息内容。采集器只在本机存储和过滤，只有 DSH 模型实际调用读取工具时，选中的消息才会交给提供方处理。

独立 CLI 的 `summarize` 仍提供本地规则归总：关键词线索、决定/待办候选项和本地消息引用；它不是生成式摘要，结果需要人工核对。消息原文默认保留 30 天，归总默认保留 90 天；采集器运行期间定期清理，所有 CLI 操作也会先执行过期清理。

```powershell
node src/cli.js search "项目计划" 2026-10-01 2026-10-07
node src/cli.js summarize 2026-10-01 2026-10-07
node src/cli.js delete-range 2026-10-01 2026-10-07
node src/cli.js erase --confirm-group 1072362245
```

搜索与归总内容只写到本地终端、数据库或 `%USERPROFILE%\.dsh\data\qq-archive\summaries`。删除日期范围会同时删除覆盖该范围的归总文件；整群删除需要精确确认群号。SQLite 启用 secure-delete 且不使用 WAL，但 SSD、系统备份或文件系统快照仍可能保留物理副本；请勿把该目录同步到云盘。

## 验证

```powershell
npm test
Invoke-Pester -Script .\test\start-dsh-with-qq.Tests.ps1
```

测试使用本机回环地址和临时数据库，不连接 QQ、SnowLuma、DeepSeek API 或公网服务。
