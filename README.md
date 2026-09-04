# RTL Radio

跨平台软件无线电客户端：**FM 广播、航空 AM、火腿 NFM、USB/LSB/DSB**，通过 `rtl_tcp` 拉取 IQ 并在本机实时解调播放。

[![License: PolyForm Noncommercial](https://img.shields.io/badge/License-PolyForm%20Noncommercial-red.svg)](LICENSE)

> **开源协议：禁止商用。** 详见 [LICENSE](LICENSE)。个人学习、业余无线电与非盈利使用免费；商业使用须另行取得作者授权。

![RTL Radio 界面截图 — FM 广播收听，频谱与瀑布图](docs/images/screenshot.jpg)

## 功能

- **多模式解调**：WBFM 立体声、NFM、AM、USB、LSB、DSB
- **频谱 + 瀑布图**：绝对 dBFS 刻度，ZOOM / RANGE / OFFSET（对齐 SDR#）
- **静噪**：FM/NFM 噪声静噪，AM/SSB 载波静噪（0–100 滑块）
- **顶栏可视化**：中心频段真实频谱柱，多种显示模式
- **搜台**：按模式自动扫描，结果本地持久化
- **录音**：立体声 WAV；「人声」按 RF 载波自动开停录
- **收藏 / 预设**：频率列表、用户预设
- **远端 rtl_tcp**：局域网或 SSH 转发均可

## 架构

```
[RTL-SDR USB] → rtl_tcp :1234 → 本机 RTL Radio → 解调 → 扬声器
                                      ↓
                                 频谱 / 瀑布 / 录音
```

更细的模块说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 测试与兼容性

> 作者为**业余开发者**（业余无线电爱好者），本项目在业余时间维护，测试覆盖有限。遇到问题欢迎在 [GitHub Issues](https://github.com/liwei19920307/rtl-radio/issues) 反馈，我会尽力回复。

**作者仅在以下环境实测通过：**

- 客户端：**macOS（Apple Silicon）**
- 硬件：**RTL2838U** + 远端 **rtl_tcp**
- 连接：局域网 / SSH 隧道 → `host:1234`

**以下尚未实测，不保证可用：**

- **Windows / Linux 桌面客户端**（提供构建包，欢迎反馈）
- 其他 RTL-SDR 型号、本机 USB 直插（需自行起 rtl_tcp）

详见 [docs/TESTING.md](docs/TESTING.md)。

### 下载安装包

预编译包见 **[GitHub Releases](https://github.com/liwei19920307/rtl-radio/releases)**：

| 平台 | 文件 |
|------|------|
| macOS | `RTL Radio_*_aarch64.dmg`（打开后拖入「应用程序」） |
| Windows | `RTL Radio_*_x64_en-US.msi` |
| Linux | `RTL Radio_*_amd64.deb` 或 `RTL Radio_*_amd64.AppImage` |

> **macOS 提示「已损坏」？** 不是 ARM 架构问题，是未做 Apple 开发者签名 + 下载隔离导致。打开 DMG 拖入「应用程序」后，若仍无法打开，执行 `xattr -cr "/Applications/RTL Radio.app"`，或右键 → 打开。详见 [docs/TESTING.md](docs/TESTING.md)。

推送 `v*` 标签（如 `v1.0.0`）会自动构建并发布到 Releases；手动触发 CI 会生成预发布包（`v1.0.0-build.N`）。

## 快速开始

### 环境

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) stable
- macOS / Windows / Linux

### 开发运行

```bash
git clone https://github.com/liwei19920307/rtl-radio.git
cd rtl-radio-mac
npm install
npm run tauri dev
```

默认连接 `127.0.0.1:1234`。侧边栏可改主机、端口、模式与频率。

### 打包安装

```bash
npm run build
npm run tauri build
```

产物：`src-tauri/target/release/bundle/`（`.app` / `.msi` / `.deb` 等）。

**跨平台构建**（在 macOS 上）：

```bash
./scripts/build-release.sh macos     # macOS .dmg
./scripts/build-release.sh windows   # Windows .exe（zip，无安装器）
./scripts/build-release.sh linux     # Linux .deb + AppImage（需 Docker）
```

产物在 `dist/release/`。

**含 .msi 安装包的正式构建**请用 GitHub Actions（`windows-latest` / `ubuntu-22.04`），见 `.github/workflows/release.yml`，或推送 `v*` 标签自动触发。

Windows / Linux 包**作者未实测**，见 [docs/TESTING.md](docs/TESTING.md)。

macOS 一键安装到「应用程序」：

```bash
./install-client.sh
```

## 使用提示

| 操作 | 说明 |
|------|------|
| `Space` | 开始 / 停止收听 |
| `R` | 开始 / 停止录音 |
| `←` `→` | 频率步进 |
| `Shift + ←` `→` | ×10 大步进 |
| `Alt + ←` `→` | 细调 |
| 频谱单击 | 调谐 |
| 拖金色块 | 调节接收频宽 |
| 顶栏 `i` | 完整操作手册 |

录音默认保存到系统「下载」文件夹，格式为 **48 kHz 立体声 WAV**。

## 项目结构

```
rtl-radio-mac/
├── src/                 # 前端 (Vite + JS)
├── src-tauri/src/       # Rust 后端（解调、rtl_tcp、频谱）
├── docs/
│   ├── ARCHITECTURE.md  # 架构与模块说明
│   └── images/          # 文档图片（含界面截图）
├── index.html
├── install-client.sh    # macOS 本地安装
├── LICENSE              # PolyForm Noncommercial 1.0.0
└── README.md
```

## 技术栈

- **壳**：Tauri 2
- **前端**：Vite、Canvas / WebGL 频谱
- **后端**：Rust — cpal 音频、rustfft、自研解调与静噪
- **协议**：osmocom rtl_tcp

## 开源协议

本项目采用 **[PolyForm Noncommercial License 1.0.0](LICENSE)**：

- ✅ 允许：个人使用、学习、修改、再分发（保留协议）、业余无线电、非盈利场景
- ❌ 禁止：任何商业用途（含收费分发、商业服务、企业内商用等）

如需商业授权，请通过下方方式联系作者。

## 支持作者

如果这个项目对你有帮助，欢迎扫码赞赏（自愿，非商业授权替代品）：

<table>
  <tr>
    <td align="center"><b>支付宝</b></td>
    <td align="center"><b>微信</b></td>
  </tr>
  <tr>
    <td><img src="docs/images/alipay.jpg" width="240" alt="支付宝收款码" /></td>
    <td><img src="docs/images/wechat.jpg" width="240" alt="微信收款码" /></td>
  </tr>
</table>

## 免责声明

- 作者为业余开发者，软件按「原样」提供，不保证在所有环境下可用。
- 请遵守所在地无线电管理法规，合法使用频率与发射功率。
- 作者不对使用后果承担责任。
