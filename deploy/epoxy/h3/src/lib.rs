//! HTTP/3 for stomp: a QUIC connection (quinn) carrying HTTP/3 (h3), whose
//! datagrams travel over a channel the host hands in, a wisp UDP stream from
//! epoxy's `connect_udp`. The host (stomp's Http3Transport) decides when to
//! use it; this module only connects and runs requests.

use std::{
	cell::RefCell,
	sync::{atomic::Ordering, Arc},
	time::Duration,
};

use async_compression::futures::bufread::{BrotliDecoder, GzipDecoder};
use bytes::{Buf, Bytes};
use futures_util::{
	future::{select, Either},
	io::{AsyncRead, AsyncReadExt},
	stream, StreamExt, TryStreamExt,
};
use http::{HeaderName, HeaderValue, Method, Request, Uri};
use js_sys::{Array, Object, Reflect, Uint8Array};
use quinn::{
	crypto::rustls::QuicClientConfig, ClientConfig, Endpoint, EndpointConfig, MtuDiscoveryConfig,
	TransportConfig, VarInt,
};
use rustls::{crypto::ring as provider, RootCertStore};
use send_wrapper::SendWrapper;
use wasm_bindgen::{prelude::*, JsCast};
use wasm_bindgen_futures::{spawn_local, JsFuture};
use web_sys::{ReadableStream, ReadableStreamDefaultReader, WritableStream};

mod runtime;
mod socket;

use runtime::BrowserRuntime;
use socket::{ChannelSocket, Stats, PEER};

/// Chrome's HTTP/3 SETTINGS_MAX_FIELD_SECTION_SIZE (and the HTTP/2 header
/// list limit epoxy is patched to): 256 KiB.
const MAX_FIELD_SECTION_SIZE: u64 = 256 * 1024;
const CHUNK: usize = 64 * 1024;

fn js_error(message: impl std::fmt::Display) -> JsValue {
	js_sys::Error::new(&message.to_string()).into()
}

thread_local! {
	static CONFIG: RefCell<Option<(String, ClientConfig)>> = const { RefCell::new(None) };
}

/// Chrome's QUIC transport parameters, as far as quinn exposes them
/// (net/quic/quic_context.h and quiche's QuicConfig defaults).
fn transport_config() -> TransportConfig {
	let mut t = TransportConfig::default();
	// max_idle_timeout 30 s
	t.max_idle_timeout(Some(VarInt::from_u32(30_000).into()));
	// initial_max_stream_data_{bidi_local,bidi_remote,uni} 6 MiB
	t.stream_receive_window(VarInt::from_u32(6 * 1024 * 1024));
	// initial_max_data 15 MiB
	t.receive_window(VarInt::from_u32(15 * 1024 * 1024));
	t.send_window(15 * 1024 * 1024);
	// initial_max_streams_bidi 100, initial_max_streams_uni 103
	t.max_concurrent_bidi_streams(VarInt::from_u32(100));
	t.max_concurrent_uni_streams(VarInt::from_u32(103));
	// max_datagram_frame_size: Chrome advertises HTTP datagrams
	t.datagram_receive_buffer_size(Some(65536));
	// Chrome's first flight is 1250 bytes; path MTU discovery up to 1450
	t.initial_mtu(1250);
	let mut mtu = MtuDiscoveryConfig::default();
	mtu.upper_bound(1450);
	t.mtu_discovery_config(Some(mtu));
	t.initial_rtt(Duration::from_millis(100));
	t
}

fn client_config(pem: &str) -> Result<ClientConfig, JsValue> {
	if let Some(config) = CONFIG.with(|c| {
		c.borrow()
			.as_ref()
			.filter(|(p, _)| p == pem)
			.map(|(_, config)| config.clone())
	}) {
		// one config per realm keeps rustls's session cache, so a second
		// connection to a server resumes (1-RTT; early data stays off)
		return Ok(config);
	}
	let mut roots = RootCertStore::empty();
	roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
	if !pem.is_empty() {
		for cert in rustls_pemfile::certs(&mut pem.as_bytes()) {
			roots.add(cert.map_err(js_error)?).map_err(js_error)?;
		}
	}
	let mut provider = provider::default_provider();
	// Chrome's TLS 1.3 order: AES-128-GCM, AES-256-GCM, ChaCha20-Poly1305
	provider.cipher_suites = vec![
		provider::cipher_suite::TLS13_AES_128_GCM_SHA256,
		provider::cipher_suite::TLS13_AES_256_GCM_SHA384,
		provider::cipher_suite::TLS13_CHACHA20_POLY1305_SHA256,
	];
	let mut tls = rustls::ClientConfig::builder_with_provider(Arc::new(provider))
		.with_protocol_versions(&[&rustls::version::TLS13])
		.map_err(js_error)?
		.with_root_certificates(roots)
		.with_no_client_auth();
	tls.alpn_protocols = vec![b"h3".to_vec()];
	// 0-RTT replays a request the server cannot tell from the original; a
	// proxy does not know which requests are safe to replay, so never
	tls.enable_early_data = false;
	let quic = QuicClientConfig::try_from(tls).map_err(js_error)?;
	let mut config = ClientConfig::new(Arc::new(quic));
	config.transport_config(Arc::new(transport_config()));
	CONFIG.with(|c| *c.borrow_mut() = Some((pem.to_string(), config.clone())));
	Ok(config)
}

