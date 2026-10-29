use axum::body::Bytes;
use phonebook_core::{ChunkPlan, STREAM_CHUNK_SIZE};
use std::io::{self, Write};
use tokio::sync::{mpsc, oneshot};

pub(super) struct StreamWriter {
    sender: mpsc::Sender<Result<Bytes, io::Error>>,
    buffer: Vec<u8>,
    ready: Option<oneshot::Sender<()>>,
}

impl StreamWriter {
    pub fn new(sender: mpsc::Sender<Result<Bytes, io::Error>>, ready: oneshot::Sender<()>) -> Self {
        Self {
            sender,
            buffer: Vec::with_capacity(STREAM_CHUNK_SIZE),
            ready: Some(ready),
        }
    }

    fn announce(&mut self) -> io::Result<()> {
        if let Some(ready) = self.ready.take() {
            ready.send(()).map_err(|_| {
                io::Error::new(io::ErrorKind::BrokenPipe, "Export request disconnected")
            })?;
        }
        Ok(())
    }
}

impl Write for StreamWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.announce()?;
        let length = bytes.len();
        let mut remaining = bytes;
        while !remaining.is_empty() {
            let plan = ChunkPlan::new(self.buffer.len(), remaining.len())
                .ok_or_else(|| io::Error::other("Invalid export buffer state"))?;
            self.buffer.extend_from_slice(&remaining[..plan.take()]);
            remaining = &remaining[plan.take()..];
            if plan.flush() {
                self.flush()?;
            }
        }
        Ok(length)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.announce()?;
        if self.buffer.is_empty() {
            return Ok(());
        }
        let bytes = std::mem::replace(&mut self.buffer, Vec::with_capacity(STREAM_CHUNK_SIZE));
        self.sender
            .blocking_send(Ok(Bytes::from(bytes)))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "Export receiver disconnected"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn exports_obey_chunk_bounds_and_stop_when_the_receiver_disconnects() {
        let (sender, mut receiver) = mpsc::channel(2);
        let bytes = vec![b'x'; STREAM_CHUNK_SIZE * 3 + 7];
        let expected = bytes.clone();
        let (ready, started) = oneshot::channel();
        let writer = tokio::task::spawn_blocking(move || {
            let mut writer = StreamWriter::new(sender, ready);
            writer.write_all(&bytes)?;
            writer.flush()
        });
        started.await.unwrap();
        let mut received = Vec::new();
        while let Some(bytes) = receiver.recv().await {
            let bytes = bytes.unwrap();
            assert!(bytes.len() <= STREAM_CHUNK_SIZE);
            received.extend_from_slice(&bytes);
        }
        writer.await.unwrap().unwrap();
        assert_eq!(received, expected);
        let (sender, receiver) = mpsc::channel(2);
        let (ready, started) = oneshot::channel();
        drop(receiver);
        let failed = tokio::task::spawn_blocking(move || {
            StreamWriter::new(sender, ready).write_all(&vec![0; STREAM_CHUNK_SIZE])
        });
        started.await.unwrap();
        let failed = failed.await.unwrap().unwrap_err();
        assert_eq!(failed.kind(), io::ErrorKind::BrokenPipe);
    }
}
