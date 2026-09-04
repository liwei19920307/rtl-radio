use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::{bounded, Receiver, TrySendError};
use std::collections::VecDeque;

use crate::audio_chunk::{AudioChunk, AudioMsg};
use crate::demod::Demodulator;
use crate::squelch::{mode_uses_noise_squelch, SquelchGate};
use crate::record::{shared_recorder, AudioRecorder};
use crate::rtl_tcp::RtlTcpClient;
use crate::spectrum::{SpectrumEmitter, SpectrumState};
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver as CmdReceiver, Sender as CmdSender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::ipc::Channel;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RadioConfig {
    pub host: String,
    pub port: u16,
    pub freq_hz: u32,
    pub gain_db: f32,
    pub gain_auto: bool,
    pub ppm: i32,
    pub mode: String,
    #[serde(default)]
    pub bandwidth_hz: u32,
    #[serde(default = "default_true")]
    pub deemphasis: bool,
    #[serde(default = "default_buffer_preset")]
    pub buffer_preset: String,
    #[serde(default)]
    pub squelch_enabled: bool,
    #[serde(default = "default_squelch_level")]
    pub squelch_level: f32,
}

fn default_buffer_preset() -> String {
    "balanced".into()
}

fn default_squelch_level() -> f32 {
    0.30
}

struct BufferTuning {
    /// How many IQ chunks DSP keeps instead of dropping. Absorbs network jitter.
    iq_keep: usize,
    playback_max: usize,
    retune_skip_ms: f32,
}

/// Shared IQ queue so switching 缓冲 while playing can actually keep more data.
const IQ_QUEUE_CAP: usize = 16;
const POOL_BUFFERS: usize = 20;

fn buffer_tuning(preset: &str) -> BufferTuning {
    match preset {
        "low_latency" => BufferTuning {
            iq_keep: 2,
            playback_max: 6,
            retune_skip_ms: 280.0,
        },
        "wifi" => BufferTuning {
            iq_keep: 6,
            playback_max: 12,
            retune_skip_ms: 450.0,
        },
        _ => BufferTuning {
            iq_keep: 3,
            playback_max: 8,
            retune_skip_ms: 360.0,
        },
    }
}

struct StreamStats {
    iq_drops: AtomicU32,
    audio_drops: AtomicU32,
    audio_underruns: AtomicU32,
}

