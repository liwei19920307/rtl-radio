//! Channel squelch with short hang + soft mute.
//!
//! - FM (NFM/WBFM): noise squelch like SDR# (slider 0…100).
//!   Uses discriminator/audio hiss vs a slow peak hold — empty ≈ peak → closed;
//!   carrier quiets the hiss → open. Absolute scale no longer matters.
//! - AM/SSB: IF power vs slow noise floor.

pub struct SquelchGate {
    floor: f32,
    /// Smoothed hiss metric.
    noise: f32,
    /// Slow peak of hiss (empty-channel reference).
    noise_peak: f32,
    warmup: u8,
    open: bool,
    hang: u8,
    gain: f32,
    last_thresh: f32,
}

const HANG: u8 = 6;
const WARMUP: u8 = 6;

impl SquelchGate {
    pub fn new() -> Self {
        Self {
            floor: 0.0,
            noise: 0.0,
            noise_peak: 0.0,
            warmup: 0,
            open: false,
            hang: 0,
            gain: 0.0,
            last_thresh: -1.0,
        }
    }

    pub fn reset(&mut self) {
        *self = Self::new();
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    /// `thresh` is 0…1 from a 0…100 UI slider (SDR# style).
    pub fn apply(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        if_power: f32,
        disc_noise: f32,
        thresh: f32,
        noise_mode: bool,
    ) {
        if left.is_empty() {
            return;
        }

        let thresh_moved = (thresh - self.last_thresh).abs() > 1e-5;
        if thresh_moved {
            self.hang = 0;
            self.last_thresh = thresh;
        }

        let want_open = if noise_mode {
            self.decide_noise(left, right, disc_noise, thresh)
        } else {
            self.decide_if_power(if_power, thresh)
        };

        if want_open {
            self.open = true;
            self.hang = HANG;
        } else if self.hang > 0 && !thresh_moved {
            self.hang -= 1;
            self.open = true;
        } else {
            self.open = false;
            self.hang = 0;
        }

        let target = if self.open { 1.0 } else { 0.0 };
        let alpha = if thresh_moved { 0.9 } else { 0.6 };
        self.gain += alpha * (target - self.gain);
        if self.gain < 0.002 && !self.open {
            left.fill(0.0);
            right.fill(0.0);
            self.gain = 0.0;
        } else if self.gain < 0.995 {
            let g = self.gain;
            for x in left.iter_mut() {
                *x *= g;
            }
            for x in right.iter_mut() {
                *x *= g;
            }
        }
    }

    /// FM noise squelch: norm≈1 on empty hiss, drops with carrier.
    fn decide_noise(
        &mut self,
        left: &[f32],
        right: &[f32],
        disc_noise: f32,
        thresh: f32,
    ) -> bool {
        let raw = if disc_noise > 1e-12 {
            disc_noise
        } else {
            hf_energy(left).max(hf_energy(right))
        };

        if self.warmup < WARMUP {
            self.noise = if self.noise < 1e-12 {
                raw
            } else {
                0.5 * self.noise + 0.5 * raw
            };
            self.noise_peak = self.noise_peak.max(self.noise);
            self.warmup += 1;
            // Stay closed during warmup so empty channels mute immediately.
            return false;
        }

        self.noise = 0.7 * self.noise + 0.3 * raw;

        // Peak-hold empty-channel hiss; slow decay so a brief quiet doesn't collapse ref.
        if self.noise > self.noise_peak {
            self.noise_peak = self.noise;
        } else {
            self.noise_peak *= 0.9992;
            self.noise_peak = self.noise_peak.max(self.noise * 1.05);
        }

        let peak = self.noise_peak.max(1e-12);
        let norm = (self.noise / peak).clamp(0.0, 1.5);

        // SDR# 0…100: 0 ≈ always open, 100 ≈ need almost silent (strong carrier).
        // open when normalized hiss falls below this fraction of the peak.
        let t = thresh.clamp(0.0, 1.0);
        let open_below = (1.0 - t * 0.9).clamp(0.08, 1.0);
        let close_above = (open_below + 0.12 + t * 0.08).min(1.05);

        if norm >= close_above {
            false
        } else if norm <= open_below {
            true
        } else {
            self.open
        }
    }

    fn decide_if_power(&mut self, if_power: f32, thresh: f32) -> bool {
        let p = if_power.max(1e-12);
        if self.warmup < WARMUP {
            self.floor = if self.floor < 1e-12 {
                p
            } else {
                0.55 * self.floor + 0.45 * p
            };
            self.warmup += 1;
            return false;
        }

        if !self.open {
            self.floor = 0.82 * self.floor + 0.18 * p;
        } else if p < self.floor * 1.5 {
            self.floor = 0.95 * self.floor + 0.05 * p;
        } else {
            self.floor = 0.985 * self.floor + 0.015 * p;
        }

        let floor = self.floor.max(1e-12);
        let snr = p / floor;
        // 0…100 → need ~1.5× … ~12× above floor
        let open_at = (1.5 + thresh * 10.5).clamp(1.4, 14.0);
        let close_at = open_at * 0.65;

        if snr >= open_at {
            true
        } else if snr <= close_at {
            false
        } else {
            self.open
        }
    }
}

fn hf_energy(samples: &[f32]) -> f32 {
    if samples.len() < 2 {
        return 0.0;
    }
    let mut sum = 0.0f32;
    let mut n = 0u32;
    for w in samples.windows(2) {
        let d = w[1] - w[0];
        sum += d * d;
        n += 1;
    }
    if n == 0 {
        0.0
    } else {
        sum / n as f32
    }
}

pub fn mix_if_power(ema: &mut f32, mag2_sum: f32, n: u32) {
    if n == 0 {
        return;
    }
    let chunk = mag2_sum / n as f32;
    *ema = if *ema < 1e-12 {
        chunk
    } else {
        0.55 * *ema + 0.45 * chunk
    };
}

pub fn mode_uses_noise_squelch(mode: &str) -> bool {
    matches!(mode.to_ascii_lowercase().as_str(), "wbfm" | "nfm")
}
