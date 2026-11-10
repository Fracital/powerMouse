//! A quinn socket over a datagram channel the host supplies: a
//! `ReadableStream<Uint8Array>` of received datagrams and a
//! `WritableStream<Uint8Array>` that sends one datagram per chunk (what
//! epoxy's `connect_udp` returns for a wisp UDP stream). The channel is
//! already bound to one remote, so the destination of every transmit is
//! ignored and every datagram is reported as coming from `PEER`.

use std::{
	fmt,
	io::{self, IoSliceMut},
	net::{Ipv4Addr, SocketAddr, SocketAddrV4},
	pin::Pin,
	sync::{
		atomic::{AtomicBool, AtomicU64, Ordering},
		Arc, Mutex,
	},
	task::{Context, Poll},
};

use futures_channel::mpsc;
use futures_util::StreamExt;
use js_sys::Uint8Array;
use quinn::{
	udp::{RecvMeta, Transmit},
	AsyncUdpSocket, UdpPoller,
};
use send_wrapper::SendWrapper;
use wasm_bindgen::{prelude::*, JsCast};
use wasm_bindgen_futures::{spawn_local, JsFuture};
use web_sys::{ReadableStream, ReadableStreamDefaultReader, WritableStream, WritableStreamDefaultWriter};

/// The address quinn is told the server has. Nothing is ever sent to it: the
/// wisp stream carries every datagram to the one remote it was opened for.
pub const PEER: SocketAddr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(192, 0, 2, 1), 443));
const LOCAL: SocketAddr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0));

/// Counters the host can read back (how many datagrams crossed the channel).
#[derive(Default, Debug)]
pub struct Stats {
	pub sent: AtomicU64,
	pub received: AtomicU64,
	pub sent_bytes: AtomicU64,
	pub received_bytes: AtomicU64,
}

pub struct ChannelSocket {
	writer: SendWrapper<WritableStreamDefaultWriter>,
	rx: Mutex<mpsc::UnboundedReceiver<Vec<u8>>>,
	/// set once the read side ended: the remote closed the stream (a wisp
	/// server that refuses UDP closes it at once) or the channel errored
	pub closed: Arc<AtomicBool>,
	pub stats: Arc<Stats>,
	write_failed: Arc<AtomicBool>,
}

impl fmt::Debug for ChannelSocket {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("ChannelSocket").finish_non_exhaustive()
	}
}

impl ChannelSocket {
	/// `on_close` runs once when the read side ends.
	pub fn new(
		readable: ReadableStream,
		writable: WritableStream,
		on_close: impl FnOnce() + 'static,
	) -> Result<Self, JsValue> {
		let reader: ReadableStreamDefaultReader = readable.get_reader().unchecked_into();
		let writer = writable.get_writer()?;
		let (tx, rx) = mpsc::unbounded::<Vec<u8>>();
		let closed = Arc::new(AtomicBool::new(false));
		let stats = Arc::new(Stats::default());
		{
			let closed = closed.clone();
			let stats = stats.clone();
			spawn_local(async move {
				loop {
					let Ok(chunk) = JsFuture::from(reader.read()).await else {
						break;
					};
					let done = js_sys::Reflect::get(&chunk, &"done".into())
						.map(|v| v.is_truthy())
						.unwrap_or(true);
					if done {
						break;
					}
					let Ok(value) = js_sys::Reflect::get(&chunk, &"value".into()) else {
						break;
					};
					let bytes = if let Some(view) = value.dyn_ref::<Uint8Array>() {
						view.to_vec()
					} else if value.is_instance_of::<js_sys::ArrayBuffer>() {
						Uint8Array::new(&value).to_vec()
					} else {
						continue;
					};
					stats.received.fetch_add(1, Ordering::Relaxed);
					stats.received_bytes.fetch_add(bytes.len() as u64, Ordering::Relaxed);
					if tx.unbounded_send(bytes).is_err() {
						break;
					}
				}
				closed.store(true, Ordering::Relaxed);
				tx.close_channel();
				on_close();
			});
		}
		Ok(Self {
			writer: SendWrapper::new(writer),
			rx: Mutex::new(rx),
			closed,
			stats,
			write_failed: Arc::new(AtomicBool::new(false)),
		})
	}

	pub fn close(&self) {
		let _ = self.writer.close();
	}
}

#[derive(Debug)]
struct AlwaysWritable;

impl UdpPoller for AlwaysWritable {
	fn poll_writable(self: Pin<&mut Self>, _cx: &mut Context) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}
}

impl AsyncUdpSocket for ChannelSocket {
	fn create_io_poller(self: Arc<Self>) -> Pin<Box<dyn UdpPoller>> {
		Box::pin(AlwaysWritable)
	}

	fn try_send(&self, transmit: &Transmit) -> io::Result<()> {
		if self.write_failed.load(Ordering::Relaxed) {
			return Err(io::Error::new(io::ErrorKind::BrokenPipe, "datagram channel closed"));
		}
		// one datagram per write; segment_size is never set because
		// max_transmit_segments is 1
		let chunk = Uint8Array::from(transmit.contents);
		self.stats.sent.fetch_add(1, Ordering::Relaxed);
		self.stats.sent_bytes.fetch_add(transmit.contents.len() as u64, Ordering::Relaxed);
		let failed = self.write_failed.clone();
		// a datagram is fire and forget; a rejected write means the stream is
		// gone, and the next send reports it
		let promise = self.writer.write_with_chunk(&chunk);
		spawn_local(async move {
			if JsFuture::from(promise).await.is_err() {
				failed.store(true, Ordering::Relaxed);
			}
		});
		Ok(())
	}

	fn poll_recv(
		&self,
		cx: &mut Context,
		bufs: &mut [IoSliceMut<'_>],
		meta: &mut [RecvMeta],
	) -> Poll<io::Result<usize>> {
		let mut rx = self.rx.lock().unwrap();
		match rx.poll_next_unpin(cx) {
			Poll::Ready(Some(datagram)) => {
				let len = datagram.len().min(bufs[0].len());
				bufs[0][..len].copy_from_slice(&datagram[..len]);
				let mut m = RecvMeta::default();
				m.addr = PEER;
				m.len = len;
				m.stride = len;
				meta[0] = m;
				Poll::Ready(Ok(1))
			}
			// the endpoint keeps polling a closed socket; the connection is
			// failed from the close signal instead, so stay pending here
			Poll::Ready(None) => Poll::Pending,
			Poll::Pending => Poll::Pending,
		}
	}

	fn local_addr(&self) -> io::Result<SocketAddr> {
		Ok(LOCAL)
	}

	// a datagram crosses wisp whole; the wisp server's socket is what may
	// fragment, and path MTU discovery finds out
	fn may_fragment(&self) -> bool {
		false
	}
}
