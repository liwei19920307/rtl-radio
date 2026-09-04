//! NFM demodulator for amateur radio & handheld FM (12.5/25 kHz).

use crate::filter::{HighPass, IqLowPass, LowPass, OnePole};
use crate::squelch::mix_if_power;
use num_complex::Complex32;

pub const IQ_RATE: f32 = 2_048_000.0;
pub const AUDIO_RATE: f32 = 48_000.0;
const DECIM: usize = (IQ_RATE as usize) / (AUDIO_RATE as usize);
/// 750 µs ham NFM de-emphasis.
const DEEMPH_HZ: f32 = 212.0;
/// Drop CTCSS/DCS (67–254 Hz) and discriminator rumble.
const CTCSS_HP_HZ: f32 = 300.0;

pub struct NfmDemod {
    channel: IqLowPass,
    disc_lp: OnePole,
    audio_lp: LowPass,
    ctcss_hp: HighPass,
    deemph: OnePole,
    deemph_enabled: bool,
    prev: Complex32,
    if_power: f32,
    /// Pre-decimation discriminator HF energy (FM hiss) — for squelch before AGC/LP.
    disc_noise: f32,
    agc: f32,
}

impl NfmDemod {
    pub fn new() -> Self {
        let mut s = Self {
            channel: IqLowPass::new(),
            disc_lp: OnePole::new(IQ_RATE, 5_000.0),
            audio_lp: LowPass::new(),
            ctcss_hp: HighPass::new(),
            deemph: OnePole::new(AUDIO_RATE, DEEMPH_HZ),
            deemph_enabled: true,
            prev: Complex32::new(0.0, 0.0),
            if_power: 0.0,
            disc_noise: 0.0,
            agc: 6.0,
        };
        s.set_bandwidth_hz(12_500.0);
        s
    }

    pub fn reset(&mut self) {
        self.channel.reset();
        self.disc_lp.reset();
        self.audio_lp.reset();
        self.ctcss_hp.reset();
        self.deemph.reset();
        self.prev = Complex32::new(0.0, 0.0);
        self.if_power = 0.0;
        self.disc_noise = 0.0;
        self.agc = 6.0;
    }

    pub fn set_bandwidth_hz(&mut self, bandwidth_hz: f32) {
        let bw = bandwidth_hz.max(200.0);
        let half_bw = (bw * 0.5).clamp(100.0, IQ_RATE * 0.49);
        self.channel.set_cutoff(IQ_RATE, half_bw);
        self.disc_lp.set_cutoff(IQ_RATE, (bw * 0.4).clamp(1_000.0, 8_000.0));
        let audio_cut = (bw * 0.45).clamp(400.0, 4_000.0);
        self.audio_lp.set_cutoff(AUDIO_RATE, audio_cut);
        self.ctcss_hp.set_cutoff(AUDIO_RATE, CTCSS_HP_HZ);
        self.channel.reset();
        self.disc_lp.reset();
        self.audio_lp.reset();
        self.ctcss_hp.reset();
    }

    pub fn set_deemphasis(&mut self, enabled: bool) {
        self.deemph_enabled = enabled;
    }

    pub fn if_power(&self) -> f32 {
        self.if_power
    }

    pub fn disc_noise(&self) -> f32 {
        self.disc_noise
    }

    pub fn process(&mut self, iq_bytes: &[u8]) -> Vec<f32> {
        if iq_bytes.len() < 4 {
            return Vec::new();
        }

        let mut ph = Vec::with_capacity(iq_bytes.len() / 2);
        let mut prev = self.prev;
        let mut mag2_sum = 0.0f32;
        let mut mag_n = 0u32;

        for chunk in iq_bytes.chunks_exact(2) {
            let i = (chunk[0] as f32 - 127.5) / 127.5;
            let q = (chunk[1] as f32 - 127.5) / 127.5;
            let (fi, fq) = self.channel.run(i, q);
            mag2_sum += fi * fi + fq * fq;
            mag_n += 1;
            let z = Complex32::new(fi, fq);

            if prev != Complex32::new(0.0, 0.0) {
                let prod = z * prev.conj();
                let angle = prod.im.atan2(prod.re);
                ph.push(self.disc_lp.run(angle * 3.2));
            }
            prev = z;
        }
        self.prev = prev;
        mix_if_power(&mut self.if_power, mag2_sum, mag_n);

        if ph.is_empty() {
            return Vec::new();
        }

        // FM hiss: variance of disc with wider stride (less LP correlation).
        let stride = 8usize;
        let mut noise_sum = 0.0f32;
        let mut noise_n = 0u32;
        let mut i = 0usize;
        while i + stride < ph.len() {
            let d = ph[i + stride] - ph[i];
            noise_sum += d * d;
            noise_n += 1;
            i += stride;
        }
        let raw_noise = if noise_n > 0 {
            noise_sum / noise_n as f32
        } else {
            0.0
        };
        self.disc_noise = if self.disc_noise < 1e-12 {
            raw_noise
        } else {
            0.55 * self.disc_noise + 0.45 * raw_noise
        };

        let mut audio: Vec<f32> = ph
            .iter()
            .enumerate()
            .filter_map(|(i, &s)| {
                if i % DECIM != 0 {
                    return None;
                }
                let mut s = self.ctcss_hp.run(s);
                if self.deemph_enabled {
                    s = self.deemph.run(s);
                }
                Some(self.audio_lp.run(s))
            })
            .collect();

        let mut pwr = 0.0f32;
        for s in &audio {
            pwr += *s * *s;
        }
        let rms = (pwr / audio.len().max(1) as f32).sqrt();
        if rms > 1e-5 {
            let desired = (0.22 / rms).clamp(1.5, 18.0);
            self.agc = self.agc * 0.90 + desired * 0.10;
        }
        let g = self.agc;
        for s in &mut audio {
            *s = (*s * g).clamp(-0.92, 0.92);
        }

        audio
    }
}
