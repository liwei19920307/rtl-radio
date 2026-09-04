//! SSB (USB / LSB) demodulator — phasing method.

use crate::filter::{HighPass, IqLowPass, LowPass};
use crate::squelch::mix_if_power;

pub const IQ_RATE: f32 = 192_000.0;
pub const AUDIO_RATE: f32 = 48_000.0;
const DECIM: usize = (IQ_RATE as usize) / (AUDIO_RATE as usize);
const AUDIO_HP_HZ: f32 = 250.0;

pub struct SsbDemod {
    channel: IqLowPass,
    q_delay: [f32; 2],
    side: f32,
    audio_lp: LowPass,
    audio_hp: HighPass,
    if_power: f32,
}

impl SsbDemod {
    pub fn new_usb() -> Self {
        Self::new(1.0)
    }

    pub fn new_lsb() -> Self {
        Self::new(-1.0)
    }

    fn new(side: f32) -> Self {
        let mut s = Self {
            channel: IqLowPass::new(),
            q_delay: [0.0; 2],
            side,
            audio_lp: LowPass::new(),
            audio_hp: HighPass::new(),
            if_power: 0.0,
        };
        s.set_bandwidth_hz(2_700.0);
        s
    }

    pub fn set_bandwidth_hz(&mut self, bandwidth_hz: f32) {
        let bw = bandwidth_hz.max(200.0);
        let half_bw = (bw * 0.5).clamp(100.0, IQ_RATE * 0.49);
        self.channel.set_cutoff(IQ_RATE, half_bw);
        let audio_cut = (bw * 0.5).clamp(400.0, 8_000.0);
        self.audio_lp.set_cutoff(AUDIO_RATE, audio_cut);
        self.audio_hp.set_cutoff(AUDIO_RATE, AUDIO_HP_HZ);
        self.channel.reset();
        self.audio_lp.reset();
        self.audio_hp.reset();
    }

    pub fn reset(&mut self) {
        self.channel.reset();
        self.q_delay = [0.0; 2];
        self.audio_lp.reset();
        self.audio_hp.reset();
        self.if_power = 0.0;
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
            let i_raw = (chunk[0] as f32 - 127.5) / 127.5;
            let q_raw = (chunk[1] as f32 - 127.5) / 127.5;
            let (i, q) = self.channel.run(i_raw, q_raw);
            mag2_sum += i * i + q * q;
            mag_n += 1;
            let qh = self.q_delay[0];
            self.q_delay[0] = self.q_delay[1];
            self.q_delay[1] = q;
            let ssb = i - self.side * qh;
            if idx % DECIM == 0 {
                raw.push(self.audio_lp.run(self.audio_hp.run(ssb)));
            }
        }
        mix_if_power(&mut self.if_power, mag2_sum, mag_n);

        normalize_peak(&mut raw);
        raw
    }
}

fn normalize_peak(audio: &mut [f32]) {
    if let Some(peak) = audio.iter().map(|v| v.abs()).max_by(|a, b| a.partial_cmp(b).unwrap()) {
        if peak > 0.95 {
            let scale = 0.9 / peak;
            for s in audio {
                *s *= scale;
            }
        }
    }
}
