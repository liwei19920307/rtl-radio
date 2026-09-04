//! AM demodulator for aviation / airband (118–137 MHz).

use crate::filter::{HighPass, IqLowPass, LowPass};
use crate::squelch::mix_if_power;
use num_complex::Complex32;

pub const IQ_RATE: f32 = 2_048_000.0;
pub const AUDIO_RATE: f32 = 48_000.0;
const DECIM: usize = (IQ_RATE as usize) / (AUDIO_RATE as usize);
const AUDIO_HP_HZ: f32 = 300.0;

pub struct AmDemod {
    channel: IqLowPass,
    audio_lp: LowPass,
    audio_hp: HighPass,
    dc: f32,
    bandwidth_hz: f32,
    if_power: f32,
}

impl AmDemod {
    pub fn new() -> Self {
        let mut s = Self {
            channel: IqLowPass::new(),
            audio_lp: LowPass::new(),
            audio_hp: HighPass::new(),
            dc: 0.0,
            bandwidth_hz: 8_000.0,
            if_power: 0.0,
        };
        s.set_bandwidth_hz(8_000.0);
        s
    }

    pub fn reset(&mut self) {
        self.channel.reset();
        self.audio_lp.reset();
        self.audio_hp.reset();
        self.dc = 0.0;
        self.if_power = 0.0;
    }

    pub fn set_bandwidth_hz(&mut self, bandwidth_hz: f32) {
        self.bandwidth_hz = bandwidth_hz.max(200.0);
        let half_bw = (self.bandwidth_hz * 0.5).clamp(100.0, IQ_RATE * 0.49);
        self.channel.set_cutoff(IQ_RATE, half_bw);
        let audio_cut = (self.bandwidth_hz * 0.5).clamp(400.0, 8_000.0);
        self.audio_lp.set_cutoff(AUDIO_RATE, audio_cut);
        self.audio_hp.set_cutoff(AUDIO_RATE, AUDIO_HP_HZ);
        self.channel.reset();
        self.audio_lp.reset();
        self.audio_hp.reset();
    }

    pub fn if_power(&self) -> f32 {
        self.if_power
    }

    pub fn process(&mut self, iq_bytes: &[u8]) -> Vec<f32> {
        if iq_bytes.len() < 4 {
            return Vec::new();
        }

        let mut raw = Vec::with_capacity(iq_bytes.len() / 2 / DECIM + 1);
        let mut mag2_sum = 0.0f32;
        let mut mag_n = 0u32;

        for (idx, chunk) in iq_bytes.chunks_exact(2).enumerate() {
            let i = (chunk[0] as f32 - 127.5) / 127.5;
            let q = (chunk[1] as f32 - 127.5) / 127.5;
            let (fi, fq) = self.channel.run(i, q);
            mag2_sum += fi * fi + fq * fq;
            mag_n += 1;
            let mag = Complex32::new(fi, fq).norm();
            self.dc = self.dc * 0.9995 + mag * 0.0005;
            let ac = mag - self.dc;

            if idx % DECIM == 0 {
                raw.push(self.audio_lp.run(self.audio_hp.run(ac)));
            }
        }
        mix_if_power(&mut self.if_power, mag2_sum, mag_n);

        if raw.is_empty() {
            return raw;
        }

        if let Some(peak) = raw
            .iter()
            .map(|v| v.abs())
            .max_by(|a, b| a.partial_cmp(b).unwrap())
        {
            if peak > 0.95 {
                let scale = 0.85 / peak;
                for s in &mut raw {
                    *s *= scale;
                }
            }
        }

        raw
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn narrow_bandwidth_attenuates_more_than_wide() {
        let chunk: Vec<u8> = (0..4096)
            .flat_map(|i| {
                let t = i as f32 / IQ_RATE;
                let m = (2.0 * std::f32::consts::PI * 3000.0 * t).sin() * 80.0 + 127.5;
                [m.clamp(0.0, 255.0) as u8, 127]
            })
            .collect();

        let mut narrow = AmDemod::new();
        narrow.set_bandwidth_hz(2_000.0);
        let mut wide = AmDemod::new();
        wide.set_bandwidth_hz(16_000.0);

        let n_peak = narrow.process(&chunk).iter().map(|v| v.abs()).fold(0.0f32, f32::max);
        let w_peak = wide.process(&chunk).iter().map(|v| v.abs()).fold(0.0f32, f32::max);
        assert!(
            w_peak > n_peak * 1.5,
            "wide={w_peak} narrow={n_peak} — bandwidth should change level"
        );
    }
}
