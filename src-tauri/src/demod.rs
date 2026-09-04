use crate::am::{self, AmDemod};
use crate::audio::StereoAudio;
use crate::nfm::{self, NfmDemod};
use crate::ssb::{self, SsbDemod};
use crate::wbfm::{self, WbfmDemod};

pub enum Demodulator {
    Wbfm(WbfmDemod),
    Am(AmDemod),
    Nfm(NfmDemod),
    Usb(SsbDemod),
    Lsb(SsbDemod),
    Dsb(AmDemod),
}

impl Demodulator {
    pub fn from_mode(mode: &str) -> Self {
        match mode.to_ascii_lowercase().as_str() {
            "am" => Self::Am(AmDemod::new()),
            "dsb" => Self::Dsb(AmDemod::new()),
            "nfm" => Self::Nfm(NfmDemod::new()),
            "usb" => Self::Usb(SsbDemod::new_usb()),
            "lsb" => Self::Lsb(SsbDemod::new_lsb()),
            _ => Self::Wbfm(WbfmDemod::new(wbfm::IQ_RATE)),
        }
    }

    pub fn iq_rate(&self) -> f32 {
        match self {
            Self::Wbfm(d) => d.iq_rate(),
            Self::Am(_) | Self::Dsb(_) => am::IQ_RATE,
            Self::Nfm(_) => nfm::IQ_RATE,
            Self::Usb(_) | Self::Lsb(_) => ssb::IQ_RATE,
        }
    }

    pub fn audio_rate(&self) -> f32 {
        match self {
            Self::Wbfm(_) => wbfm::AUDIO_RATE,
            Self::Am(_) | Self::Dsb(_) => am::AUDIO_RATE,
            Self::Nfm(_) => nfm::AUDIO_RATE,
            Self::Usb(_) | Self::Lsb(_) => ssb::AUDIO_RATE,
        }
    }

    pub fn process(&mut self, iq_bytes: &[u8]) -> StereoAudio {
        let mut left = Vec::new();
        let mut right = Vec::new();
        self.append_stereo(iq_bytes, &mut left, &mut right);
        StereoAudio { left, right }
    }

    pub fn append_stereo(&mut self, iq_bytes: &[u8], left: &mut Vec<f32>, right: &mut Vec<f32>) {
        match self {
            Self::Wbfm(d) => d.append_stereo(iq_bytes, left, right),
            Self::Am(d) | Self::Dsb(d) => {
                let mono = d.process(iq_bytes);
                left.extend_from_slice(&mono);
                right.extend_from_slice(&mono);
            }
            Self::Nfm(d) => {
                let mono = d.process(iq_bytes);
                left.extend_from_slice(&mono);
                right.extend_from_slice(&mono);
            }
            Self::Usb(d) | Self::Lsb(d) => {
                let mono = d.process(iq_bytes);
                left.extend_from_slice(&mono);
                right.extend_from_slice(&mono);
            }
        }
    }

    pub fn set_bandwidth_hz(&mut self, bandwidth_hz: f32) {
        match self {
            Self::Wbfm(d) => d.set_bandwidth_hz(bandwidth_hz),
            Self::Am(d) | Self::Dsb(d) => d.set_bandwidth_hz(bandwidth_hz),
            Self::Nfm(d) => d.set_bandwidth_hz(bandwidth_hz),
            Self::Usb(d) | Self::Lsb(d) => d.set_bandwidth_hz(bandwidth_hz),
        }
    }

    pub fn set_deemphasis(&mut self, enabled: bool) {
        match self {
            Self::Wbfm(d) => d.set_deemphasis(enabled),
            Self::Nfm(d) => d.set_deemphasis(enabled),
            _ => {}
        }
    }

    pub fn set_stereo(&mut self, enabled: bool) {
        if let Self::Wbfm(d) = self {
            d.set_stereo(enabled);
        }
    }

    pub fn reset(&mut self) {
        match self {
            Self::Wbfm(d) => d.reset(),
            Self::Am(d) | Self::Dsb(d) => d.reset(),
            Self::Nfm(d) => d.reset(),
            Self::Usb(d) | Self::Lsb(d) => d.reset(),
        }
    }

    pub fn if_power(&self) -> f32 {
        match self {
            Self::Wbfm(d) => d.if_power(),
            Self::Am(d) | Self::Dsb(d) => d.if_power(),
            Self::Nfm(d) => d.if_power(),
            Self::Usb(d) | Self::Lsb(d) => d.if_power(),
        }
    }

    /// Pre-AGC FM discriminator hiss metric (NFM). 0 if unused.
    pub fn disc_noise(&self) -> f32 {
        match self {
            Self::Nfm(d) => d.disc_noise(),
            _ => 0.0,
        }
    }
}
