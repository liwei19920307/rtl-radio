use base64::{engine::general_purpose::STANDARD, Engine as _};
use num_complex::Complex32;
use rustfft::{Fft, FftPlanner};
use std::sync::atomic::{AtomicU32, Ordering};

/// Bin width ≈ sample_rate / FFT_SIZE (AM 1.024e6 → ~62.5 Hz/bin).
const FFT_SIZE: usize = 16_384;
const DISPLAY_BINS: usize = FFT_SIZE;

pub struct FftEngine {
    iq_buf: Vec<Complex32>,
    fft: std::sync::Arc<dyn Fft<f32>>,
    scratch: Vec<Complex32>,
    window: Vec<f32>,
    /// Window coherent gain Σw — unit-amplitude tone peaks near this in an unscaled FFT.
    window_sum: f32,
}

impl FftEngine {
    pub fn new() -> Self {
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);
        let scratch = vec![Complex32::new(0.0, 0.0); fft.get_inplace_scratch_len()];
        // Blackman–Harris — lower sidelobes, cleaner waterfall edges
        let window: Vec<f32> = (0..FFT_SIZE)
            .map(|i| {
                let x = std::f32::consts::PI * i as f32 / (FFT_SIZE - 1) as f32;
                0.35875 - 0.48829 * (2.0 * x).cos() + 0.14128 * (4.0 * x).cos()
                    - 0.01168 * (6.0 * x).cos()
            })
            .collect();
        let window_sum = window.iter().sum::<f32>().max(1.0);
        Self {
            iq_buf: vec![Complex32::new(0.0, 0.0); FFT_SIZE],
            fft,
            scratch,
            window,
            window_sum,
        }
    }

    pub fn reset(&mut self) {
        for v in self.iq_buf.iter_mut() {
            *v = Complex32::new(0.0, 0.0);
        }
    }

    pub fn compute_db_into(&mut self, iq_bytes: &[u8], out: &mut [f32]) {
        let buf = &mut self.iq_buf;
        for v in buf.iter_mut() {
            *v = Complex32::new(0.0, 0.0);
        }
        let pairs = iq_bytes.len() / 2;
        let n = pairs.min(FFT_SIZE);
        for i in 0..n {
            let i_val = (iq_bytes[i * 2] as f32 - 127.5) / 127.5;
            let q_val = (iq_bytes[i * 2 + 1] as f32 - 127.5) / 127.5;
            buf[i] = Complex32::new(i_val * self.window[i], q_val * self.window[i]);
        }

        self.fft
            .process_with_scratch(buf, &mut self.scratch);

        // Absolute dBFS: full-scale complex tone (|z|=1) → ~0 dBFS at its bin.
        let fs_power = (self.window_sum * self.window_sum).max(1.0);
        let half = FFT_SIZE / 2;

        for i in 0..half {
            out[i] = 10.0 * (buf[half + i].norm_sqr() / fs_power).max(1e-20).log10();
        }
        for i in 0..half {
            out[half + i] = 10.0 * (buf[i].norm_sqr() / fs_power).max(1e-20).log10();
        }
    }
}

pub struct SpectrumState {
    bins_db: Vec<f32>,
    display_bins: Vec<f32>,
    center_hz: AtomicU32,
    sample_rate_hz: AtomicU32,
    frame_id: std::sync::atomic::AtomicU64,
    fft: FftEngine,
}

impl SpectrumState {
    pub fn new() -> Self {
        Self {
            bins_db: vec![-160.0; FFT_SIZE],
            display_bins: vec![-160.0; DISPLAY_BINS],
            center_hz: AtomicU32::new(0),
            sample_rate_hz: AtomicU32::new(0),
            frame_id: std::sync::atomic::AtomicU64::new(0),
            fft: FftEngine::new(),
        }
    }

    pub fn set_tune(&self, center_hz: u32, sample_rate_hz: u32) {
        self.center_hz.store(center_hz, Ordering::Relaxed);
        self.sample_rate_hz.store(sample_rate_hz, Ordering::Relaxed);
    }

