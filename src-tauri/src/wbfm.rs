//! WBFM broadcast demodulator — fast mono path + optional stereo PLL.

use crate::filter::{IqLowPass, LowPass, Notch, OnePole};
use crate::squelch::mix_if_power;
use num_complex::Complex32;

pub const IQ_RATE: f32 = 2_048_000.0;
pub const AUDIO_RATE: f32 = 48_000.0;
const IQ_DECIM_STEREO: usize = 16;
const IQ_DECIM_MONO: usize = 40;
const AUDIO_RATE_U: u32 = AUDIO_RATE as u32;

struct DcBlock {
    prev_x: f32,
    prev_y: f32,
}

impl DcBlock {
    fn new() -> Self {
        Self {
            prev_x: 0.0,
            prev_y: 0.0,
        }
    }

    fn run(&mut self, x: f32) -> f32 {
        const R: f32 = 0.998;
        let y = x - self.prev_x + R * self.prev_y;
        self.prev_x = x;
        self.prev_y = y;
        y
    }
}

struct PilotPll {
    phase19: f32,
    freq_err: f32,
    sin19: f32,
    cos19: f32,
    pilot_env: f32,
    w19: f32,
}

impl PilotPll {
    fn new(sample_rate: f32) -> Self {
        Self {
            phase19: 0.0,
            freq_err: 0.0,
            sin19: 0.0,
            cos19: 1.0,
            pilot_env: 0.0,
            w19: 2.0 * std::f32::consts::PI * 19_000.0 / sample_rate,
        }
    }

    fn step(&mut self, composite: f32) -> (f32, f32) {
        let err = composite * self.sin19;
        self.freq_err += err * 2.5e-4;
        self.freq_err = self.freq_err.clamp(-0.002, 0.002);
        self.phase19 += self.w19 + self.freq_err;
        if self.phase19 > std::f32::consts::PI {
            self.phase19 -= 2.0 * std::f32::consts::PI;
        } else if self.phase19 < -std::f32::consts::PI {
            self.phase19 += 2.0 * std::f32::consts::PI;
        }
        self.sin19 = self.phase19.sin();
        self.cos19 = self.phase19.cos();

        let pilot = composite * self.cos19;
        self.pilot_env += 0.002 * (pilot.abs() - self.pilot_env);

        let cos38 = (2.0 * self.phase19).cos();
        let lock = ((self.pilot_env - 0.03) * 22.0).clamp(0.0, 1.0);
        (cos38, lock)
    }
}

pub struct WbfmDemod {
    iq_rate: f32,
    stereo_rate_u: u32,
    mono_rate_u: u32,
    channel: IqLowPass,
    composite_lp: OnePole,
    sum_lp: LowPass,
    diff_lp: LowPass,
    audio_lp: LowPass,
    out_lp_l: LowPass,
    out_lp_r: LowPass,
    /// 19 kHz notch at stereo IF (128 kHz) — kills pilot before L+R / L−R mix.
    pilot_notch: Notch,
    notch_l: Notch,
    notch_r: Notch,
    notch_m: Notch,
    deemph_l: OnePole,
    deemph_r: OnePole,
    deemph_m: OnePole,
    dc_l: DcBlock,
    dc_r: DcBlock,
    dc_m: DcBlock,
    pll: PilotPll,
    blend: f32,
    stereo: bool,
    deemph_enabled: bool,
    prev: Complex32,
    out_acc: u32,
    dev_scale: f32,
    if_power: f32,
}

impl WbfmDemod {
    pub fn new(iq_rate: f32) -> Self {
        let stereo_rate = iq_rate / IQ_DECIM_STEREO as f32;
        let mono_rate = iq_rate / IQ_DECIM_MONO as f32;
        let mut s = Self {
            iq_rate,
            stereo_rate_u: stereo_rate as u32,
            mono_rate_u: mono_rate as u32,
            channel: IqLowPass::new(),
            composite_lp: OnePole::new(iq_rate, 75_000.0),
            sum_lp: LowPass::new(),
            diff_lp: LowPass::new(),
            audio_lp: LowPass::new(),
            out_lp_l: LowPass::new(),
            out_lp_r: LowPass::new(),
            pilot_notch: Notch::new(),
            notch_l: Notch::new(),
            notch_r: Notch::new(),
            notch_m: Notch::new(),
            deemph_l: OnePole::new(AUDIO_RATE, 3_180.0),
            deemph_r: OnePole::new(AUDIO_RATE, 3_180.0),
            deemph_m: OnePole::new(AUDIO_RATE, 3_180.0),
            dc_l: DcBlock::new(),
            dc_r: DcBlock::new(),
            dc_m: DcBlock::new(),
            pll: PilotPll::new(stereo_rate),
            blend: 0.0,
            stereo: false,
            deemph_enabled: true,
            prev: Complex32::new(0.0, 0.0),
            out_acc: 0,
            dev_scale: 1.0,
            if_power: 0.0,
        };
        s.set_bandwidth_hz(200_000.0);
        s
    }

