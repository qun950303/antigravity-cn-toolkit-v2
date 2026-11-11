# Antigravity 中文汉化与免 TUN 上网工具箱

专为 Google Antigravity 打造的工具箱，解决国内用户用 Antigravity 时的两个痛点：**界面英文看不懂**、**上网必须开 TUN 虚拟网卡**。

## 一键使用（发给你的 AI 智能体即可）

无需手动下载或配置。无论在任何 Windows 电脑上，只需把本仓库链接发在 Antigravity 聊天框：

> “请读取该仓库并执行一键配置免 TUN 出海网络与全中文汉化。”

或者在 PowerShell 中执行：

```powershell
git clone https://github.com/qun950303/antigravity-cn-toolkit-v2.git "$env:LOCALAPPDATA\antigravity-cn-toolkit-v2"; node "$env:LOCALAPPDATA\antigravity-cn-toolkit-v2\src\index.js"
```

## 默认流程（一键之后会发生什么）

默认流程**不碰 Antigravity 安装目录下的任何文件**，分三步：

1. **免 TUN 网络**：先检测本地代理端口（默认 127.0.0.1:10808）是不是在监听，通了才写用户环境变量（HTTP_PROXY / HTTPS_PROXY / ALL_PROXY），再测一次能不能出海。端口没开就什么都不写，绝不会因为盲目配置导致断网。
2. **热注入显示**：把翻译脚本打进正在运行的窗口，界面立刻变中文。只改内存里的界面显示，不改文件，关了软件就没了。词典 533 条对照，覆盖菜单、设置、指令、权限、左右键菜单。
3. **技能与插件说明汉化**：扫 `.gemini` 下面 4 个文件夹，把技能与插件的英文说明翻成中文，改的是用户配置，不是程序文件。翻过的记进本地词典，下次直接用。

## ASAR 持久化（手动开启，默认关闭）

默认流程重启软件后界面会恢复英文，重跑一键即可。想重启后还是中文，可以手动开启 ASAR 持久化：

```powershell
node src/index.js --persist
```

开启前请看清风险：

- 这一步会拆开 Antigravity 安装目录下的官方程序文件 app.asar，把翻译写进启动文件，再打包覆盖回去。
- 官方更新会覆盖改动，需要重跑一次。
- 改坏可能导致软件无法启动（改之前会自动备份，见下条）。

**一键恢复**：如果改坏了或者不想用了，执行下面命令，用备份恢复官方原厂文件：

```powershell
node src/index.js --restore
```

## 新装插件的说明怎么变中文

新装的插件或技能，说明还是英文的，处理办法：

1. 执行 `node src/system/localize-skills.js`，脚本会扫描并打印一份待翻译清单。
2. 运行本工具的模型把清单里的英文翻成中文，写成 JSON 文件（格式：`{"英文原文": "中文"}`）。
3. 执行 `node src/system/localize-skills.js --apply 翻译.json`，写回去并记进词典。

脚本自己不编造翻译，只负责找英文、写回去、记词典。改之前先备份（.orig），重复执行安全。

## 左右键菜单

左右键菜单（右键菜单等）的词条放在词典里，由翻译器在显示的时候翻。不改主进程菜单模板——之前有人这么改过，把系统自带的复制、粘贴菜单项弄坏了，最后整笔撤回。

## 常见问题

### 官方更新后，汉化会丢失吗？

热注入的会丢，重跑一键即可；ASAR 持久化的也会被覆盖，重跑 `node src/index.js --persist` 即可。

### 重启软件后界面恢复英文了，怎么办？

这是默认流程的正常现象（热注入只在软件开着的时候生效）。重跑一键，或者开启 ASAR 持久化。

### 改坏了软件打不开，怎么办？

执行 `node src/index.js --restore`，用备份恢复官方原厂文件，重启软件即可。

### 免 TUN 是怎么做的？

只写 Windows 用户级环境变量，让 Antigravity、Node、命令行进程走本地代理，不开虚拟网卡，不接管整机路由，不影响其他软件与局域网。环境变量改完需要重启 Antigravity 才生效。

## 项目结构

```text
antigravity-cn-toolkit-v2/
├── src/
│   ├── index.js                  # 一键总控入口（默认流程 / --persist / --restore）
│   ├── i18n/
│   │   ├── dict.json             # 533 条中英对照词典（含左右键菜单词条）
│   │   ├── learned.json          # 已翻过的记录（初始为空，越用越全）
│   │   └── translator.js         # 翻译引擎（热注入显示 + ASAR 持久化，二者分开）
│   ├── network/
│   │   └── setup-network.js      # 免 TUN 网络配置（检测端口、写环境变量、连通性测试）
│   └── system/
│       └── localize-skills.js    # 技能与插件说明汉化（扫文件夹，不用写死名单）
├── README.md
├── package.json
└── LICENSE
```

## 环境要求

- Windows 10/11
- Node.js >= 18
- 本地代理客户端（Xray / V2Ray 等）在 127.0.0.1:10808 监听（免 TUN 需要）

## 开源许可证

本项目基于 [MIT License](LICENSE) 开源。
