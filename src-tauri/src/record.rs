use hound::{SampleFormat, WavSpec, WavWriter};
use parking_lot::Mutex;
use std::fs::File;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;

pub type WavHandle = WavWriter<BufWriter<File>>;

#[derive(Default)]
pub struct AudioRecorder {
    inner: Mutex<Option<WavHandle>>,
    path: Mutex<Option<PathBuf>>,
    channels: AtomicU16,
}

impl AudioRecorder {
    pub fn start(&self, path: PathBuf, sample_rate: u32, channels: u16) -> Result<(), String> {
        let channels = channels.clamp(1, 2);
        let spec = WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let writer = WavWriter::create(&path, spec).map_err(|e| e.to_string())?;
        self.channels.store(channels, Ordering::Relaxed);
        *self.inner.lock() = Some(writer);
        *self.path.lock() = Some(path);
        Ok(())
    }

    pub fn stop(&self) -> Option<PathBuf> {
        let mut guard = self.inner.lock();
        if let Some(writer) = guard.take() {
            let _ = writer.finalize();
        }
        self.path.lock().take()
    }

    pub fn try_write_stereo(&self, left: &[f32], right: &[f32]) {
        let Some(mut guard) = self.inner.try_lock() else {
            return;
        };
        let Some(writer) = guard.as_mut() else {
            return;
        };
        let n = left.len().min(right.len());
        let stereo = self.channels.load(Ordering::Relaxed) >= 2;
        for i in 0..n {
            if stereo {
                let l = (left[i].clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                let r = (right[i].clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                let _ = writer.write_sample(l);
                let _ = writer.write_sample(r);
            } else {
                let v = ((left[i] + right[i]) * 0.5).clamp(-1.0, 1.0);
                let s = (v * i16::MAX as f32) as i16;
                let _ = writer.write_sample(s);
            }
        }
    }

    pub fn write_stereo(&self, left: &[f32], right: &[f32]) {
        let mut guard = self.inner.lock();
        if let Some(writer) = guard.as_mut() {
            let n = left.len().min(right.len());
            let stereo = self.channels.load(Ordering::Relaxed) >= 2;
            for i in 0..n {
                if stereo {
                    let l = (left[i].clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                    let r = (right[i].clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                    let _ = writer.write_sample(l);
                    let _ = writer.write_sample(r);
                } else {
                    let v = ((left[i] + right[i]) * 0.5).clamp(-1.0, 1.0);
                    let s = (v * i16::MAX as f32) as i16;
                    let _ = writer.write_sample(s);
                }
            }
        }
    }

    pub fn write_samples(&self, samples: &[f32]) {
        let mut guard = self.inner.lock();
        if let Some(writer) = guard.as_mut() {
            for &s in samples {
                let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                let _ = writer.write_sample(v);
            }
        }
    }

    pub fn is_recording(&self) -> bool {
        self.inner.lock().is_some()
    }
}

pub fn default_record_path(freq_hz: u32) -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let freq_part = if freq_hz > 0 {
        let mhz = freq_hz as f64 / 1_000_000.0;
        format!("{mhz:.3}MHz-")
    } else {
        String::new()
    };
    PathBuf::from(home)
        .join("Downloads")
        .join(format!("rtl-radio-{freq_part}{ts}.wav"))
}

pub fn shared_recorder() -> Arc<AudioRecorder> {
    Arc::new(AudioRecorder::default())
}
