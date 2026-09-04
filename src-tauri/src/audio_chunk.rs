//! Messages from DSP → audio output.

pub struct AudioChunk {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

pub enum AudioMsg {
    Chunk(AudioChunk),
    /// Clear buffered PCM after mode / tuning changes.
    Flush,
}
