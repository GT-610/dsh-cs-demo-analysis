[English](README.en-US.md)

# dsh-cs-demo-analysis

DeepSeek Harness 的《反恐精英 2》demo 复盘模式。它在标准模式全部能力之上，增加一套本地 demo 工具：解析、回合、经济、选手统计、道具、位置与地图认知。demo 在本机解析，不会上传。

## 特性

- 13 个 `cs2_*` 工具，输出有界，逐条标注 `sampled` / `truncated`。
- 回合按 tick 窗口归属，不依赖 demo 的 `total_rounds_played` 计数。
- 位置采样带游戏内地名（`last_place_name`）与包点触发标记。
- N-API 解析在 worker 线程运行，不阻塞 Harness 主进程。
- 附带 `cs2-review` 技能：复盘流程、指标定义、报告模板，按需加载。
- MIT 许可。

## 环境要求

- DeepSeek Harness Desktop，或支持安装 bundle 的 `dsh` profile。
- Node.js 20 或更高版本。
- 一份 Counter-Strike 2（Source 2）demo。CS:GO demo 不受支持。
- macOS arm64/x64、Windows x64 或 Linux x64/arm64（`@laihoe/demoparser2` 提供预编译包）。

## 安装

1. 在本目录安装依赖：

   ```bash
   npm install
   ```

2. 把目录作为 bundle 安装到当前 profile：

   ```text
   plugin_manager { action: "install_bundle", target: "<本目录的绝对路径>" }
   ```

3. 重启 DeepSeek Harness。

4. 新建会话，模式选择「CS2 Demo 复盘」。

本地目录安装只会把目录 link 进 profile，不会安装本包自己的依赖，所以第 1 步不能省。

## 使用

直接说出 demo 路径：

```text
分析 D:/demos/2026-11-01_mirage.dem，重点看我们的 T 方进攻和 B 点守转攻。
```

也可以不给路径：

```text
帮我找找桌面上最近的 demo，看看为什么经济总是崩。
```

模型会先调用 `cs2_find_demos` 定位文件，再用 `cs2_demo_header` / `cs2_list_players` 建立上下文，最后按问题选择证据工具。压缩包（`.bz2` / `.rar` / `.zip`）由 Agent 用 shell 自行解压；demo 工具只接受 `.dem`。

## 工具

| 工具 | 用途 |
| --- | --- |
| `cs2_find_demos` | 列出目录下（两层）的 `.dem` 文件。 |
| `cs2_demo_header` | 地图、服务器、demo 格式、补丁版本与文件信息。 |
| `cs2_list_players` | 阵容、Steam ID、起始阵营、稳定的 A/B 队身份。 |
| `cs2_list_events` | demo 中实际出现的事件名。 |
| `cs2_query_events` | 有界事件行；支持额外属性、`where` 精确过滤、`rounds` 列表。 |
| `cs2_query_ticks` | 指定或均匀采样的 tick 玩家状态；自动派生 `best_weapon`。 |
| `cs2_query_grenades` | 聚合后的手雷轨迹；返回友好类型与引擎类名。 |
| `cs2_round_summary` | 每回合的 tick 窗口、胜方、原因、击杀数、比分与经济摘要。 |
| `cs2_economy` | 冻结期经济：余额、装备值、当回合支出、买枪分类。 |
| `cs2_utility` | 每名玩家的烟雾/闪光/燃烧瓶/HE、致盲与道具伤害。 |
| `cs2_positions` | 位置采样；原始行或地名/网格热图。 |
| `cs2_map_overview` | 地图使用概览：地名目录、队伍时间占比、地图与包点范围。 |
| `cs2_player_stats` | K/D/A、ADR、KAST、近似 rating、开局、补枪、残局、道具。 |

## 回合、经济与统计

