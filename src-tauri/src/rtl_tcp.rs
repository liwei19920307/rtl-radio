//! rtl_tcp protocol client (osmocom).

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

fn tune_tcp_socket(stream: &TcpStream) -> Result<(), String> {
    let sock = socket2::SockRef::from(stream);
    sock.set_recv_buffer_size(512 * 1024)
        .map_err(|e| e.to_string())?;
    sock.set_send_buffer_size(256 * 1024)
        .map_err(|e| e.to_string())?;
    Ok(())
}

const CMD_SET_FREQ: u8 = 0x01;
const CMD_SET_SAMPLE_RATE: u8 = 0x02;
const CMD_SET_GAIN_MODE: u8 = 0x03;
const CMD_SET_GAIN: u8 = 0x04;
const CMD_SET_FREQ_CORRECTION: u8 = 0x05;

const GAIN_AUTO: u32 = 0;
const GAIN_MANUAL: u32 = 1;

const RTL_TCP_MAGIC: u32 = 0x5254_4C30; // "RTL0"

#[derive(Debug, Clone)]
pub struct DongleInfo {
    pub magic: u32,
    pub tuner_type: u32,
    pub gain_count: u32,
}

pub struct RtlTcpClient {
    host: String,
    port: u16,
    stream: Option<TcpStream>,
    running: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
    pub info: Option<DongleInfo>,
}

impl RtlTcpClient {
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        Self {
            host: host.into(),
            port,
            stream: None,
            running: Arc::new(AtomicBool::new(false)),
            reader: None,
            info: None,
        }
    }

    pub fn connect(&mut self) -> Result<DongleInfo, String> {
        self.close();
        let addr = format!("{}:{}", self.host, self.port);
        let mut stream = TcpStream::connect(&addr).map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(8)))
            .map_err(|e| e.to_string())?;
        stream.set_nodelay(true).map_err(|e| e.to_string())?;
        tune_tcp_socket(&stream)?;

        let mut header = [0u8; 12];
        read_exact(&mut stream, &mut header)?;
        let magic = u32::from_be_bytes(header[0..4].try_into().unwrap());
        if magic != RTL_TCP_MAGIC {
            return Err(format!("bad rtl_tcp magic: {magic:#x}"));
        }
        let info = DongleInfo {
            magic,
            tuner_type: u32::from_be_bytes(header[4..8].try_into().unwrap()),
            gain_count: u32::from_be_bytes(header[8..12].try_into().unwrap()),
        };

        self.stream = Some(stream);
        self.info = Some(info.clone());
        Ok(info)
    }

    pub fn close(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.reader.take() {
            let _ = handle.join();
        }
        self.stream = None;
        self.info = None;
    }

    fn send(&mut self, cmd: u8, param: u32) -> Result<(), String> {
        let stream = self.stream.as_mut().ok_or("not connected")?;
        let pkt = [cmd, (param >> 24) as u8, (param >> 16) as u8, (param >> 8) as u8, param as u8];
        stream.write_all(&pkt).map_err(|e| e.to_string())
    }

    pub fn set_freq(&mut self, hz: u32) -> Result<(), String> {
        self.send(CMD_SET_FREQ, hz)
    }

    pub fn set_sample_rate(&mut self, hz: u32) -> Result<(), String> {
        self.send(CMD_SET_SAMPLE_RATE, hz)
    }

    pub fn set_manual_gain(&mut self, tenths_db: u32) -> Result<(), String> {
        self.send(CMD_SET_GAIN_MODE, GAIN_MANUAL)?;
        self.send(CMD_SET_GAIN, tenths_db)
    }

    pub fn set_auto_gain(&mut self) -> Result<(), String> {
        self.send(CMD_SET_GAIN_MODE, GAIN_AUTO)
    }

    pub fn set_ppm(&mut self, ppm: i32) -> Result<(), String> {
        self.send(CMD_SET_FREQ_CORRECTION, ppm as u32)
    }

    pub fn start_iq_stream<F, G>(
        &mut self,
        mut acquire_buf: G,
        on_chunk: F,
        disconnect: Arc<AtomicBool>,
    ) -> Result<(), String>
    where
        F: Fn(Vec<u8>) + Send + 'static,
        G: FnMut() -> Vec<u8> + Send + 'static,
    {
        let stream = self.stream.as_mut().ok_or("not connected")?.try_clone().map_err(|e| e.to_string())?;
        self.running.store(true, Ordering::SeqCst);
        disconnect.store(false, Ordering::SeqCst);
        let running = Arc::clone(&self.running);
        let handle = thread::spawn(move || {
            let mut stream = stream;
            let _ = stream.set_read_timeout(None);
            const CHUNK: usize = 64 * 1024;
            while running.load(Ordering::SeqCst) {
                let mut buf = acquire_buf();
                if buf.len() != CHUNK {
                    buf.resize(CHUNK, 0);
                }
                match read_exact(&mut stream, &mut buf) {
                    Ok(()) => on_chunk(buf),
                    Err(_) => {
                        disconnect.store(true, Ordering::SeqCst);
                        break;
                    }
                }
            }
        });
        self.reader = Some(handle);
        Ok(())
    }

    pub fn stop_iq_stream(&mut self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

fn read_exact(stream: &mut TcpStream, buf: &mut [u8]) -> Result<(), String> {
    let mut offset = 0;
    while offset < buf.len() {
        let n = stream.read(&mut buf[offset..]).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("rtl_tcp connection closed".into());
        }
        offset += n;
    }
    Ok(())
}
