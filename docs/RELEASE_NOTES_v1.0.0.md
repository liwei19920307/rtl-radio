## 下载

| 平台 | 文件 |
|------|------|
| macOS | `RTL-Radio-macos.zip` |
| Windows | `RTL Radio_1.0.0_x64_en-US.msi` |
| Linux | `RTL Radio_1.0.0_amd64.deb` 或 `RTL Radio_1.0.0_amd64.AppImage` |

## 测试说明

作者为业余开发者，仅在 **macOS（Apple Silicon）+ RTL2838U + rtl_tcp** 环境实测。Windows / Linux 客户端**未实测**，其他硬件未测试。遇到问题欢迎 [提 Issue](https://github.com/liwei19920307/rtl-radio/issues)。

## 使用

1. 在接 RTL-SDR 的主机上自行运行 `rtl_tcp`（默认端口 1234，参见 [osmocom rtl_tcp](https://osmocom.org/projects/rtl-sdr/wiki/Rtl-tcp)）
2. 启动 RTL Radio，填写主机 IP 与端口
3. 选择模式与频率，按 `Space` 开始收听

更多操作见应用内顶栏 `i` 操作手册。
