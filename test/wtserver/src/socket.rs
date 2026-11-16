//! quinn's UDP socket as the Node host drives it: the host hands in each
//! datagram it receives with the address it came from (`Server::recv`), and
//! the module sends by calling the host's `send(bytes, address, port)`. One
//! socket serves every client, so each datagram keeps its peer address.

use std::{
	fmt,
	io::{self, IoSliceMut},
	net::SocketAddr,
	pin::Pin,
	sync::Mutex,
	task::{Context, Poll},
};

use futures_channel::mpsc;
use futures_util::StreamExt;
use js_sys::{Function, Uint8Array};
use quinn::{
	udp::{RecvMeta, Transmit},
	AsyncUdpSocket, UdpPoller,
};
use send_wrapper::SendWrapper;
use wasm_bindgen::JsValue;

pub type Inbox = mpsc::UnboundedSender<(Vec<u8>, SocketAddr)>;

pub struct HostSocket {
	local: SocketAddr,
	send: SendWrapper<Function>,
	rx: Mutex<mpsc::UnboundedReceiver<(Vec<u8>, SocketAddr)>>,
}

impl fmt::Debug for HostSocket {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("HostSocket").finish_non_exhaustive()
	}
}

impl HostSocket {
	pub fn new(local: SocketAddr, send: Function) -> (Self, Inbox) {
		let (tx, rx) = mpsc::unbounded();
		(
			Self {
				local,
				send: SendWrapper::new(send),
				rx: Mutex::new(rx),
			},
			tx,
		)
	}
}

#[derive(Debug)]
struct AlwaysWritable;

impl UdpPoller for AlwaysWritable {
	fn poll_writable(self: Pin<&mut Self>, _cx: &mut Context) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}
}

impl AsyncUdpSocket for HostSocket {
	fn create_io_poller(self: std::sync::Arc<Self>) -> Pin<Box<dyn UdpPoller>> {
		Box::pin(AlwaysWritable)
	}

	fn try_send(&self, transmit: &Transmit) -> io::Result<()> {
		// one datagram per call: max_transmit_segments is 1, so quinn never
		// hands over a GSO batch
		let bytes = Uint8Array::from(transmit.contents);
		let ip = JsValue::from_str(&transmit.destination.ip().to_string());
		let port = JsValue::from_f64(transmit.destination.port() as f64);
		self.send
			.call3(&JsValue::NULL, &bytes, &ip, &port)
			.map(|_| ())
			.map_err(|_| io::Error::other("send failed"))
	}

	fn poll_recv(
		&self,
		cx: &mut Context,
		bufs: &mut [IoSliceMut<'_>],
		meta: &mut [RecvMeta],
	) -> Poll<io::Result<usize>> {
		let mut rx = self.rx.lock().unwrap();
		match rx.poll_next_unpin(cx) {
			Poll::Ready(Some((datagram, addr))) => {
				let len = datagram.len().min(bufs[0].len());
				bufs[0][..len].copy_from_slice(&datagram[..len]);
				let mut m = RecvMeta::default();
				m.addr = addr;
				m.len = len;
				m.stride = len;
				meta[0] = m;
				Poll::Ready(Ok(1))
			}
			// closed: the server is shutting down; the endpoint is closed
			// from Server::close
			Poll::Ready(None) | Poll::Pending => Poll::Pending,
		}
	}

	fn local_addr(&self) -> io::Result<SocketAddr> {
		Ok(self.local)
	}

	fn may_fragment(&self) -> bool {
		false
	}
}
