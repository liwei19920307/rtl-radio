# 架构说明

## 数据流

```
RTL-SDR (USB)
    → rtl_tcp (TCP :1234, IQ uint8 交织)
    → RtlTcpClient (radio.rs / rtl_tcp.rs)
    → IQ 队列 + 线程池缓冲
    → Demodulator (demod.rs)
         ├─ wbfm.rs   FM 广播（立体声 PLL）
         ├─ nfm.rs    窄带 FM / 火腿
         ├─ am.rs     航空 AM
         ├─ ssb.rs    USB / LSB / DSB
    → SquelchGate (squelch.rs) 静噪门控
    → cpal 音频输出 + AudioRecorder (record.rs)
    → SpectrumState (spectrum.rs) FFT → 前端频谱/瀑布
```

## Rust 后端 (`src-tauri/src/`)

| 文件 | 职责 |
|------|------|
| `main.rs` | Tauri 入口 |
| `lib.rs` | 命令注册：`radio_start/stop/retune`、录音、状态 |
| `radio.rs` | 会话主循环：IQ 拉流、DSP 线程、播放、频谱推送 |
| `rtl_tcp.rs` | rtl_tcp 协议客户端 |
| `demod.rs` | 解调模式分发 |
| `wbfm.rs` / `nfm.rs` / `am.rs` / `ssb.rs` | 各模式解调器 |
| `squelch.rs` | FM 噪声静噪 / AM·SSB 载波静噪 |
| `spectrum.rs` | 16k FFT、dBFS 频谱帧 |
| `record.rs` | 立体声 WAV 录制 |
| `filter.rs` | IIR/FIR 滤波 |

## 前端 (`src/`)

| 文件 | 职责 |
|------|------|
| `main.js` | UI 逻辑、调谐、搜台、人声自动录、设置持久化 |
| `spectrum.js` | 频谱/瀑布显示、ZOOM/RANGE/OFFSET（SDR# 风格） |
| `webgl-spectrum.js` / `webgl-waterfall.js` | WebGL 渲染 |
| `audio-viz.js` | 顶栏迷你频谱可视化 |
| `frame-decode.js` | 频谱帧 base64 → Float32Array |

## IPC

- 频谱数据经 Tauri `Channel` 推送到 WebView（`SpectrumView` JSON + bins_b64）
- 解调参数经 `radio_retune` / `radio_set_demod` / `radio_set_audio` 下发