    pub fn iq_rate(&self) -> f32 {
        self.iq_rate
    }

    pub fn set_stereo(&mut self, enabled: bool) {
        self.stereo = enabled;
        self.out_acc = 0;
        self.prev = Complex32::new(0.0, 0.0);
        self.blend = 0.0;
        self.pll = PilotPll::new(self.iq_rate / IQ_DECIM_STEREO as f32);
    }

    pub fn reset(&mut self) {
        self.prev = Complex32::new(0.0, 0.0);
        self.out_acc = 0;
        self.blend = 0.0;
        self.pll = PilotPll::new(self.iq_rate / IQ_DECIM_STEREO as f32);
        self.channel.reset();
        self.audio_lp.reset();
        self.sum_lp.reset();
        self.diff_lp.reset();
        self.out_lp_l.reset();
        self.out_lp_r.reset();
        self.pilot_notch.reset();
        self.notch_l.reset();
        self.notch_r.reset();
        self.notch_m.reset();
        self.composite_lp.reset();
        self.deemph_l.reset();
        self.deemph_r.reset();
        self.deemph_m.reset();
        self.dc_l = DcBlock::new();
        self.dc_r = DcBlock::new();
        self.dc_m = DcBlock::new();
        self.if_power = 0.0;
    }

    pub fn set_bandwidth_hz(&mut self, bandwidth_hz: f32) {
        let bw = bandwidth_hz.max(200.0);
        let half_bw = (bw * 0.5).clamp(100.0, self.iq_rate * 0.49);
        self.channel.set_cutoff(self.iq_rate, half_bw);
        let composite_cut = (bw * 0.38).clamp(5_000.0, 85_000.0);
        self.composite_lp.set_cutoff(self.iq_rate, composite_cut);
        let mono_rate = self.iq_rate / IQ_DECIM_MONO as f32;
        let stereo_rate = self.iq_rate / IQ_DECIM_STEREO as f32;
        let audio_cut = 15_000.0;
        self.audio_lp.set_cutoff(mono_rate, audio_cut);
        self.sum_lp.set_cutoff(stereo_rate, audio_cut);
        self.diff_lp.set_cutoff(stereo_rate, audio_cut);
        self.out_lp_l.set_cutoff(AUDIO_RATE, audio_cut);
        self.out_lp_r.set_cutoff(AUDIO_RATE, audio_cut);
        self.pilot_notch.set(stereo_rate, 19_000.0, 5.5);
        self.notch_l.set(AUDIO_RATE, 19_000.0, 6.0);
        self.notch_r.set(AUDIO_RATE, 19_000.0, 6.0);
        self.notch_m.set(AUDIO_RATE, 19_000.0, 6.0);
        self.channel.reset();
        self.audio_lp.reset();
        self.sum_lp.reset();
        self.diff_lp.reset();
        self.out_lp_l.reset();
        self.out_lp_r.reset();
        self.pilot_notch.reset();
        self.notch_l.reset();
        self.notch_r.reset();
        self.notch_m.reset();
    }

    pub fn set_deemphasis(&mut self, enabled: bool) {
        self.deemph_enabled = enabled;
    }

    pub fn if_power(&self) -> f32 {
        self.if_power
    }

    pub fn append_stereo(&mut self, iq_bytes: &[u8], left: &mut Vec<f32>, right: &mut Vec<f32>) {
        if iq_bytes.len() < 4 {
            return;
        }
        if self.stereo {
            self.append_stereo_pll(iq_bytes, left, right);
        } else {
            self.append_mono(iq_bytes, left, right);
        }
    }