impl Default for StreamStats {
    fn default() -> Self {
        Self {
            iq_drops: AtomicU32::new(0),
            audio_drops: AtomicU32::new(0),
            audio_underruns: AtomicU32::new(0),
        }
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RadioStatus {
    pub playing: bool,
    pub level: f32,
    pub level_l: f32,
    pub level_r: f32,
    pub error: Option<String>,
    pub connected: bool,
    pub recording: bool,
}

enum RadioCommand {
    Retune(RadioConfig),
    SetDemod { bandwidth_hz: u32, deemphasis: bool },
    SetAudio {
        squelch_enabled: bool,
        squelch_level: f32,
    },
    Shutdown,
}

pub struct RadioController {
    cmd_tx: CmdSender<RadioCommand>,
    worker: Option<JoinHandle<()>>,
    level: Arc<Mutex<f32>>,
    level_l: Arc<Mutex<f32>>,
    level_r: Arc<Mutex<f32>>,
    error: Arc<Mutex<Option<String>>>,
    connected: Arc<AtomicBool>,
    playing: Arc<AtomicBool>,
    recorder: Arc<AudioRecorder>,
    last_record_path: Arc<Mutex<Option<String>>>,
}

impl RadioController {
    pub fn start(
        cfg: RadioConfig,
        spectrum_channel: Channel<crate::spectrum::SpectrumView>,
    ) -> Result<Self, String> {
        let (cmd_tx, cmd_rx) = mpsc::channel();
        let level = Arc::new(Mutex::new(0.0f32));
        let level_l = Arc::new(Mutex::new(0.0f32));
        let level_r = Arc::new(Mutex::new(0.0f32));
        let error = Arc::new(Mutex::new(None));
        let connected = Arc::new(AtomicBool::new(false));
        let playing = Arc::new(AtomicBool::new(false));
        let recorder = shared_recorder();
        let last_record_path = Arc::new(Mutex::new(None));
        let error_cb = Arc::clone(&error);

        let level_w = Arc::clone(&level);
        let level_l_w = Arc::clone(&level_l);
        let level_r_w = Arc::clone(&level_r);
        let error_w = Arc::clone(&error);
        let connected_w = Arc::clone(&connected);
        let playing_w = Arc::clone(&playing);
        let recorder_w = Arc::clone(&recorder);

        let worker = thread::spawn(move || {
            if let Err(e) = run_worker(
                cfg,
                cmd_rx,
                level_w,
                level_l_w,
                level_r_w,
                error_w,
                connected_w,
                playing_w,
                recorder_w,
                spectrum_channel,
            ) {
                *error_cb.lock() = Some(e);
            }
        });

        Ok(Self {
            cmd_tx,
            worker: Some(worker),
            level,
            level_l,
            level_r,
            error,
            connected,
            playing,
            recorder,
            last_record_path,
        })
    }

    fn send(&self, cmd: RadioCommand) -> Result<(), String> {
        self.cmd_tx.send(cmd).map_err(|e| e.to_string())
    }

    pub fn retune(&self, cfg: RadioConfig) -> Result<(), String> {
        self.send(RadioCommand::Retune(cfg))
    }

    pub fn set_demod(&self, bandwidth_hz: u32, deemphasis: bool) -> Result<(), String> {
        self.send(RadioCommand::SetDemod {
            bandwidth_hz,
            deemphasis,
        })
    }

    pub fn set_audio(&self, squelch_enabled: bool, squelch_level: f32) -> Result<(), String> {
        self.send(RadioCommand::SetAudio {
            squelch_enabled,
            squelch_level,
        })
    }

    pub fn record_start(&self, path: String, stereo: bool) -> Result<(), String> {
        *self.last_record_path.lock() = Some(path.clone());
        let channels = if stereo { 2 } else { 1 };
        self.recorder.start(path.into(), 48_000, channels)
    }

    pub fn record_stop(&self) -> Result<(), String> {
        self.recorder.stop();
        Ok(())
    }

    pub fn last_record_path(&self) -> Option<String> {
        self.last_record_path.lock().clone()
    }

    pub fn status(&self) -> RadioStatus {
        RadioStatus {
            playing: self.playing.load(Ordering::SeqCst),
            level: *self.level.lock(),
            level_l: *self.level_l.lock(),
            level_r: *self.level_r.lock(),
            error: self.error.lock().clone(),
            connected: self.connected.load(Ordering::SeqCst),
            recording: self.recorder.is_recording(),
        }
    }

    pub fn stop(mut self) {
        let _ = self.recorder.stop();
        let _ = self.send(RadioCommand::Shutdown);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        self.playing.store(false, Ordering::SeqCst);
        self.connected.store(false, Ordering::SeqCst);
    }
}

fn run_worker(
    mut cfg: RadioConfig,
    cmd_rx: CmdReceiver<RadioCommand>,
    level: Arc<Mutex<f32>>,
    level_l: Arc<Mutex<f32>>,
    level_r: Arc<Mutex<f32>>,
    error: Arc<Mutex<Option<String>>>,
    connected: Arc<AtomicBool>,
    playing: Arc<AtomicBool>,
    recorder: Arc<AudioRecorder>,
    spectrum_channel: Channel<crate::spectrum::SpectrumView>,
) -> Result<(), String> {
    let (audio_tx, audio_rx) = bounded::<AudioMsg>(48);
    let spectrum = Arc::new(Mutex::new(SpectrumState::new()));
    let (frame_tx, frame_rx) = bounded::<crate::spectrum::SpectrumView>(2);
    let (spec_iq_tx, spec_iq_rx) = bounded::<Vec<u8>>(2);

    let stats = Arc::new(StreamStats::default());
    let squelch_enabled = Arc::new(AtomicBool::new(cfg.squelch_enabled));
    let squelch_level = Arc::new(Mutex::new(cfg.squelch_level));
    let squelch_noise = Arc::new(AtomicBool::new(mode_uses_noise_squelch(&cfg.mode)));
    let signal_open = Arc::new(AtomicBool::new(true));
    let start_tuning = buffer_tuning(&cfg.buffer_preset);
    let playback_max = Arc::new(AtomicU32::new(start_tuning.playback_max as u32));
    let iq_keep = Arc::new(AtomicU32::new(start_tuning.iq_keep as u32));

    thread::spawn(move || {
        while let Ok(mut frame) = frame_rx.recv() {
            // WebView 慢时只保留最新一帧，避免 IPC 积压拖垮 DSP
            while let Ok(fresh) = frame_rx.try_recv() {
                frame = fresh;
            }
            let _ = spectrum_channel.send(frame);
        }
    });

    let spectrum_spec = Arc::clone(&spectrum);
    let level_spec = Arc::clone(&level);
    let level_l_spec = Arc::clone(&level_l);
    let level_r_spec = Arc::clone(&level_r);
    let error_spec = Arc::clone(&error);
    let connected_spec = Arc::clone(&connected);
    let stats_spec = Arc::clone(&stats);
    let signal_open_spec = Arc::clone(&signal_open);
    let frame_tx_spec = frame_tx.clone();
    thread::spawn(move || {
        let mut emitter = SpectrumEmitter::new();
        while let Ok(chunk) = spec_iq_rx.recv() {
            let peak = *level_spec.lock();
            let peak_l = *level_l_spec.lock();
            let peak_r = *level_r_spec.lock();
            let err = error_spec.lock().clone();
            let connected = connected_spec.load(Ordering::SeqCst);
            let iq_drops = stats_spec.iq_drops.load(Ordering::Relaxed);
            let audio_drops = stats_spec.audio_drops.load(Ordering::Relaxed);
            let audio_underruns = stats_spec.audio_underruns.load(Ordering::Relaxed);
            let open = signal_open_spec.load(Ordering::Relaxed);
            let frame = {
                let mut state = spectrum_spec.lock();
                state.update(&chunk);
                emitter.take_frame(
                    &state,
                    peak,
                    peak_l,
                    peak_r,
                    open,
                    err,
                    connected,
                    iq_drops,
                    audio_drops,
                    audio_underruns,
                )
            };
            if let Some(frame) = frame {
                let _ = frame_tx_spec.try_send(frame);
            }
        }
    });

    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("no audio output device")?;
    let out_cfg = device.default_output_config().map_err(|e| e.to_string())?;
    let channels = out_cfg.channels() as usize;
    let mut playback = PlaybackState {
        rx: audio_rx,
        pending: VecDeque::with_capacity(16),
        chunk_l: Vec::new(),
        chunk_r: Vec::new(),
        chunk_pos: 0,
        last_l: 0.0,
        last_r: 0.0,
        playback_max: playback_max.clone(),
        stats: Arc::clone(&stats),
        starving: false,
    };
    let error_stream = Arc::clone(&error);
    let stream = device
        .build_output_stream(
            &out_cfg.into(),
            move |data: &mut [f32], _| write_output(data, channels, &mut playback),
            move |err| {
                *error_stream.lock() = Some(err.to_string());
            },
            None,
        )
        .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;

    playing.store(true, Ordering::SeqCst);
    let mut shutdown = false;

    while !shutdown {
        drain_commands(&cmd_rx, &mut cfg, &mut shutdown)?;
        if shutdown {
            break;
        }

        *error.lock() = Some("正在连接 rtl_tcp…".into());
        connected.store(false, Ordering::SeqCst);

        let mut client = RtlTcpClient::new(cfg.host.clone(), cfg.port);
        if let Err(e) = client.connect() {
            *error.lock() = Some(format!("连接失败: {e}，3 秒后重试"));
            if sleep_or_command(&cmd_rx, Duration::from_secs(3), &mut cfg, &mut shutdown)? {
                continue;
            }
            break;
        }

        let mut demod = Demodulator::from_mode(&cfg.mode);
        apply_demod_settings(&mut demod, &cfg);
        let iq_rate = demod.iq_rate();
        apply_config(&mut client, &cfg, iq_rate)?;
        spectrum.lock().set_tune(cfg.freq_hz, iq_rate as u32);
        let mut current_iq_rate = iq_rate as u32;
        let tuning = buffer_tuning(&cfg.buffer_preset);
        playback_max.store(tuning.playback_max as u32, Ordering::Relaxed);
        iq_keep.store(tuning.iq_keep as u32, Ordering::Relaxed);
        squelch_enabled.store(cfg.squelch_enabled, Ordering::Relaxed);
        *squelch_level.lock() = cfg.squelch_level;
        squelch_noise.store(mode_uses_noise_squelch(&cfg.mode), Ordering::Relaxed);
        let retune_skip_ms = tuning.retune_skip_ms;
        let iq_keep_dsp = Arc::clone(&iq_keep);
        let audio_tx_cmd = audio_tx.clone();
        let skip_iq = Arc::new(AtomicU32::new(0));
        let flush_dsp = Arc::new(AtomicBool::new(false));
        let skip_iq_reader = Arc::clone(&skip_iq);
        let skip_iq_dsp = Arc::clone(&skip_iq);
        let iq_rate_dsp = Arc::new(AtomicU32::new(current_iq_rate));
        let iq_rate_retune = Arc::clone(&iq_rate_dsp);
        let flush_dsp_thread = Arc::clone(&flush_dsp);
        let stats_iq = Arc::clone(&stats);
        let spectrum_tune = Arc::clone(&spectrum);

        let demod = Arc::new(Mutex::new(demod));
        let running = Arc::new(AtomicBool::new(true));
        let disconnected = Arc::new(AtomicBool::new(false));
        let running_iq = Arc::clone(&running);
        let demod_iq = Arc::clone(&demod);
        let level_iq = Arc::clone(&level);
        let level_l_iq = Arc::clone(&level_l);
        let level_r_iq = Arc::clone(&level_r);
        let recorder_iq = Arc::clone(&recorder);
        let connected_iq = Arc::clone(&connected);
        let sq_en_dsp = Arc::clone(&squelch_enabled);
        let sq_lv_dsp = Arc::clone(&squelch_level);
        let sq_noise_dsp = Arc::clone(&squelch_noise);
        let signal_open_iq = Arc::clone(&signal_open);

        let audio_tx_iq = audio_tx.clone();
        let spec_iq_tx_dsp = spec_iq_tx.clone();

        let (iq_tx, iq_rx) = bounded::<Vec<u8>>(IQ_QUEUE_CAP);
        let (pool_tx, pool_rx) = bounded::<Vec<u8>>(POOL_BUFFERS);
        for _ in 0..POOL_BUFFERS {
            let _ = pool_tx.send(vec![0u8; 64 * 1024]);
        }
        let pool_tx_stream = pool_tx.clone();
        let pool_rx_stream = pool_rx.clone();

        let connected_stream = Arc::clone(&connected_iq);
        client.start_iq_stream(
            move || match pool_rx_stream.recv_timeout(Duration::from_millis(500)) {
                Ok(buf) => buf,
                Err(_) => vec![0u8; 64 * 1024],
            },
            move |chunk| {
                if !running_iq.load(Ordering::SeqCst) {
                    let _ = pool_tx_stream.try_send(chunk);
                    return;
                }
                loop {
                    let remaining = skip_iq_reader.load(Ordering::Relaxed);
                    if remaining == 0 {
                        break;
                    }
                    match skip_iq_reader.compare_exchange_weak(
                        remaining,
                        remaining - 1,
                        Ordering::Relaxed,
                        Ordering::Relaxed,
                    ) {
                        Ok(_) => {
                            let _ = pool_tx_stream.try_send(chunk);
                            return;
                        }
                        Err(_) => continue,
                    }
                }
                connected_stream.store(true, Ordering::SeqCst);
                match iq_tx.try_send(chunk) {
                    Ok(()) => {}
                    Err(TrySendError::Full(chunk)) => {
                        stats_iq.iq_drops.fetch_add(1, Ordering::Relaxed);
                        let _ = pool_tx_stream.try_send(chunk);
                    }
                    Err(TrySendError::Disconnected(chunk)) => {
                        let _ = pool_tx_stream.try_send(chunk);
                    }
                }
            },
            Arc::clone(&disconnected),
        )?;

        let dsp_running = Arc::clone(&running);
        let pool_tx_dsp = pool_tx;
        let stats_dsp = Arc::clone(&stats);
        let dsp_thread = thread::spawn(move || {
            let mut chunk_idx = 0u64;
            let mut tmp_l = Vec::with_capacity(2048);
            let mut tmp_r = Vec::with_capacity(2048);
            let mut gate = SquelchGate::new();
            const SPEC_IQ_BYTES: usize = 32_768; // 16384 IQ pairs for fine waterfall FFT
            while dsp_running.load(Ordering::SeqCst) {
                let keep = iq_keep_dsp.load(Ordering::Relaxed).max(2) as usize;
                while iq_rx.len() > keep {
                    if let Ok(old) = iq_rx.try_recv() {
                        stats_dsp.iq_drops.fetch_add(1, Ordering::Relaxed);
                        let _ = pool_tx_dsp.try_send(old);
                    } else {
                        break;
                    }
                }
                let wait_ms = {
                    let rate = iq_rate_dsp.load(Ordering::Relaxed).max(1) as f32;
                    let chunk_ms = (65_536.0 / (2.0 * rate)) * 1000.0;
                    (chunk_ms * 2.8).clamp(80.0, 480.0) as u64
                };
                let chunk = match iq_rx.recv_timeout(Duration::from_millis(wait_ms)) {
                    Ok(c) => c,
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                        // Forwarded/WiFi stalls empty the queue — that is IQ loss, not overflow.
                        if skip_iq_dsp.load(Ordering::Relaxed) == 0 {
                            stats_dsp.iq_drops.fetch_add(1, Ordering::Relaxed);
                        }
                        continue;
                    }
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                };

                if flush_dsp_thread.swap(false, Ordering::SeqCst) {
                    while iq_rx.try_recv().is_ok() {}
                    demod_iq.lock().reset();
                    gate.reset();
                    let _ = pool_tx_dsp.try_send(chunk);
                    continue;
                }

                tmp_l.clear();
                tmp_r.clear();
                let (if_power, disc_noise) = {
                    let mut d = demod_iq.lock();
                    d.append_stereo(&chunk, &mut tmp_l, &mut tmp_r);
                    (d.if_power(), d.disc_noise())
                };
                if !tmp_l.is_empty() && sq_en_dsp.load(Ordering::Relaxed) {
                    let thresh = *sq_lv_dsp.lock();
                    let noise_mode = sq_noise_dsp.load(Ordering::Relaxed);
                    gate.apply(
                        &mut tmp_l,
                        &mut tmp_r,
                        if_power,
                        disc_noise,
                        thresh,
                        noise_mode,
                    );
                    signal_open_iq.store(gate.is_open(), Ordering::Relaxed);
                } else if !sq_en_dsp.load(Ordering::Relaxed) {
                    gate.reset();
                    signal_open_iq.store(true, Ordering::Relaxed);
                }
                let (peak_l, peak_r) = if tmp_l.is_empty() {
                    (0.0, 0.0)
                } else {
                    recorder_iq.try_write_stereo(&tmp_l, &tmp_r);
                    (
                        tmp_l.iter().map(|v| v.abs()).fold(0.0f32, f32::max),
                        tmp_r.iter().map(|v| v.abs()).fold(0.0f32, f32::max),
                    )
                };
                let peak = peak_l.max(peak_r);
                *level_iq.lock() = peak;
                *level_l_iq.lock() = peak_l;
                *level_r_iq.lock() = peak_r;
                if !tmp_l.is_empty() {
                    let _ = audio_tx_iq.send(AudioMsg::Chunk(AudioChunk {
                        left: std::mem::take(&mut tmp_l),
                        right: std::mem::take(&mut tmp_r),
                    }));
                }

                chunk_idx += 1;
                if chunk_idx % 3 == 0 {
                    let n = chunk.len().min(SPEC_IQ_BYTES);
                    let sample = chunk[..n].to_vec();
                    let _ = spec_iq_tx_dsp.try_send(sample);
                }

                if let Err(err) = pool_tx_dsp.send(chunk) {
                    let _ = pool_tx_dsp.try_send(err.into_inner());
                }
            }
        });

        *error.lock() = None;
        connected.store(true, Ordering::SeqCst);

        loop {
            match cmd_rx.recv_timeout(Duration::from_millis(20)) {
                Ok(first) => {
                    if apply_live_commands(
                        first,
                        &cmd_rx,
                        &mut cfg,
                        &demod,
                        &mut client,
                        &spectrum_tune,
                        &mut current_iq_rate,
                        &audio_tx_cmd,
                        &skip_iq,
                        &flush_dsp,
                        retune_skip_ms,
                        &playback_max,
                        &iq_keep,
                        &squelch_enabled,
                        &squelch_level,
                        &squelch_noise,
                    )? {
                        shutdown = true;
                        break;
                    }
                    iq_rate_retune.store(current_iq_rate, Ordering::Relaxed);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    shutdown = true;
                    break;
                }
            }
            if disconnected.load(Ordering::SeqCst) {
                *error.lock() = Some("连接断开，正在重连…".into());
                connected.store(false, Ordering::SeqCst);
                break;
            }
        }

        running.store(false, Ordering::SeqCst);
        client.stop_iq_stream();
        client.close();
        let _ = dsp_thread.join();
        if shutdown {
            break;
        }
        let _ = sleep_or_command(&cmd_rx, Duration::from_secs(2), &mut cfg, &mut shutdown)?;
    }

    playing.store(false, Ordering::SeqCst);
    connected.store(false, Ordering::SeqCst);
    drop(stream);
    Ok(())
}

/// Discard rtl_tcp IQ after retune so audio/spectrum aren't stuck on the old frequency.
fn schedule_iq_skip(skip_iq: &AtomicU32, iq_rate_hz: u32, skip_ms: f32) {
    let chunk_bytes = 64 * 1024;
    let chunk_ms = (chunk_bytes as f32 / (2.0 * iq_rate_hz.max(1) as f32)) * 1000.0;
    let n = ((skip_ms / chunk_ms).ceil() as u32).clamp(6, 64);
    skip_iq.store(n, Ordering::Relaxed);
}

fn apply_retune(
    cfg: &RadioConfig,
    demod: &Arc<Mutex<Demodulator>>,
    client: &mut RtlTcpClient,
    spectrum: &Arc<Mutex<SpectrumState>>,
    current_iq_rate: &mut u32,
    audio_tx: &crossbeam_channel::Sender<AudioMsg>,
    skip_iq: &AtomicU32,
    flush_dsp: &AtomicBool,
    skip_ms: f32,
    playback_max: &Arc<AtomicU32>,
    iq_keep: &Arc<AtomicU32>,
    squelch_enabled: &Arc<AtomicBool>,
    squelch_level: &Arc<Mutex<f32>>,
    squelch_noise: &Arc<AtomicBool>,
) -> Result<(), String> {
    let _ = audio_tx.send(AudioMsg::Flush);
    flush_dsp.store(true, Ordering::SeqCst);

    let tuning = buffer_tuning(&cfg.buffer_preset);
    playback_max.store(tuning.playback_max as u32, Ordering::Relaxed);
    iq_keep.store(tuning.iq_keep as u32, Ordering::Relaxed);
    squelch_enabled.store(cfg.squelch_enabled, Ordering::Relaxed);
    *squelch_level.lock() = cfg.squelch_level;
    squelch_noise.store(mode_uses_noise_squelch(&cfg.mode), Ordering::Relaxed);

    let (new_iq_rate, rebuild) = {
        let mut d = demod.lock();
        let rebuild = !same_mode_family(&cfg.mode, &d);
        if rebuild {
            *d = Demodulator::from_mode(&cfg.mode);
        }
        apply_demod_settings(&mut d, &cfg);
        d.reset();
        (d.iq_rate() as u32, rebuild)
    };
    let skip = if rebuild { skip_ms.max(480.0) } else { skip_ms };
    schedule_iq_skip(skip_iq, *current_iq_rate, skip);
    if new_iq_rate != *current_iq_rate {
        client.set_sample_rate(new_iq_rate)?;
        *current_iq_rate = new_iq_rate;
        schedule_iq_skip(skip_iq, new_iq_rate, skip);
    }
    {
        let mut spec = spectrum.lock();
        spec.set_tune(cfg.freq_hz, *current_iq_rate);
        spec.flush_display();
    }
    client.set_freq(cfg.freq_hz)?;
    client.set_ppm(cfg.ppm)?;
    if cfg.gain_auto {
        client.set_auto_gain()?;
    } else {
        client.set_manual_gain((cfg.gain_db * 10.0) as u32)?;
    }
    Ok(())
}

fn same_mode_family(mode: &str, demod: &Demodulator) -> bool {
    use Demodulator::*;
    match mode.to_ascii_lowercase().as_str() {
        "am" => matches!(demod, Am(_)),
        "dsb" => matches!(demod, Dsb(_)),
        "nfm" => matches!(demod, Nfm(_)),
        "usb" => matches!(demod, Usb(_)),
        "lsb" => matches!(demod, Lsb(_)),
        _ => matches!(demod, Wbfm(_)),
    }
}

fn apply_demod_settings(demod: &mut Demodulator, cfg: &RadioConfig) {
    demod.set_bandwidth_hz(resolve_bandwidth_hz(cfg));
    demod.set_deemphasis(cfg.deemphasis);
    demod.set_stereo(cfg.mode.eq_ignore_ascii_case("wbfm"));
}

fn fold_command(cmd: RadioCommand, cfg: &mut RadioConfig, need_retune: &mut bool, need_demod: &mut bool, shutdown: &mut bool) {
    match cmd {
        RadioCommand::Retune(c) => {
            *cfg = c;
            *need_retune = true;
        }
        RadioCommand::SetDemod {
            bandwidth_hz,
            deemphasis,
        } => {
            cfg.bandwidth_hz = bandwidth_hz;
            cfg.deemphasis = deemphasis;
            if !*need_retune {
                *need_demod = true;
            }
        }
        RadioCommand::SetAudio {
            squelch_enabled,
            squelch_level,
        } => {
            cfg.squelch_enabled = squelch_enabled;
            cfg.squelch_level = squelch_level;
        }
        RadioCommand::Shutdown => *shutdown = true,
    }
}

/// Drain queued commands so a stale FM retune cannot overwrite a later mode switch.
fn apply_live_commands(
    first: RadioCommand,
    cmd_rx: &CmdReceiver<RadioCommand>,
    cfg: &mut RadioConfig,
    demod: &Arc<Mutex<Demodulator>>,
    client: &mut RtlTcpClient,
    spectrum: &Arc<Mutex<SpectrumState>>,
    current_iq_rate: &mut u32,
    audio_tx: &crossbeam_channel::Sender<AudioMsg>,
    skip_iq: &AtomicU32,
    flush_dsp: &AtomicBool,
    skip_ms: f32,
    playback_max: &Arc<AtomicU32>,
    iq_keep: &Arc<AtomicU32>,
    squelch_enabled: &Arc<AtomicBool>,
    squelch_level: &Arc<Mutex<f32>>,
    squelch_noise: &Arc<AtomicBool>,
) -> Result<bool, String> {
    let mut shutdown = false;
    let mut need_retune = false;
    let mut need_demod = false;
    fold_command(first, cfg, &mut need_retune, &mut need_demod, &mut shutdown);
    while let Ok(cmd) = cmd_rx.try_recv() {
        fold_command(cmd, cfg, &mut need_retune, &mut need_demod, &mut shutdown);
    }
    if shutdown {
        return Ok(true);
    }
    if need_retune {
        apply_retune(
            cfg,
            demod,
            client,
            spectrum,
            current_iq_rate,
            audio_tx,
            skip_iq,
            flush_dsp,
            skip_ms,
            playback_max,
            iq_keep,
            squelch_enabled,
            squelch_level,
            squelch_noise,
        )?;
    } else if need_demod {
        apply_demod_settings(&mut demod.lock(), cfg);
        squelch_enabled.store(cfg.squelch_enabled, Ordering::Relaxed);
        *squelch_level.lock() = cfg.squelch_level;
        squelch_noise.store(mode_uses_noise_squelch(&cfg.mode), Ordering::Relaxed);
    } else {
        squelch_enabled.store(cfg.squelch_enabled, Ordering::Relaxed);
        *squelch_level.lock() = cfg.squelch_level;
        squelch_noise.store(mode_uses_noise_squelch(&cfg.mode), Ordering::Relaxed);
    }
    Ok(false)
}

fn drain_commands(
    cmd_rx: &CmdReceiver<RadioCommand>,
    cfg: &mut RadioConfig,
    shutdown: &mut bool,
) -> Result<(), String> {
    while let Ok(cmd) = cmd_rx.try_recv() {
        match cmd {
            RadioCommand::Retune(c) => *cfg = c,
            RadioCommand::SetDemod {
                bandwidth_hz,
                deemphasis,
            } => {
                cfg.bandwidth_hz = bandwidth_hz;
                cfg.deemphasis = deemphasis;
            }
            RadioCommand::SetAudio {
                squelch_enabled,
                squelch_level,
            } => {
                cfg.squelch_enabled = squelch_enabled;
                cfg.squelch_level = squelch_level;
            }
            RadioCommand::Shutdown => *shutdown = true,
        }
    }
    Ok(())
}

fn sleep_or_command(
    cmd_rx: &CmdReceiver<RadioCommand>,
    duration: Duration,
    cfg: &mut RadioConfig,
    shutdown: &mut bool,
) -> Result<bool, String> {
    let end = std::time::Instant::now() + duration;
    while std::time::Instant::now() < end {
        match cmd_rx.recv_timeout(Duration::from_millis(200)) {
            Ok(RadioCommand::Shutdown) => {
                *shutdown = true;
                return Ok(false);
            }
            Ok(RadioCommand::Retune(c)) => *cfg = c,
            Ok(RadioCommand::SetDemod {
                bandwidth_hz,
                deemphasis,
            }) => {
                cfg.bandwidth_hz = bandwidth_hz;
                cfg.deemphasis = deemphasis;
            }
            Ok(RadioCommand::SetAudio {
                squelch_enabled,
                squelch_level,
            }) => {
                cfg.squelch_enabled = squelch_enabled;
                cfg.squelch_level = squelch_level;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                *shutdown = true;
                return Ok(false);
            }
        }
    }
    Ok(true)
}

fn resolve_bandwidth_hz(cfg: &RadioConfig) -> f32 {
    if cfg.bandwidth_hz > 0 {
        return cfg.bandwidth_hz as f32;
    }
    match cfg.mode.to_ascii_lowercase().as_str() {
        "am" => 8_000.0,
        "dsb" => 12_000.0,
        "nfm" => 12_500.0,
        "usb" | "lsb" => 2_700.0,
        _ => 200_000.0,
    }
}

fn apply_config(
    client: &mut RtlTcpClient,
    cfg: &RadioConfig,
    iq_rate: f32,
) -> Result<(), String> {
    client.set_sample_rate(iq_rate as u32)?;
    client.set_freq(cfg.freq_hz)?;
    client.set_ppm(cfg.ppm)?;
    if cfg.gain_auto {
        client.set_auto_gain()?;
    } else {
        client.set_manual_gain((cfg.gain_db * 10.0) as u32)?;
    }
    Ok(())
}

struct PlaybackState {
    rx: Receiver<AudioMsg>,
    pending: VecDeque<AudioChunk>,
    chunk_l: Vec<f32>,
    chunk_r: Vec<f32>,
    chunk_pos: usize,
    last_l: f32,
    last_r: f32,
    playback_max: Arc<AtomicU32>,
    stats: Arc<StreamStats>,
    starving: bool,
}

fn write_output(data: &mut [f32], channels: usize, state: &mut PlaybackState) {
    while let Ok(msg) = state.rx.try_recv() {
        apply_audio_msg(state, msg);
    }
    let frames = data.len() / channels.max(1);
    for frame in 0..frames {
        let (l, r) = next_lr(state);
        if channels >= 2 {
            data[frame * channels] = l;
            data[frame * channels + 1] = r;
        } else {
            data[frame] = (l + r) * 0.5;
        }
    }
}

fn apply_audio_msg(state: &mut PlaybackState, msg: AudioMsg) {
    let max = state.playback_max.load(Ordering::Relaxed).max(2) as usize;
    match msg {
        AudioMsg::Flush => {
            state.pending.clear();
            state.chunk_l.clear();
            state.chunk_r.clear();
            state.chunk_pos = 0;
            state.last_l = 0.0;
            state.last_r = 0.0;
            state.starving = false;
        }
        AudioMsg::Chunk(chunk) => {
            while state.pending.len() >= max {
                state.pending.pop_front();
                state.stats.audio_drops.fetch_add(1, Ordering::Relaxed);
            }
            state.pending.push_back(chunk);
            state.starving = false;
        }
    }
}

fn refill_chunk(state: &mut PlaybackState) {
    if state.chunk_pos < state.chunk_l.len() && state.chunk_pos < state.chunk_r.len() {
        return;
    }
    while let Ok(msg) = state.rx.try_recv() {
        apply_audio_msg(state, msg);
    }
    if let Some(chunk) = state.pending.pop_front() {
        state.chunk_l = chunk.left;
        state.chunk_r = chunk.right;
        state.chunk_pos = 0;
        state.starving = false;
    } else {
        if !state.starving {
            state.stats.audio_underruns.fetch_add(1, Ordering::Relaxed);
            state.starving = true;
        }
        state.chunk_l.clear();
        state.chunk_r.clear();
        state.chunk_pos = 0;
    }
}

fn next_lr(state: &mut PlaybackState) -> (f32, f32) {
    refill_chunk(state);
    if state.chunk_pos < state.chunk_l.len() && state.chunk_pos < state.chunk_r.len() {
        state.last_l = state.chunk_l[state.chunk_pos];
        state.last_r = state.chunk_r[state.chunk_pos];
        state.chunk_pos += 1;
        return (state.last_l, state.last_r);
    }
    if state.starving {
        return (0.0, 0.0);
    }
    (state.last_l, state.last_r)
}
