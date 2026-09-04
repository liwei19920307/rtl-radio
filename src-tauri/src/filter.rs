//! Biquad low-pass filters for RF channel selection (sharper than one-pole).

const PI: f32 = std::f32::consts::PI;

/// Direct-form II transposed biquad (RBJ cookbook).
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn new() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    fn set_lowpass(&mut self, sample_rate: f32, cutoff_hz: f32, q: f32) {
        let fc = cutoff_hz.clamp(20.0, sample_rate * 0.45);
        let w0 = 2.0 * PI * fc / sample_rate;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = sin_w0 / (2.0 * q.max(0.1));
        let b0 = (1.0 - cos_w0) / 2.0;
        let b1 = 1.0 - cos_w0;
        let b2 = (1.0 - cos_w0) / 2.0;
        let a0 = 1.0 + alpha;
        self.b0 = b0 / a0;
        self.b1 = b1 / a0;
        self.b2 = b2 / a0;
        self.a1 = (-2.0 * cos_w0) / a0;
        self.a2 = (1.0 - alpha) / a0;
    }

    fn set_notch(&mut self, sample_rate: f32, freq_hz: f32, q: f32) {
        let fc = freq_hz.clamp(20.0, sample_rate * 0.45);
        let w0 = 2.0 * PI * fc / sample_rate;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = sin_w0 / (2.0 * q.max(0.5));
        let a0 = 1.0 + alpha;
        self.b0 = 1.0 / a0;
        self.b1 = (-2.0 * cos_w0) / a0;
        self.b2 = 1.0 / a0;
        self.a1 = (-2.0 * cos_w0) / a0;
        self.a2 = (1.0 - alpha) / a0;
    }

    fn set_highpass(&mut self, sample_rate: f32, cutoff_hz: f32, q: f32) {
        let fc = cutoff_hz.clamp(10.0, sample_rate * 0.45);
        let w0 = 2.0 * PI * fc / sample_rate;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = sin_w0 / (2.0 * q.max(0.1));
        let b0 = (1.0 + cos_w0) / 2.0;
        let b1 = -(1.0 + cos_w0);
        let b2 = (1.0 + cos_w0) / 2.0;
        let a0 = 1.0 + alpha;
        self.b0 = b0 / a0;
        self.b1 = b1 / a0;
        self.b2 = b2 / a0;
        self.a1 = (-2.0 * cos_w0) / a0;
        self.a2 = (1.0 - alpha) / a0;
    }

    fn run(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }

    fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

/// 4th-order Butterworth low-pass (two biquad stages).
pub struct LowPass {
    stages: [Biquad; 2],
}

impl LowPass {
    pub fn new() -> Self {
        Self {
            stages: [Biquad::new(), Biquad::new()],
        }
    }

    pub fn set_cutoff(&mut self, sample_rate: f32, cutoff_hz: f32) {
        // Butterworth 4th-order Q factors
        self.stages[0].set_lowpass(sample_rate, cutoff_hz, 0.541_196);
        self.stages[1].set_lowpass(sample_rate, cutoff_hz, 1.306_563);
    }

    pub fn run(&mut self, x: f32) -> f32 {
        let mid = self.stages[0].run(x);
        self.stages[1].run(mid)
    }

    pub fn reset(&mut self) {
        for s in &mut self.stages {
            s.reset();
        }
    }
}

/// 4th-order Butterworth high-pass (CTCSS / rumble).
pub struct HighPass {
    stages: [Biquad; 2],
}

impl HighPass {
    pub fn new() -> Self {
        Self {
            stages: [Biquad::new(), Biquad::new()],
        }
    }

    pub fn set_cutoff(&mut self, sample_rate: f32, cutoff_hz: f32) {
        self.stages[0].set_highpass(sample_rate, cutoff_hz, 0.541_196);
        self.stages[1].set_highpass(sample_rate, cutoff_hz, 1.306_563);
    }

    pub fn run(&mut self, x: f32) -> f32 {
        let mid = self.stages[0].run(x);
        self.stages[1].run(mid)
    }

    pub fn reset(&mut self) {
        for s in &mut self.stages {
            s.reset();
        }
    }
}

/// Cascaded notches (e.g. 19 kHz FM pilot leftover).
pub struct Notch {
    stages: [Biquad; 2],
}

impl Notch {
    pub fn new() -> Self {
        Self {
            stages: [Biquad::new(), Biquad::new()],
        }
    }

    pub fn set(&mut self, sample_rate: f32, freq_hz: f32, q: f32) {
        let q = q.max(0.5);
        self.stages[0].set_notch(sample_rate, freq_hz, q);
        self.stages[1].set_notch(sample_rate, freq_hz, q * 1.15);
    }

    pub fn run(&mut self, x: f32) -> f32 {
        let mid = self.stages[0].run(x);
        self.stages[1].run(mid)
    }

    pub fn reset(&mut self) {
        for s in &mut self.stages {
            s.reset();
        }
    }
}

/// Complex baseband channel filter — same LPF on I and Q.
pub struct IqLowPass {
    i: LowPass,
    q: LowPass,
}

impl IqLowPass {
    pub fn new() -> Self {
        Self {
            i: LowPass::new(),
            q: LowPass::new(),
        }
    }

    pub fn set_cutoff(&mut self, sample_rate: f32, cutoff_hz: f32) {
        self.i.set_cutoff(sample_rate, cutoff_hz);
        self.q.set_cutoff(sample_rate, cutoff_hz);
    }

    pub fn run(&mut self, i_in: f32, q_in: f32) -> (f32, f32) {
        (self.i.run(i_in), self.q.run(q_in))
    }

    pub fn reset(&mut self) {
        self.i.reset();
        self.q.reset();
    }
}

/// Single-pole for de-emphasis / gentle audio smoothing.
pub struct OnePole {
    alpha: f32,
    y: f32,
}

impl OnePole {
    pub fn new(sample_rate: f32, cutoff_hz: f32) -> Self {
        let mut s = Self { alpha: 1.0, y: 0.0 };
        s.set_cutoff(sample_rate, cutoff_hz);
        s
    }

    pub fn run(&mut self, x: f32) -> f32 {
        self.y += self.alpha * (x - self.y);
        self.y
    }

    pub fn reset(&mut self) {
        self.y = 0.0;
    }

    pub fn set_cutoff(&mut self, sample_rate: f32, cutoff_hz: f32) {
        let fc = cutoff_hz.max(1.0);
        let rc = 1.0 / (2.0 * PI * fc);
        let dt = 1.0 / sample_rate;
        self.alpha = dt / (rc + dt);
    }
}