- **回合归属**：以 `round_end` tick 与前一个 `round_start` 组成窗口，事件按 tick 落入窗口。demo 计数器在不同版本/不同事件上的基数不一致（职业 demo 的 `round_end` 是 1 基，`round_start` 与局内事件是 0 基），因此不参与编号。
- **异常回合**：`tick = 1` 且无胜方/原因的 `round_end` 视为录制残留，直接丢弃，不影响后续编号。
- **经济**：`cash_spent_this_round` 是当回合购买支出；`cash_spent_match_cumulative` 是 demo 的累计 `total_cash_spent`，不是当回合值。
- **买枪分类**：按冻结期人均装备值划分 `eco` < 2000、`semi-buy` < 3500、`force-buy` < 4500、`full-buy`；手枪局标记 `pistol`。
- **KAST**：有击杀、助攻、存活，或被队友在 5 秒 / 320 tick 内补枪的回合占比。
- **rating / impact**：公开的 HLTV 2.0 近似公式，不是官方数值。
- **闪光**：需要 `player_blind` 事件。部分职业 demo 不包含该事件，此时相关字段为 `null`，并给出 `flash_data_available: false`，不会用 0 冒充测量值。
- **A/B 队**：A 是首先做 CT 的阵容，B 首先做 T；demo 不含俱乐部名，所以跨图时 A/B 可能互换。

## 地图认知

CS2 demo 自带 `m_szLastPlaceName`，即游戏对玩家所在区域的口径。位置工具在每次采样时请求该字段，因此坐标会附带 `Truck`、`Jungle`、`Underpass`、`BombsiteA`、`TopofMid` 这类地名。

`cs2_map_overview` 汇总地名、队伍时间占比、每个地名的坐标范围，以及从 `in_bomb_zone` 采样点算出的紧致 `bomb_targets`：

- 地名范围是 callout 的实际范围；
- `in_bomb_zone` 只是包点触发器的小体积，不等同于整个包点；
- demo 不包含碰撞几何，工具无法证明“这个点被箱子挡住”或某条视线是否通。这类判断只能由模型结合地图知识给出，并应标注为推断。

## 架构

- `src/parse-worker.js`：worker 线程中的 N-API 解析；手雷在 worker 内先聚合再回传。
- `src/parser.js`：可重启的主线程客户端，带超时与取消。
- `src/demo-store.js`：会话工作区路径解析、`PBDEMS2` 校验、按文件版本缓存 header/阵容/事件。
- `src/analysis.js`：回合窗口、经济、选手统计、道具统计。
- `src/spatial.js`：回合时间窗、tick 采样、地名/网格聚合。
- `src/tools.js`：模型可见的工具与边界。
- `src/plugin.js`：preset 挂载入口与 runtime skill 注册。
- `skills/cs2-review/SKILL.md`：复盘流程、指标口径与报告模板。

所有返回行的工具都会均匀采样、限制序列化体积，并报告 `truncated` / `sampled`。

## 开发与测试

```bash
npm install
npm test
```

不带环境变量时只跑单元测试。用真实 demo 跑集成测试：

```bash
CS2_DEMO=/absolute/path/to/match.dem npm test
```

用职业 demo 跑回归（回合编号、比分、经济、包点标签）：

```bash
CS2_DEMO=/path/match.dem CS2_PRO_DEMO_DIR=/path/pro-demos npm test
```

demo 文件已被 git 忽略，不会进入仓库。

## 隐私与安全

- demo 在本机由原生解析器读取。
- 只有工具返回的 JSON 会进入模型上下文。
- 路径校验：常规文件、大小上限、Source 2 demo 标记（`PBDEMS2`）。
- 插件不调用 shell，不写入 demo 文件。

## 已知限制

- 仅支持 CS2 demo；不支持 CS:GO、`.bz2`、`.rar`、`.zip`（由 Agent 自行解压）。
- demo 不含沟通、意图与指挥信息。
- 位置证据取决于采样步长，短距离转移可能被漏掉。
- 不建模碰撞几何与视线。
- 部分职业 demo 没有 `player_blind`，闪光效率不可用。
- demo 不含俱乐部名，A/B 是起始阵营标签。
- rating / impact 是近似值。
- demo 格式变化可能需要升级 `@laihoe/demoparser2`。

## 许可

MIT，见 [LICENSE](LICENSE)。

解析器为 [`@laihoe/demoparser2`](https://github.com/LaihoE/demoparser)（MIT）。