type SendRequest = h3::client::SendRequest<h3_quinn::OpenStreams, Bytes>;

/// One HTTP/3 connection to one origin; requests multiplex over it.
#[wasm_bindgen]
pub struct H3Connection {
	send: SendRequest,
	quic: quinn::Connection,
	endpoint: Endpoint,
	socket: Arc<ChannelSocket>,
	stats: Arc<Stats>,
	closed: std::rc::Rc<std::cell::Cell<bool>>,
	handshake_ms: f64,
}

/// Connect to `host` (the TLS server name) over the datagram channel.
/// `options`: `{ pem?: string, timeoutMs?: number }`: extra trusted roots
/// (tests) and how long the handshake may take (10 s).
#[wasm_bindgen]
pub async fn connect(
	host: String,
	readable: ReadableStream,
	writable: WritableStream,
	options: JsValue,
) -> Result<H3Connection, JsValue> {
	let pem = Reflect::get(&options, &"pem".into())
		.ok()
		.and_then(|v| v.as_string())
		.unwrap_or_default();
	let timeout_ms = Reflect::get(&options, &"timeoutMs".into())
		.ok()
		.and_then(|v| v.as_f64())
		.map(|v| v.clamp(1.0, 120_000.0) as u32)
		.unwrap_or(10_000);
	let config = client_config(&pem)?;
	let start = web_time::Instant::now();

	let (closed_tx, closed_rx) = futures_channel::oneshot::channel::<()>();
	let socket = Arc::new(ChannelSocket::new(readable, writable, move || {
		let _ = closed_tx.send(());
	})?);
	let stats = socket.stats.clone();
	let mut endpoint_config = EndpointConfig::default();
	// max_udp_payload_size, as Chrome sends it
	endpoint_config
		.max_udp_payload_size(1472)
		.map_err(js_error)?;
	let endpoint = Endpoint::new_with_abstract_socket(
		endpoint_config,
		None,
		socket.clone(),
		Arc::new(BrowserRuntime),
	)
	.map_err(js_error)?;
	let connecting = endpoint
		.connect_with(config, PEER, &host)
		.map_err(js_error)?;

	// a channel that ends before the handshake does (the wisp server refused
	// UDP, or the remote is unreachable) fails now, not at the idle timeout
	// and one that never answers (UDP dropped somewhere past the wisp
	// server) fails at `timeoutMs`
	let timeout = gloo_timers::future::TimeoutFuture::new(timeout_ms);
	let quic = match select(Box::pin(connecting), select(closed_rx, timeout)).await {
		Either::Left((Ok(conn), _)) => conn,
		Either::Left((Err(e), _)) => {
			endpoint.close(VarInt::from_u32(0), b"");
			socket.close();
			return Err(js_error(format!("quic handshake: {e}")));
		}
		Either::Right((Either::Left(_), _)) => {
			endpoint.close(VarInt::from_u32(0), b"");
			return Err(js_error("quic handshake: datagram channel closed"));
		}
		Either::Right((Either::Right(_), _)) => {
			endpoint.close(VarInt::from_u32(0), b"");
			socket.close();
			return Err(js_error("quic handshake: timed out"));
		}
	};
	let handshake_ms = start.elapsed().as_secs_f64() * 1000.0;

	let (mut driver, send) = h3::client::builder()
		.max_field_section_size(MAX_FIELD_SECTION_SIZE)
		.send_grease(true)
		// SETTINGS_H3_DATAGRAM 1, as Chrome sends it (RFC 9297)
		.enable_datagram(true)
		.build::<_, _, Bytes>(h3_quinn::Connection::new(quic.clone()))
		.await
		.map_err(|e| js_error(format!("h3 setup: {e}")))?;

	let closed = std::rc::Rc::new(std::cell::Cell::new(false));
	{
		let closed = closed.clone();
		let socket = socket.clone();
		spawn_local(async move {
			let _ = driver.wait_idle().await;
			closed.set(true);
			// let the CONNECTION_CLOSE leave before the channel goes
			gloo_timers::future::TimeoutFuture::new(100).await;
			socket.close();
		});
	}

	Ok(H3Connection {
		send,
		quic,
		endpoint,
		socket,
		stats,
		closed,
		handshake_ms,
	})
}