    /// Drop stale waterfall/spectrum after a retune so graphics match the new frequency quickly.
    pub fn flush_display(&mut self) {
        for b in &mut self.bins_db {
            *b = -160.0;
        }
        for b in &mut self.display_bins {
            *b = -160.0;
        }
        self.fft.reset();
        self.frame_id.fetch_add(1, Ordering::Relaxed);
    }

    pub fn update(&mut self, iq_bytes: &[u8]) {
        if iq_bytes.len() < FFT_SIZE * 2 {
            return;
        }
        self.fft.compute_db_into(iq_bytes, &mut self.bins_db);
        // Light temporal average keeps noise texture while sharpening persistent signals
        for (dst, src) in self.display_bins.iter_mut().zip(self.bins_db.iter()) {
            *dst = *dst * 0.35 + *src * 0.65;
        }
        self.frame_id.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot_display(
        &self,
        level: f32,
        level_l: f32,
        level_r: f32,
        signal_open: bool,
        error: Option<String>,
        connected: bool,
        iq_drops: u32,
        audio_drops: u32,
        audio_underruns: u32,
    ) -> SpectrumView {
        let (bins_b64, bin_count) = encode_bins_f32(&self.display_bins);
        SpectrumView {
            bins_b64,
            bin_count,
            center_hz: self.center_hz.load(Ordering::Relaxed),
            sample_rate_hz: self.sample_rate_hz.load(Ordering::Relaxed),
            frame_id: self.frame_id.load(Ordering::Relaxed),
            level,
            level_l,
            level_r,
            signal_open,
            error,
            connected,
            iq_drops,
            audio_drops,
            audio_underruns,
        }
    }
}

fn default_true() -> bool {
    true
}

fn encode_bins_f32(bins: &[f32]) -> (String, u32) {
    let bytes = unsafe {
        std::slice::from_raw_parts(bins.as_ptr() as *const u8, bins.len() * std::mem::size_of::<f32>())
    };
    (STANDARD.encode(bytes), bins.len() as u32)
}

pub struct SpectrumEmitter {
    last_frame_id: u64,
    last_emit: std::time::Instant,
    min_interval: std::time::Duration,
}

impl SpectrumEmitter {
    pub fn new() -> Self {
        Self {
            last_frame_id: 0,
            last_emit: std::time::Instant::now()
                .checked_sub(std::time::Duration::from_secs(1))
                .unwrap_or_else(std::time::Instant::now),
            // Slightly faster waterfall line rate for more temporal detail
            min_interval: std::time::Duration::from_millis(33),
        }
    }

    pub fn take_frame(
        &mut self,
        state: &SpectrumState,
        level: f32,
        level_l: f32,
        level_r: f32,
        signal_open: bool,
        error: Option<String>,
        connected: bool,
        iq_drops: u32,
        audio_drops: u32,
        audio_underruns: u32,
    ) -> Option<SpectrumView> {
        let frame_id = state.frame_id.load(Ordering::Relaxed);
        if frame_id == self.last_frame_id || self.last_emit.elapsed() < self.min_interval {
            return None;
        }
        self.last_frame_id = frame_id;
        self.last_emit = std::time::Instant::now();
        Some(state.snapshot_display(
            level,
            level_l,
            level_r,
            signal_open,
            error,
            connected,
            iq_drops,
            audio_drops,
            audio_underruns,
        ))
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SpectrumView {
    pub bins_b64: String,
    pub bin_count: u32,
    pub center_hz: u32,
    pub sample_rate_hz: u32,
    pub frame_id: u64,
    pub level: f32,
    pub level_l: f32,
    pub level_r: f32,
    /// Squelch gate open, or true when squelch is off (audio pass-through).
    #[serde(default = "default_true")]
    pub signal_open: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub connected: bool,
    #[serde(default)]
    pub iq_drops: u32,
    #[serde(default)]
    pub audio_drops: u32,
    #[serde(default)]
    pub audio_underruns: u32,
}
