//! Stereo audio frame from demodulators.

#[derive(Debug, Default)]
pub struct StereoAudio {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

impl StereoAudio {
    pub fn mono(samples: Vec<f32>) -> Self {
        let right = samples.clone();
        Self {
            left: samples,
            right,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.left.is_empty()
    }

    pub fn peaks(&self) -> (f32, f32) {
        let pl = self
            .left
            .iter()
            .map(|v| v.abs())
            .fold(0.0f32, |a, b| a.max(b));
        let pr = self
            .right
            .iter()
            .map(|v| v.abs())
            .fold(0.0f32, |a, b| a.max(b));
        (pl, pr)
    }

    pub fn mono_mix_samples(&self) -> Vec<f32> {
        self.left
            .iter()
            .zip(&self.right)
            .map(|(l, r)| (l + r) * 0.5)
            .collect()
    }
}