/// Header values cross as byte strings (one code unit per byte), as epoxy's
/// patched client passes them.
fn byte_string(bytes: &[u8]) -> String {
	bytes.iter().map(|&b| b as char).collect()
}

/// Request headers that are connection-specific and forbidden in HTTP/3
/// (RFC 9114 4.2), or that the URL already carries (`:authority`).
fn skip_request_header(name: &str) -> bool {
	matches!(
		name,
		"host" | "connection" | "keep-alive" | "proxy-connection" | "transfer-encoding" | "upgrade"
	)
}

enum Coding {
	Gzip,
	Brotli,
}

#[wasm_bindgen]
impl H3Connection {
	/// False once the connection closed (idle timeout, GOAWAY, error).
	#[wasm_bindgen(getter)]
	pub fn alive(&self) -> bool {
		!self.closed.get() && self.quic.close_reason().is_none() && !self.socket.closed.load(Ordering::Relaxed)
	}

	#[wasm_bindgen(getter)]
	pub fn handshake_ms(&self) -> f64 {
		self.handshake_ms
	}

	/// The connection's smoothed RTT and datagram counters.
	pub fn stats(&self) -> JsValue {
		let o = Object::new();
		let set = |k: &str, v: f64| {
			let _ = Reflect::set(&o, &k.into(), &v.into());
		};
		set("rttMs", self.quic.rtt().as_secs_f64() * 1000.0);
		set("handshakeMs", self.handshake_ms);
		set("datagramsSent", self.stats.sent.load(Ordering::Relaxed) as f64);
		set("datagramsReceived", self.stats.received.load(Ordering::Relaxed) as f64);
		set("bytesSent", self.stats.sent_bytes.load(Ordering::Relaxed) as f64);
		set("bytesReceived", self.stats.received_bytes.load(Ordering::Relaxed) as f64);
		set("mtu", self.quic.stats().path.current_mtu as f64);
		o.into()
	}

	pub fn close(&self) {
		self.quic.close(VarInt::from_u32(0x100), b""); // H3_NO_ERROR
		self.endpoint.close(VarInt::from_u32(0x100), b"");
		self.closed.set(true);
	}