    fn append_mono(&mut self, iq_bytes: &[u8], left: &mut Vec<f32>, right: &mut Vec<f32>) {
        let mut prev = self.prev;
        let mut iq_idx = 0usize;
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
                let composite = self.composite_lp.run(prod.im.atan2(prod.re)) * self.dev_scale;
                iq_idx += 1;
                if iq_idx % IQ_DECIM_MONO == 0 {
                    let audio = self.audio_lp.run(composite);
                    self.out_acc += AUDIO_RATE_U;
                    if self.out_acc >= self.mono_rate_u {
                        self.out_acc -= self.mono_rate_u;
                        let mut s = self.dc_m.run(audio);
                        s = self.out_lp_l.run(s);
                        s = self.notch_m.run(s);
                        if self.deemph_enabled {
                            s = self.deemph_m.run(s);
                        }
                        let v = s.clamp(-1.0, 1.0);
                        left.push(v);
                        right.push(v);
                    }
                }
            }
            prev = z;
        }
        self.prev = prev;
        mix_if_power(&mut self.if_power, mag2_sum, mag_n);
    }

    fn append_stereo_pll(&mut self, iq_bytes: &[u8], left: &mut Vec<f32>, right: &mut Vec<f32>) {
        let mut prev = self.prev;
        let mut iq_idx = 0usize;
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
                let composite = self.composite_lp.run(prod.im.atan2(prod.re)) * self.dev_scale;
                iq_idx += 1;
                if iq_idx % IQ_DECIM_STEREO == 0 {
                    let (cos38, lock) = self.pll.step(composite);
                    // Strip 19 kHz before L+R and 38 kHz mix (pilot × 38 kHz aliases back to 19 kHz).
                    let no_pilot = self.pilot_notch.run(composite);
                    let lr_sum = self.sum_lp.run(no_pilot);
                    let target = if lock > 0.55 {
                        ((lock - 0.55) / 0.45).clamp(0.0, 1.0)
                    } else {
                        0.0
                    };
                    self.blend += 0.00025 * (target - self.blend);
                    let lr_diff = self.diff_lp.run(no_pilot * cos38) * self.blend;
                    let mut l = (lr_sum + lr_diff) * 0.5;
                    let mut r = (lr_sum - lr_diff) * 0.5;

                    self.out_acc += AUDIO_RATE_U;
                    if self.out_acc >= self.stereo_rate_u {
                        self.out_acc -= self.stereo_rate_u;
                        l = self.out_lp_l.run(self.dc_l.run(l));
                        r = self.out_lp_r.run(self.dc_r.run(r));
                        l = self.notch_l.run(l);
                        r = self.notch_r.run(r);
                        if self.deemph_enabled {
                            l = self.deemph_l.run(l);
                            r = self.deemph_r.run(r);
                        }
                        left.push(l.clamp(-1.0, 1.0));
                        right.push(r.clamp(-1.0, 1.0));
                    }
                }
            }
            prev = z;
        }
        self.prev = prev;
        mix_if_power(&mut self.if_power, mag2_sum, mag_n);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn bench_chunk(stereo: bool) -> f32 {
        let mut demod = WbfmDemod::new(IQ_RATE);
        demod.set_stereo(stereo);
        let chunk = vec![127u8; 64 * 1024];
        let mut left = Vec::new();
        let mut right = Vec::new();
        let start = Instant::now();
        for _ in 0..80 {
            left.clear();
            right.clear();
            demod.append_stereo(&chunk, &mut left, &mut right);
        }
        start.elapsed().as_secs_f32()
    }

    #[test]
    fn bench_wbfm_mono_faster_than_stereo() {
        let mono_s = bench_chunk(false);
        let stereo_s = bench_chunk(true);
        let mono_ms = mono_s / 80.0 * 1000.0;
        let stereo_ms = stereo_s / 80.0 * 1000.0;
        eprintln!("WBFM 64KB chunk: mono={mono_ms:.2}ms stereo={stereo_ms:.2}ms (budget ~16ms)");
        assert!(mono_ms < 16.0, "mono demod too slow for real-time: {mono_ms:.2}ms");
        eprintln!("stereo/mono ratio {:.2}x", stereo_ms / mono_ms.max(0.001));
    }
}
