//! The WebTransport fixture server: QUIC (quinn, rustls on ring), HTTP/3 and
//! WebTransport draft 02 (wt.rs), run by test/wtserver.mjs under Node with a
//! node:dgram socket. The host passes in the certificate and key it made,
//! every datagram it receives with its source, and two functions: `send`
//! for each datagram out and `emit` for each event (one JSON object).

mod bridge;
mod h3;
mod json;
mod runtime;
mod socket;
mod tables;
mod wt;

use std::{cell::RefCell, net::SocketAddr, sync::Arc};

use js_sys::Function;
use quinn::{crypto::rustls::QuicServerConfig, Endpoint, EndpointConfig, ServerConfig, TransportConfig, VarInt};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;

thread_local! {
	static EMIT: RefCell<Option<Function>> = const { RefCell::new(None) };
}

pub(crate) fn emit(line: String) {
	EMIT.with(|e| {
		if let Some(f) = &*e.borrow() {
			let _ = f.call1(&JsValue::NULL, &JsValue::from_str(&line));
		}
	});
}

fn fail(e: impl ToString) -> JsError {
	JsError::new(&e.to_string())
}

#[wasm_bindgen]
pub struct Server {
	inbox: socket::Inbox,
	endpoint: Endpoint,
}

#[wasm_bindgen]
impl Server {
	/// `cert`: the leaf's DER; `key`: its PKCS#8 DER; `address`/`port`: the
	/// socket the host bound; `send(bytes, address, port)`; `emit(json)`;
	/// `stream_window`: the flow control window of each stream instead of
	/// the Go fixture's 64 KiB (and twice it for the connection), as a
	/// server that grants a client a long path's worth.
	#[wasm_bindgen(constructor)]
	pub fn new(
		cert: Vec<u8>,
		key: Vec<u8>,
		address: &str,
		port: u16,
		send: Function,
		emit: Function,
		stream_window: Option<u32>,
	) -> Result<Server, JsError> {
		EMIT.with(|e| *e.borrow_mut() = Some(emit));
		let local = SocketAddr::new(address.parse().map_err(fail)?, port);
		let (sock, inbox) = socket::HostSocket::new(local, send);

		let provider = Arc::new(rustls::crypto::ring::default_provider());
		let mut tls = rustls::ServerConfig::builder_with_provider(provider)
			.with_protocol_versions(&[&rustls::version::TLS13])
			.map_err(fail)?
			.with_no_client_auth()
			.with_single_cert(
				vec![CertificateDer::from(cert)],
				PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key)),
			)
			.map_err(fail)?;
		tls.alpn_protocols = vec![b"h3".to_vec()];

		// the Go fixture's limits: 64 KiB per stream, 1 MiB per connection
		// (fixed windows), datagrams on, quic-go's 100 streams each way
		let mut transport = TransportConfig::default();
		let (stream_window, window) = match stream_window {
			Some(n) => (n, n.saturating_mul(2)),
			None => (64 * 1024, 1024 * 1024),
		};
		transport
			.stream_receive_window(VarInt::from_u32(stream_window))
			.receive_window(VarInt::from_u32(window))
			// what the server may have unacknowledged toward a client in all:
			// quinn's 10 MB default would bind before Chrome's windows do on
			// a long path (test/wisp-wt.mjs delayMs)
			.send_window(64 * 1024 * 1024)
			.max_concurrent_bidi_streams(VarInt::from_u32(100))
			.max_concurrent_uni_streams(VarInt::from_u32(100))
			.datagram_receive_buffer_size(Some(1024 * 1024));
		let mut config = ServerConfig::with_crypto(Arc::new(QuicServerConfig::try_from(tls).map_err(fail)?));
		config.transport_config(Arc::new(transport));

		// 4-byte connection ids, as quic-go's: Chrome's datagrams.maxDatagramSize
		// (156) counts the id its packets carry
		let mut endpoint_config = EndpointConfig::default();
		endpoint_config.cid_generator(|| Box::new(quinn_proto::RandomConnectionIdGenerator::new(4)));
		let endpoint = Endpoint::new_with_abstract_socket(
			endpoint_config,
			Some(config),
			Arc::new(sock),
			Arc::new(runtime::NodeRuntime),
		)
		.map_err(fail)?;
		let accepting = endpoint.clone();
		spawn_local(async move {
			while let Some(incoming) = accepting.accept().await {
				spawn_local(async move {
					if let Ok(connecting) = incoming.accept() {
						if let Ok(conn) = connecting.await {
							wt::serve(conn).await;
						}
					}
				});
			}
		});
		Ok(Server { inbox, endpoint })
	}

	/// a datagram the host's socket received
	pub fn recv(&self, data: &[u8], address: &str, port: u16) {
		if let Ok(ip) = address.parse() {
			let _ = self.inbox.unbounded_send((data.to_vec(), SocketAddr::new(ip, port)));
		}
	}

	/// the host's function for /bridge sessions: `bridge(kind, id, value)`
	/// (src/bridge.rs)
	pub fn set_bridge(&self, f: Function) {
		bridge::set(f);
	}

	/// writes `data` on a /bridge stream (in order with the earlier writes)
	pub fn bridge_write(&self, stream: u32, data: &[u8]) {
		bridge::command(stream, bridge::Cmd::Write(data.to_vec()));
	}

	/// finishes a /bridge stream once what was written went out
	pub fn bridge_finish(&self, stream: u32) {
		bridge::command(stream, bridge::Cmd::Finish);
	}

	/// resets a /bridge stream with WebTransport code `code`
	pub fn bridge_reset(&self, stream: u32, code: u32) {
		bridge::command(stream, bridge::Cmd::Reset(code));
	}

	/// sends a datagram on a /bridge session; false when it was not sent
	pub fn bridge_datagram(&self, session: u32, data: &[u8]) -> bool {
		bridge::datagram(session, data)
	}

	/// what a datagram of a /bridge session can carry, -1 for none
	pub fn bridge_max_datagram(&self, session: u32) -> i32 {
		bridge::max_datagram(session)
	}

	/// opens a server bidirectional stream on a /bridge session: its
	/// handle, -1 when the session is gone
	pub fn bridge_open_bidi(&self, session: u32) -> f64 {
		bridge::open_bidi(session) as f64
	}

	/// closes a /bridge session with its capsule and FIN
	pub fn bridge_close(&self, session: u32, code: u32, reason: &str) {
		bridge::close(session, code, reason.to_string());
	}

	/// closes every connection (CONNECTION_CLOSE, code 0)
	pub fn close(&self) {
		self.endpoint.close(VarInt::from_u32(0), b"");
	}
}