	/// Run one request. `headers` is `[name, value][]` in the order to send;
	/// `body` is null, a Uint8Array, or a ReadableStream of Uint8Array.
	/// Resolves to `{ status, headers: [name, value][], body: ReadableStream | null }`
	/// once the response head arrives; the body streams after that, decoded
	/// from gzip or br the way epoxy decodes it.
	pub async fn request(
		&self,
		method: String,
		url: String,
		headers: Array,
		body: JsValue,
	) -> Result<JsValue, JsValue> {
		let uri: Uri = url.parse().map_err(js_error)?;
		let method = Method::from_bytes(method.as_bytes()).map_err(js_error)?;
		let mut builder = Request::builder().method(method.clone()).uri(uri);
		let map = builder.headers_mut().ok_or_else(|| js_error("bad request"))?;
		let mut has_encoding = false;
		for entry in headers.iter() {
			let entry: Array = entry.unchecked_into();
			let name = entry.get(0).as_string().unwrap_or_default().to_ascii_lowercase();
			let value = entry.get(1).as_string().unwrap_or_default();
			if skip_request_header(&name) || name.starts_with(':') {
				continue;
			}
			if name == "te" && !value.eq_ignore_ascii_case("trailers") {
				continue;
			}
			has_encoding |= name == "accept-encoding";
			let bytes: Vec<u8> = value.chars().map(|c| c as u32 as u8).collect();
			map.append(
				HeaderName::from_bytes(name.as_bytes()).map_err(js_error)?,
				HeaderValue::from_bytes(&bytes).map_err(js_error)?,
			);
		}
		if !has_encoding {
			// what epoxy asks for, so either transport gets the same bytes
			map.insert(http::header::ACCEPT_ENCODING, HeaderValue::from_static("gzip, br"));
		}
		let req = builder.body(()).map_err(js_error)?;

		let mut send = self.send.clone();
		let stream = send
			.send_request(req)
			.await
			.map_err(|e| js_error(format!("h3 send: {e}")))?;
		let (mut tx, mut rx) = stream.split();

		// the body goes up while the response comes down
		if body.is_null() || body.is_undefined() {
			tx.finish().await.map_err(|e| js_error(format!("h3 finish: {e}")))?;
		} else if let Some(bytes) = body.dyn_ref::<Uint8Array>() {
			let bytes = Bytes::from(bytes.to_vec());
			if !bytes.is_empty() {
				tx.send_data(bytes).await.map_err(|e| js_error(format!("h3 body: {e}")))?;
			}
			tx.finish().await.map_err(|e| js_error(format!("h3 finish: {e}")))?;
		} else {
			let readable: ReadableStream = body.unchecked_into();
			let reader: ReadableStreamDefaultReader = readable.get_reader().unchecked_into();
			let reader = SendWrapper::new(reader);
			spawn_local(async move {
				loop {
					let Ok(chunk) = JsFuture::from(reader.read()).await else {
						tx.stop_stream(h3::error::Code::H3_REQUEST_CANCELLED);
						return;
					};
					if Reflect::get(&chunk, &"done".into()).map(|v| v.is_truthy()).unwrap_or(true) {
						break;
					}
					let value = Reflect::get(&chunk, &"value".into()).unwrap_or(JsValue::UNDEFINED);
					let bytes = if let Some(view) = value.dyn_ref::<Uint8Array>() {
						view.to_vec()
					} else if value.is_instance_of::<js_sys::ArrayBuffer>() {
						Uint8Array::new(&value).to_vec()
					} else {
						continue;
					};
					if bytes.is_empty() {
						continue;
					}
					if tx.send_data(Bytes::from(bytes)).await.is_err() {
						let _ = reader.cancel();
						return;
					}
				}
				let _ = tx.finish().await;
			});
		}

		let response = rx
			.recv_response()
			.await
			.map_err(|e| js_error(format!("h3 response: {e}")))?;
		let status = response.status().as_u16();

		let out_headers = Array::new();
		let mut coding = None;
		for (name, value) in response.headers() {
			if name == http::header::CONTENT_ENCODING {
				coding = match value.as_bytes() {
					b"gzip" => Some(Coding::Gzip),
					b"br" => Some(Coding::Brotli),
					_ => None,
				};
			}
			out_headers.push(&Array::of2(&name.as_str().into(), &byte_string(value.as_bytes()).into()));
		}

		let null_body = method == Method::HEAD || matches!(status, 101 | 103 | 204 | 205 | 304);
		let body: JsValue = if null_body {
			JsValue::NULL
		} else {
			let raw = stream::unfold(rx, |mut rx| async move {
				match rx.recv_data().await {
					Ok(Some(mut buf)) => {
						let bytes = buf.copy_to_bytes(buf.remaining());
						Some((Ok::<_, std::io::Error>(bytes), rx))
					}
					Ok(None) => None,
					Err(e) => Some((Err(std::io::Error::other(e.to_string())), rx)),
				}
			})
			.boxed_local();
			let reader = raw.into_async_read();
			let decoded: std::pin::Pin<Box<dyn AsyncRead>> = match coding {
				Some(Coding::Gzip) => Box::pin(GzipDecoder::new(reader)),
				Some(Coding::Brotli) => Box::pin(BrotliDecoder::new(reader)),
				None => Box::pin(reader),
			};
			let chunks = stream::unfold(decoded, |mut r| async move {
				let mut buf = vec![0u8; CHUNK];
				match r.read(&mut buf).await {
					Ok(0) => None,
					Ok(n) => {
						buf.truncate(n);
						Some((Ok(Uint8Array::from(&buf[..]).into()), r))
					}
					Err(e) => Some((Err(js_error(e)), r)),
				}
			});
			wasm_streams::ReadableStream::from_stream(chunks).into_raw().into()
		};

		let result = Object::new();
		Reflect::set(&result, &"status".into(), &status.into())?;
		Reflect::set(&result, &"headers".into(), &out_headers)?;
		Reflect::set(&result, &"body".into(), &body)?;
		Ok(result.into())
	}
}
