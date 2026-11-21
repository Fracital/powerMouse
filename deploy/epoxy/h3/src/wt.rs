//! WebTransport over HTTP/3 (draft 02), as Chrome speaks it: one QUIC
//! connection per session, with Chrome's QUIC and TLS shape (the same
//! transport parameters and ClientHello as `connect`), driven here directly
//! on quinn rather than through h3's client: Chrome's control stream,
//! SETTINGS, extended CONNECT and capsules are written byte for byte, and
//! the server's control, QPACK and WebTransport streams are read here (h3's
//! client refuses streams the server opens). h3's QPACK decoder (with the
//! server's dynamic table) and Huffman coder do the field sections
//! (patches/h3/0005).

use std::{
	cell::{Cell, RefCell},
	collections::{HashMap, VecDeque},
	future::{poll_fn, Future},
	pin::{pin, Pin},
	rc::Rc,
	sync::{Arc, Mutex},
	task::{Context, Poll, Wake, Waker},
};

use bytes::{Buf, Bytes, BytesMut};
use futures_util::{
	future::{select, Either},
	FutureExt,
};
use gloo_timers::future::TimeoutFuture;
use h3::qpack_codec;
use js_sys::{Array, Object, Reflect, Uint8Array};
use quinn::{Endpoint, ReadError, RecvStream, SendStream, VarInt, WriteError};
use wasm_bindgen::{prelude::*, JsCast};
use wasm_bindgen_futures::spawn_local;
use web_sys::{ReadableStream, WritableStream};

use crate::{
	js_error, new_endpoint, quic_client_config, tls_config, transport_config,
	socket::{ChannelSocket, Stats, PEER},
};

// Chrome's WebTransport SETTINGS values (the fetch connection's, but
// MAX_FIELD_SECTION_SIZE 16384)
const QPACK_MAX_TABLE_CAPACITY: u64 = 65536;
const MAX_FIELD_SECTION_SIZE: u64 = 16384;
const QPACK_BLOCKED_STREAMS: u64 = 100;
const SETTING_H3_DATAGRAM: u64 = 0x33;
const SETTING_H3_DATAGRAM_DRAFT04: u64 = 0xffd277;
const SETTING_ENABLE_WEBTRANSPORT: u64 = 0x2b603742;

const FRAME_DATA: u64 = 0x00;
const FRAME_HEADERS: u64 = 0x01;
const FRAME_SETTINGS: u64 = 0x04;
const STREAM_WT_BIDI: u64 = 0x41;
const STREAM_WT_UNI: u64 = 0x54;
const CAPSULE_CLOSE: u64 = 0x2843;

/// The CONNECT stream's id, which every stream of the session names
const SESSION_ID: u64 = 0;

const H3_NO_ERROR: u32 = 0x100;
const H3_STREAM_CREATION_ERROR: u32 = 0x103;
const H3_CLOSED_CRITICAL_STREAM: u32 = 0x104;
const H3_FRAME_UNEXPECTED: u32 = 0x105;
const H3_ID_ERROR: u32 = 0x108;
const H3_CONNECT_ERROR: u32 = 0x10f;
const H3_SETTINGS_ERROR: u32 = 0x109;
const H3_MISSING_SETTINGS: u32 = 0x10a;
const QPACK_ENCODER_STREAM_ERROR: u32 = 0x201;
const WEBTRANSPORT_SESSION_GONE: u64 = 0x170d7b68;

const WT_CODE_FIRST: u64 = 0x52e4a40fa8db;
const WT_CODE_LAST: u64 = 0x52e5ac983162;

/// A WebTransport stream error code in the HTTP/3 space
fn wt_to_h3(n: u32) -> u64 {
	WT_CODE_FIRST + n as u64 + n as u64 / 0x1e
}

/// The WebTransport code an HTTP/3 code carries; 0 for any other code, as
/// Chrome reads it (quiche's kDefaultWebTransportError)
fn h3_to_wt(code: u64) -> u32 {
	if !(WT_CODE_FIRST..=WT_CODE_LAST).contains(&code) || (code - 0x21) % 0x1f == 0 {
		return 0;
	}
	let shifted = code - WT_CODE_FIRST;
	(shifted - shifted / 0x1f) as u32
}

fn random<const N: usize>() -> [u8; N] {
	let mut b = [0u8; N];
	let _ = getrandom02::getrandom(&mut b);
	b
}

fn random_u32() -> u32 {
	u32::from_le_bytes(random())
}

fn random_u64() -> u64 {
	u64::from_le_bytes(random())
}

fn put_varint(out: &mut Vec<u8>, v: u64) {
	if v < 1 << 6 {
		out.push(v as u8);
	} else if v < 1 << 14 {
		out.extend_from_slice(&(v as u16 | 0x4000).to_be_bytes());
	} else if v < 1 << 30 {
		out.extend_from_slice(&(v as u32 | 0x8000_0000).to_be_bytes());
	} else {
		out.extend_from_slice(&(v | 0xc000_0000_0000_0000).to_be_bytes());
	}
}

fn get_varint(buf: &[u8]) -> Option<(u64, usize)> {
	let first = *buf.first()?;
	let len = 1usize << (first >> 6);
	if buf.len() < len {
		return None;
	}
	let v = buf[1..len].iter().fold((first & 0x3f) as u64, |a, &b| (a << 8) | b as u64);
	Some((v, len))
}

/// A GREASE id: 0x1f * N + 0x21 for a random 32-bit N, as Chrome's
fn grease_id() -> u64 {
	0x1f * random_u32() as u64 + 0x21
}

/// Chrome's control stream: its type, SETTINGS in Chrome's order with one
/// GREASE setting last, then one GREASE frame of 0 to 3 random bytes
fn control_stream_bytes() -> Vec<u8> {
	let mut settings = Vec::new();
	for (id, value) in [
		(0x01, QPACK_MAX_TABLE_CAPACITY),
		(0x06, MAX_FIELD_SECTION_SIZE),
		(0x07, QPACK_BLOCKED_STREAMS),
		(SETTING_H3_DATAGRAM, 1),
		(SETTING_H3_DATAGRAM_DRAFT04, 1),
		(SETTING_ENABLE_WEBTRANSPORT, 1),
		(grease_id(), random_u32() as u64),
	] {
		put_varint(&mut settings, id);
		put_varint(&mut settings, value);
	}
	let mut out = vec![0x00];
	put_varint(&mut out, FRAME_SETTINGS);
	put_varint(&mut out, settings.len() as u64);
	out.extend_from_slice(&settings);
	put_varint(&mut out, grease_id());
	let len = (random_u32() % 4) as usize;
	put_varint(&mut out, len as u64);
	out.extend_from_slice(&random::<3>()[..len]);
	out
}

/// QPACK prefixed integer (RFC 9204 section 4.1.1)
fn prefix_int(out: &mut Vec<u8>, bits: u8, flags: u8, mut v: u64) {
	let max = (1u64 << bits) - 1;
	if v < max {
		out.push(flags | v as u8);
		return;
	}
	out.push(flags | max as u8);
	v -= max;
	while v >= 128 {
		out.push((v % 128) as u8 | 0x80);
		v /= 128;
	}
	out.push(v as u8);
}

/// A QPACK string literal, Huffman coded only when that is shorter, as
/// quiche's encoder decides
fn string_literal(out: &mut Vec<u8>, bits: u8, flags: u8, s: &[u8]) {
	let huffman = qpack_codec::huffman_encode(s);
	if huffman.len() < s.len() {
		prefix_int(out, bits, flags | (1 << bits), huffman.len() as u64);
		out.extend_from_slice(&huffman);
	} else {
		prefix_int(out, bits, flags, s.len() as u64);
		out.extend_from_slice(s);
	}
}

/// A field section with the static table and literals only (Chrome uses
/// the server's dynamic table when it offers one; ours never does, as the
/// fetch path's)
fn encode_section(fields: &[(&[u8], &[u8])]) -> Vec<u8> {
	let mut out = vec![0x00, 0x00];
	for &(name, value) in fields {
		if let Some(i) = qpack_codec::static_find(name, value) {
			prefix_int(&mut out, 6, 0xc0, i as u64);
		} else if let Some(i) = qpack_codec::static_find_name(name) {
			prefix_int(&mut out, 4, 0x50, i as u64);
			string_literal(&mut out, 7, 0x00, value);
		} else {
			string_literal(&mut out, 3, 0x20, name);
			string_literal(&mut out, 7, 0x00, value);
		}
	}
	out
}

/// A structured-field string (RFC 8941 section 3.3.3)
fn sf_string(s: &str) -> String {
	let mut out = String::from('"');
	for c in s.chars() {
		if c == '"' || c == '\\' {
			out.push('\\');
		}
		out.push(c);
	}
	out.push('"');
	out
}

/// An sf-string item, parameters ignored
fn parse_sf_string(value: &[u8]) -> Option<String> {
	let v = std::str::from_utf8(value).ok()?.trim_matches(' ');
	let mut chars = v.strip_prefix('"')?.chars();
	let mut out = String::new();
	loop {
		match chars.next()? {
			'\\' => match chars.next()? {
				c @ ('"' | '\\') => out.push(c),
				_ => return None,
			},
			'"' => break,
			c if (' '..='~').contains(&c) => out.push(c),
			_ => return None,
		}
	}
	let rest = chars.as_str();
	(rest.is_empty() || rest.starts_with(';')).then_some(out)
}

/// The extended CONNECT Chrome sends: HEADERS with its fields in its order,
/// then a DATA frame with one GREASE capsule (type 41 * N + 23, 0 to 63
/// random bytes). `headers` are the page's own (Chrome 157's
/// `WebTransportOptions.headers`), last, as the page's realm hands them:
/// checked, lower case, sorted by name, the ones Chrome drops dropped.
fn connect_bytes(target: &Target, origin: &str, protocols: &[String], headers: &[(Vec<u8>, Vec<u8>)]) -> Vec<u8> {
	let available = protocols.iter().map(|p| sf_string(p)).collect::<Vec<_>>().join(", ");
	let mut fields: Vec<(&[u8], &[u8])> = vec![
		(b":scheme", b"https"),
		(b":method", b"CONNECT"),
		(b":authority", target.authority.as_bytes()),
		(b":path", target.path.as_bytes()),
		(b":protocol", b"webtransport"),
		(b"sec-webtransport-http3-draft02", b"1"),
		(b"origin", origin.as_bytes()),
	];
	if !protocols.is_empty() {
		fields.push((b"wt-available-protocols", available.as_bytes()));
	}
	for (name, value) in headers {
		fields.push((name.as_slice(), value.as_slice()));
	}
	let block = encode_section(&fields);
	let mut out = Vec::new();
	put_varint(&mut out, FRAME_HEADERS);
	put_varint(&mut out, block.len() as u64);
	out.extend_from_slice(&block);

	let mut capsule = Vec::new();
	put_varint(&mut capsule, (random_u64() >> 4) / 41 * 41 + 23);
	let len = (random_u64() % 64) as usize;
	put_varint(&mut capsule, len as u64);
	let mut bytes = vec![0u8; len];
	let _ = getrandom02::getrandom(&mut bytes);
	capsule.extend_from_slice(&bytes);
	put_varint(&mut out, FRAME_DATA);
	put_varint(&mut out, capsule.len() as u64);
	out.extend_from_slice(&capsule);
	out
}

/// CLOSE_WEBTRANSPORT_SESSION in a DATA frame
fn close_bytes(code: u32, reason: &str) -> Vec<u8> {
	let mut capsule = Vec::new();
	put_varint(&mut capsule, CAPSULE_CLOSE);
	put_varint(&mut capsule, 4 + reason.len() as u64);
	capsule.extend_from_slice(&code.to_be_bytes());
	capsule.extend_from_slice(reason.as_bytes());
	let mut out = Vec::new();
	put_varint(&mut out, FRAME_DATA);
	put_varint(&mut out, capsule.len() as u64);
	out.extend_from_slice(&capsule);
	out
}

/// The parts of the session URL the handshake needs
struct Target {
	/// `:authority`: host and a port other than 443 (`[v6]:port`)
	authority: String,
	/// the TLS server name (an IP address sends no SNI)
	host: String,
	/// `:path`: path and query, no fragment
	path: String,
}

impl Target {
	fn parse(url: &str) -> Result<Self, String> {
		let rest = url
			.strip_prefix("https://")
			.ok_or_else(|| "not an https URL".to_string())?;
		let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
		let mut authority = &rest[..end];
		if let Some(at) = authority.rfind('@') {
			authority = &authority[at + 1..];
		}
		let mut path = &rest[end..];
		if let Some(hash) = path.find('#') {
			path = &path[..hash];
		}
		let path = if path.is_empty() {
			"/".to_string()
		} else if path.starts_with('?') {
			format!("/{path}")
		} else {
			path.to_string()
		};
		let host = if let Some(v6) = authority.strip_prefix('[') {
			v6.split(']').next().unwrap_or_default().to_string()
		} else {
			authority.rsplit_once(':').map(|(h, _)| h).unwrap_or(authority).to_string()
		};
		if host.is_empty() {
			return Err("no host".to_string());
		}
		Ok(Self {
			authority: authority.to_string(),
			host,
			path,
		})
	}
}

/// Wakers of futures waiting on a session's state, each in a slot of its
/// own (reused, not grown, by the future that holds it)
#[derive(Default)]
struct Notify {
	slots: RefCell<Vec<Option<Waker>>>,
}

impl Notify {
	fn wake(&self) {
		let wakers: Vec<Waker> = self.slots.borrow().iter().flatten().cloned().collect();
		for w in wakers {
			w.wake();
		}
	}
}

/// Ready when `ready` gives a value; re-checked whenever `notify` wakes
struct Wait<'a, F> {
	notify: &'a Notify,
	slot: Option<usize>,
	ready: F,
}

fn wait<T, F: FnMut() -> Option<T> + Unpin>(notify: &Notify, ready: F) -> Wait<'_, F> {
	Wait {
		notify,
		slot: None,
		ready,
	}
}

impl<T, F: FnMut() -> Option<T> + Unpin> Future for Wait<'_, F> {
	type Output = T;

	fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<T> {
		let this = self.get_mut();
		if let Some(v) = (this.ready)() {
			return Poll::Ready(v);
		}
		let mut slots = this.notify.slots.borrow_mut();
		let i = match this.slot {
			Some(i) => i,
			None => {
				let i = slots.iter().position(Option::is_none).unwrap_or_else(|| {
					slots.push(None);
					slots.len() - 1
				});
				this.slot = Some(i);
				i
			}
		};
		slots[i] = Some(cx.waker().clone());
		Poll::Pending
	}
}

impl<F> Drop for Wait<'_, F> {
	fn drop(&mut self) {
		if let (Some(i), Ok(mut slots)) = (self.slot, self.notify.slots.try_borrow_mut()) {
			slots[i] = None;
		}
	}
}

/// What a stream's write may leave unsent when it settles: Chrome's write
/// settles once its bytes are in the pipe to the network service, which
/// sends them as QUIC's congestion window lets it, so a page's
/// `writer.ready` and its write promises keep pace with the path. quinn takes
/// a write into its send buffer as far as flow control and `send_window`
/// (15 MiB) allow, so a write settled long before its bytes left and an
/// upload measured by them read the page's own speed. A write here settles
/// once the session's datagrams have carried all but this much of what its
/// streams were written (`write`).
const UNSENT_AHEAD: u64 = 256 * 1024;

const READ: usize = 0;
const WRITE: usize = 1;
const RESET: usize = 2;
const STOPPED: usize = 3;

/// The futures waiting on one stream. quinn keeps one reader waker per
/// stream (read and received_reset share it), so quinn is always handed
/// this one, which wakes them all.
#[derive(Default)]
struct StreamWakers {
	slots: Mutex<[Option<Waker>; 4]>,
}

impl Wake for StreamWakers {
	fn wake(self: Arc<Self>) {
		self.wake_by_ref();
	}

	fn wake_by_ref(self: &Arc<Self>) {
		let wakers: Vec<Waker> = self.slots.lock().unwrap().iter_mut().filter_map(Option::take).collect();
		for w in wakers {
			w.wake();
		}
	}
}

struct Stream {
	send: Option<SendStream>,
	recv: Option<RecvStream>,
	/// not finished, reset or stopped
	send_open: bool,
	/// FIN not read, not reset, not stopped
	recv_open: bool,
	/// the peer's RESET_STREAM, as a WebTransport code
	reset_code: Option<u32>,
	/// the peer's STOP_SENDING, as a WebTransport code
	stop_code: Option<u32>,
	/// quinn's stopped() resolved: the send side is over
	send_over: bool,
	wakers: Arc<StreamWakers>,
}

impl Stream {
	/// Poll quinn with the stream's own waker, `cx` waiting in `slot`
	fn poll_with<R>(
		&mut self,
		slot: usize,
		cx: &mut Context<'_>,
		f: impl FnOnce(&mut Self, &mut Context<'_>) -> Poll<R>,
	) -> Poll<R> {
		self.wakers.slots.lock().unwrap()[slot] = Some(cx.waker().clone());
		let waker = Waker::from(self.wakers.clone());
		let mut inner = Context::from_waker(&waker);
		f(self, &mut inner)
	}
}

/// Reads frames from a stream the session reads whole (control, CONNECT)
struct FrameReader {
	recv: RecvStream,
	buf: BytesMut,
}

impl FrameReader {
	fn new(recv: RecvStream) -> Self {
		Self {
			recv,
			buf: BytesMut::new(),
		}
	}

	async fn fill(&mut self) -> Result<bool, String> {
		match self.recv.read_chunk(64 * 1024, true).await {
			Ok(Some(chunk)) => {
				self.buf.extend_from_slice(&chunk.bytes);
				Ok(true)
			}
			Ok(None) => Ok(false),
			Err(ReadError::Reset(code)) => Err(format!("stream reset ({:#x})", code.into_inner())),
			Err(e) => Err(e.to_string()),
		}
	}

	/// The next varint; None at a FIN before it
	async fn varint(&mut self) -> Result<Option<u64>, String> {
		loop {
			if let Some((v, n)) = get_varint(&self.buf) {
				self.buf.advance(n);
				return Ok(Some(v));
			}
			if !self.fill().await? {
				return if self.buf.is_empty() {
					Ok(None)
				} else {
					Err("truncated".to_string())
				};
			}
		}
	}

	async fn frame_header(&mut self) -> Result<Option<(u64, u64)>, String> {
		let Some(ty) = self.varint().await? else {
			return Ok(None);
		};
		let len = self.varint().await?.ok_or_else(|| "truncated frame".to_string())?;
		Ok(Some((ty, len)))
	}

	async fn take(&mut self, n: usize) -> Result<Bytes, String> {
		while self.buf.len() < n {
			if !self.fill().await? {
				return Err("truncated frame".to_string());
			}
		}
		Ok(self.buf.split_to(n).freeze())
	}

	async fn skip(&mut self, mut n: u64) -> Result<(), String> {
		loop {
			let k = n.min(self.buf.len() as u64);
			self.buf.advance(k as usize);
			n -= k;
			if n == 0 {
				return Ok(());
			}
			if !self.fill().await? {
				return Err("truncated frame".to_string());
			}
		}
	}
}

async fn read_varint(recv: &mut RecvStream) -> Option<u64> {
	let mut buf = [0u8; 8];
	recv.read_exact(&mut buf[..1]).await.ok()?;
	let len = 1usize << (buf[0] >> 6);
	recv.read_exact(&mut buf[1..len]).await.ok()?;
	get_varint(&buf[..len]).map(|(v, _)| v)
}

type Outcome = Result<(u32, String), String>;

struct Session {
	quic: quinn::Connection,
	endpoint: Endpoint,
	socket: Arc<ChannelSocket>,
	stats: Arc<Stats>,
	handshake_ms: f64,
	/// any change of the session's state: SETTINGS, QPACK entries, incoming
	/// streams, the end
	change: Notify,
	ended: Cell<bool>,
	outcome: RefCell<Option<Outcome>>,
	settings: RefCell<Option<Vec<(u64, u64)>>>,
	streams: RefCell<HashMap<u32, Rc<RefCell<Stream>>>>,
	next_handle: Cell<u32>,
	incoming_bi: RefCell<VecDeque<u32>>,
	incoming_uni: RefCell<VecDeque<u32>>,
	decoder: RefCell<qpack_codec::Decoder>,
	/// our QPACK decoder stream (6) and whether its type went out: it is
	/// written only with its first instruction, as Chrome's
	decoder_stream: futures_util::lock::Mutex<(Option<SendStream>, bool)>,
	/// the control stream (2) and the QPACK encoder stream (10, never
	/// written): held, as dropping a stream finishes it
	held: RefCell<Vec<SendStream>>,
	connect_send: RefCell<Option<SendStream>>,
	/// the server's side of the CONNECT stream is over
	peer_done: Cell<bool>,
	/// the server sent STOP_SENDING on the CONNECT stream
	connect_stopped: Cell<bool>,
	/// the server accepted the session
	ready: Cell<bool>,
	tearing_down: Cell<bool>,
	protocol: RefCell<String>,
	datagrams_sent: Cell<u64>,
	datagrams_received: Cell<u64>,
	/// the datagram bytes sent when the session began, and every byte its
	/// streams have been written since: a write settles once the datagrams
	/// sent since carry nearly that many (`write`)
	sent_base: u64,
	written: Cell<u64>,
}


fn gone() -> JsValue {
	js_error("gone")
}

impl Session {
	fn until_ended(&self) -> Wait<'_, impl FnMut() -> Option<()> + Unpin + '_> {
		wait(&self.change, move || self.ended.get().then_some(()))
	}

	/// The session is over: `closed` settles, every waiter wakes
	fn end(&self, outcome: Outcome) {
		if self.ended.replace(true) {
			return;
		}
		*self.outcome.borrow_mut() = Some(outcome);
		self.change.wake();
		for st in self.streams.borrow().values() {
			// a RESET_STREAM or STOP_SENDING already received for a stream
			// is what its pending read or write reports, not the end
			let mut s = st.borrow_mut();
			let s = &mut *s;
			if s.recv_open && s.reset_code.is_none() {
				if let Some(recv) = s.recv.as_mut() {
					if let Some(Ok(Some(code))) = recv.received_reset().now_or_never() {
						s.reset_code = Some(h3_to_wt(code.into_inner()));
						s.recv_open = false;
					}
				}
			}
			if s.send_open && s.stop_code.is_none() {
				if let Some(send) = s.send.as_ref() {
					if let Some(Ok(Some(code))) = send.stopped().now_or_never() {
						s.stop_code = Some(h3_to_wt(code.into_inner()));
					}
				}
			}
			s.wakers.wake_by_ref();
		}
	}

	/// The server stopped our side of the CONNECT stream: with a close,
	/// Chrome reports the session lost, not closed (measured)
	fn connect_was_stopped(&self) -> bool {
		if !self.connect_stopped.get() {
			if let Some(send) = self.connect_send.borrow().as_ref() {
				if let Some(Ok(Some(_))) = send.stopped().now_or_never() {
					self.connect_stopped.set(true);
				}
			}
		}
		self.connect_stopped.get()
	}

	/// A clean close from the server, unless it stopped the CONNECT stream
	fn end_by_server(&self, code: u32, reason: String) {
		if self.connect_was_stopped() {
			self.end(Err("lost: CONNECT stream stopped by the server".to_string()));
		} else {
			self.end(Ok((code, reason)));
		}
	}

	/// What Chrome sends once both sides of the CONNECT stream are over
	/// (quiche's OnConnectStreamClosing, measured on 152 and 156):
	/// STOP_SENDING on every receive side and RESET_STREAM on every send side
	/// of the session still open, all with H3_CONNECT_ERROR (0x10f), in the
	/// packet that carries its FIN
	fn cancel_all(&self) {
		let code = VarInt::from_u32(H3_CONNECT_ERROR);
		for st in self.streams.borrow().values() {
			let mut s = st.borrow_mut();
			let s = &mut *s;
			if s.recv_open && s.reset_code.is_none() {
				if let Some(recv) = s.recv.as_mut() {
					let _ = recv.stop(code);
				}
			}
			s.recv_open = false;
			if s.send_open && s.stop_code.is_none() {
				if let Some(send) = s.send.as_mut() {
					let _ = send.reset(code);
				}
			}
			s.send_open = false;
			s.wakers.wake_by_ref();
		}
	}

	/// FIN on our side of the CONNECT stream, as Chrome answers a close
	fn finish_connect(&self) {
		if let Some(send) = self.connect_send.borrow_mut().as_mut() {
			let _ = send.finish();
		}
	}

	/// The CONNECT stream is over both ways: the streams are cancelled and
	/// the connection goes quiet
	fn connect_over(self: &Rc<Self>) {
		self.peer_done.set(true);
		self.change.wake();
		if self.tearing_down.get() {
			return;
		}
		self.finish_connect();
		self.cancel_all();
		self.go_quiet();
	}

	/// After a session Chrome sends nothing more on its connection, not even
	/// ACKs or a CONNECTION_CLOSE (measured: silent for the 6 s watched), so
	/// once what is queued has left the channel closes and the connection is
	/// dropped without a word
	fn go_quiet(self: &Rc<Self>) {
		if self.tearing_down.replace(true) {
			return;
		}
		let s = self.clone();
		spawn_local(async move {
			// quinn's driver (a microtask) puts the last frames on the wire
			// within a few microtask turns; packets of the server's after
			// that go unacknowledged, as Chrome's do
			for _ in 0..4 {
				let _ = wasm_bindgen_futures::JsFuture::from(js_sys::Promise::resolve(&JsValue::NULL)).await;
			}
			s.socket.close();
			s.quic.close(VarInt::from_u32(H3_NO_ERROR), b"");
			s.endpoint.close(VarInt::from_u32(H3_NO_ERROR), b"");
		});
	}

	/// A session that never was (a refused or failed handshake): the
	/// connection is closed with H3_NO_ERROR
	fn close_now(self: &Rc<Self>) {
		if self.tearing_down.replace(true) {
			return;
		}
		let s = self.clone();
		spawn_local(async move {
			s.quic.close(VarInt::from_u32(H3_NO_ERROR), b"");
			// let the CONNECTION_CLOSE leave before the channel goes
			TimeoutFuture::new(100).await;
			s.socket.close();
		});
	}

	/// A session over without the CONNECT stream ending both ways (the
	/// server never answers our close): quiet after a second
	fn quiet_later(self: &Rc<Self>) {
		let s = self.clone();
		spawn_local(async move {
			TimeoutFuture::new(1000).await;
			s.go_quiet();
		});
	}

	/// A connection error of ours (RFC 9114 section 8)
	fn connection_error(&self, code: u32) {
		self.quic.close(VarInt::from_u32(code), b"");
	}

	fn add_stream(&self, send: Option<SendStream>, recv: Option<RecvStream>) -> u32 {
		let handle = self.next_handle.get();
		self.next_handle.set(handle + 1);
		let watch = send.as_ref().map(|s| s.stopped());
		let stream = Rc::new(RefCell::new(Stream {
			send_open: send.is_some(),
			recv_open: recv.is_some(),
			send,
			recv,
			reset_code: None,
			stop_code: None,
			send_over: false,
			wakers: Arc::default(),
		}));
		if let Some(watch) = watch {
			// Chrome errors the page's writable as soon as STOP_SENDING
			// arrives and answers it with RESET_STREAM of the same code
			let stream = stream.clone();
			spawn_local(async move {
				let result = watch.await;
				let mut s = stream.borrow_mut();
				let s = &mut *s;
				if let Ok(Some(code)) = result {
					s.stop_code = Some(h3_to_wt(code.into_inner()));
					if s.send_open {
						if let Some(send) = s.send.as_mut() {
							let _ = send.reset(code);
						}
						s.send_open = false;
					}
				}
				s.send_over = true;
				s.wakers.wake_by_ref();
			});
		}
		self.streams.borrow_mut().insert(handle, stream);
		handle
	}

	fn stream(&self, handle: u32) -> Result<Rc<RefCell<Stream>>, JsValue> {
		self.streams
			.borrow()
			.get(&handle)
			.cloned()
			.ok_or_else(|| js_error("no such stream"))
	}

	async fn write_decoder(&self, bytes: &[u8]) {
		let mut guard = self.decoder_stream.lock().await;
		let (stream, type_sent) = &mut *guard;
		let Some(stream) = stream.as_mut() else { return };
		let mut out = Vec::new();
		if !*type_sent {
			*type_sent = true;
			out.push(0x03);
		}
		out.extend_from_slice(bytes);
		let _ = stream.write_all(&out).await;
	}

	/// Decode a field section, waiting while it needs dynamic table entries
	/// still on their way; one that used the table is acknowledged
	async fn decode_section(&self, stream_id: u64, block: &[u8]) -> Result<Vec<(Vec<u8>, Vec<u8>)>, String> {
		let required = self.decoder.borrow().required_insert_count(block)?;
		wait(&self.change, || {
			(self.ended.get() || self.decoder.borrow().total_inserted() >= required).then_some(())
		})
		.await;
		if self.ended.get() {
			return Err("connection lost".to_string());
		}
		let (fields, dyn_ref, size) = self.decoder.borrow().decode(block)?;
		if dyn_ref {
			let mut ack = Vec::new();
			qpack_codec::section_ack(stream_id, &mut ack);
			self.write_decoder(&ack).await;
		}
		if size > MAX_FIELD_SECTION_SIZE {
			return Err("response field section too large".to_string());
		}
		Ok(fields)
	}

	async fn accept_uni_loop(self: Rc<Self>) {
		while let Ok(recv) = self.quic.accept_uni().await {
			spawn_local(self.clone().incoming_uni(recv));
		}
	}

	async fn accept_bi_loop(self: Rc<Self>) {
		while let Ok((send, recv)) = self.quic.accept_bi().await {
			spawn_local(self.clone().incoming_bi(send, recv));
		}
	}

	async fn incoming_uni(self: Rc<Self>, mut recv: RecvStream) {
		let Some(ty) = read_varint(&mut recv).await else { return };
		match ty {
			0x00 => self.control_stream(recv).await,
			0x02 => self.encoder_stream(recv).await,
			0x03 => {
				// the server's QPACK decoder stream: we never insert, so
				// nothing on it matters, but it must stay open
				while let Ok(Some(_)) = recv.read_chunk(64 * 1024, true).await {}
				if !self.ended.get() {
					self.connection_error(H3_CLOSED_CRITICAL_STREAM);
				}
			}
			0x01 => self.connection_error(H3_ID_ERROR), // a push we never allowed
			STREAM_WT_UNI => {
				let id = read_varint(&mut recv).await;
				if id != Some(SESSION_ID) || self.ended.get() {
					let _ = recv.stop(VarInt::from_u64(WEBTRANSPORT_SESSION_GONE).unwrap());
					return;
				}
				let handle = self.add_stream(None, Some(recv));
				self.incoming_uni.borrow_mut().push_back(handle);
				self.change.wake();
			}
			// unknown and GREASE stream types: what quiche does
			_ => {
				let _ = recv.stop(VarInt::from_u32(H3_STREAM_CREATION_ERROR));
			}
		}
	}

	async fn incoming_bi(self: Rc<Self>, mut send: SendStream, mut recv: RecvStream) {
		let ty = read_varint(&mut recv).await;
		let id = match ty {
			Some(STREAM_WT_BIDI) => read_varint(&mut recv).await,
			_ => None,
		};
		if ty != Some(STREAM_WT_BIDI) {
			// a request stream from a server: not HTTP/3
			let _ = recv.stop(VarInt::from_u32(H3_STREAM_CREATION_ERROR));
			let _ = send.reset(VarInt::from_u32(H3_STREAM_CREATION_ERROR));
			return;
		}
		if id != Some(SESSION_ID) || self.ended.get() {
			let gone = VarInt::from_u64(WEBTRANSPORT_SESSION_GONE).unwrap();
			let _ = recv.stop(gone);
			let _ = send.reset(gone);
			return;
		}
		let handle = self.add_stream(Some(send), Some(recv));
		self.incoming_bi.borrow_mut().push_back(handle);
		self.change.wake();
	}

	async fn control_stream(self: Rc<Self>, recv: RecvStream) {
		let mut r = FrameReader::new(recv);
		match r.frame_header().await {
			Ok(Some((FRAME_SETTINGS, len))) if len <= 16 * 1024 => {
				let Ok(body) = r.take(len as usize).await else {
					self.connection_error(H3_CLOSED_CRITICAL_STREAM);
					return;
				};
				let mut settings = Vec::new();
				let mut rest = &body[..];
				while !rest.is_empty() {
					let Some((id, n)) = get_varint(rest) else { break };
					rest = &rest[n..];
					let Some((value, n)) = get_varint(rest) else {
						self.connection_error(H3_SETTINGS_ERROR);
						return;
					};
					rest = &rest[n..];
					if settings.iter().any(|&(i, _)| i == id) {
						self.connection_error(H3_SETTINGS_ERROR);
						return;
					}
					settings.push((id, value));
				}
				if !rest.is_empty() {
					self.connection_error(H3_SETTINGS_ERROR);
					return;
				}
				*self.settings.borrow_mut() = Some(settings);
				self.change.wake();
			}
			Ok(Some(_)) => {
				self.connection_error(H3_MISSING_SETTINGS);
				return;
			}
			_ => {
				self.connection_error(H3_CLOSED_CRITICAL_STREAM);
				return;
			}
		}
		loop {
			match r.frame_header().await {
				Ok(Some((FRAME_SETTINGS, _))) => {
					self.connection_error(H3_FRAME_UNEXPECTED);
					return;
				}
				// GOAWAY and the rest: nothing a session shows
				Ok(Some((_, len))) => {
					if r.skip(len).await.is_err() {
						break;
					}
				}
				_ => break,
			}
		}
		if !self.ended.get() {
			self.connection_error(H3_CLOSED_CRITICAL_STREAM);
		}
	}

	async fn encoder_stream(self: Rc<Self>, mut recv: RecvStream) {
		let mut buf = BytesMut::new();
		while let Ok(Some(chunk)) = recv.read_chunk(64 * 1024, true).await {
			buf.extend_from_slice(&chunk.bytes);
			let mut out = Vec::new();
			let applied = self.decoder.borrow_mut().on_encoder(&mut buf, &mut out);
			if applied.is_err() {
				self.connection_error(QPACK_ENCODER_STREAM_ERROR);
				return;
			}
			if !out.is_empty() {
				self.write_decoder(&out).await;
			}
			self.change.wake();
		}
		if !self.ended.get() {
			self.connection_error(H3_CLOSED_CRITICAL_STREAM);
		}
	}

	/// The CONNECT stream once the session is up: capsules in DATA frames
	async fn connect_stream(self: Rc<Self>, mut r: FrameReader) {
		let mut capsules = BytesMut::new();
		// what is left of a large capsule being skipped
		let mut skipping = 0u64;
		let result: Result<(), String> = async {
			loop {
				let Some((ty, len)) = r.frame_header().await? else {
					return Ok(());
				};
				if ty != FRAME_DATA {
					r.skip(len).await?;
					continue;
				}
				let mut left = len;
				while left > 0 {
					let piece = r.take(left.min(64 * 1024) as usize).await?;
					left -= piece.len() as u64;
					let mut piece = &piece[..];
					if skipping > 0 {
						let k = skipping.min(piece.len() as u64);
						skipping -= k;
						piece = &piece[k as usize..];
					}
					capsules.extend_from_slice(piece);
					loop {
						let Some((cty, n1)) = get_varint(&capsules) else { break };
						let Some((clen, n2)) = get_varint(&capsules[n1..]) else { break };
						let head = n1 + n2;
						if cty != CAPSULE_CLOSE && clen > 64 * 1024 {
							// an unknown capsule too large to hold: drop it as it comes
							let have = (capsules.len() - head) as u64;
							let k = have.min(clen);
							capsules.advance(head + k as usize);
							skipping = clen - k;
							continue;
						}
						if cty == CAPSULE_CLOSE && clen > 4 + 64 * 1024 {
							return Err("close capsule too large".to_string());
						}
						if ((capsules.len() - head) as u64) < clen {
							break;
						}
						capsules.advance(head);
						let value = capsules.split_to(clen as usize);
						if cty == CAPSULE_CLOSE {
							if value.len() < 4 {
								return Err("malformed close capsule".to_string());
							}
							let code = u32::from_be_bytes([value[0], value[1], value[2], value[3]]);
							let reason = String::from_utf8_lossy(&value[4..]).into_owned();
							// Chrome settles `closed` at the capsule and
							// answers with its FIN
							self.end_by_server(code, reason);
							self.finish_connect();
							self.quiet_later();
						}
						// DRAIN_WEBTRANSPORT_SESSION and unknown capsules: skipped
					}
				}
			}
		}
		.await;
		match result {
			// a FIN with no capsule is a clean close with code 0
			Ok(()) => self.end_by_server(0, String::new()),
			Err(e) => self.end(Err(format!("lost: CONNECT stream: {e}"))),
		}
		self.connect_over();
	}

	async fn handshake(
		self: &Rc<Self>,
		target: &Target,
		origin: &str,
		protocols: &[String],
		headers: &[(Vec<u8>, Vec<u8>)],
	) -> Result<(), String> {
		let quic = self.quic.clone();
		let open = |what: &'static str| {
			let quic = quic.clone();
			async move { quic.open_uni().await.map_err(|e| format!("{what}: {e}")) }
		};
		// client uni streams in Chrome's order: control (2), QPACK decoder
		// (6), QPACK encoder (10); the QPACK ones stay empty until used
		let mut control = open("control stream").await?;
		let decoder = open("QPACK decoder stream").await?;
		let encoder = open("QPACK encoder stream").await?;
		self.decoder_stream.lock().await.0 = Some(decoder);
		control
			.write_all(&control_stream_bytes())
			.await
			.map_err(|e| format!("control stream: {e}"))?;
		self.held.borrow_mut().extend([control, encoder]);

		spawn_local(self.clone().accept_uni_loop());
		spawn_local(self.clone().accept_bi_loop());

		// Chrome sends no request before the server's SETTINGS say it takes
		// HTTP datagrams and draft 02 WebTransport
		let settings = wait(&self.change, || {
			if self.ended.get() {
				return Some(None);
			}
			self.settings.borrow().clone().map(Some)
		})
		.await
		.ok_or_else(|| "connection lost before SETTINGS".to_string())?;
		let has = |id: u64| settings.iter().any(|&(i, v)| i == id && v == 1);
		if !(has(SETTING_H3_DATAGRAM) || has(SETTING_H3_DATAGRAM_DRAFT04)) {
			return Err("server SETTINGS lack H3_DATAGRAM".to_string());
		}
		if !has(SETTING_ENABLE_WEBTRANSPORT) {
			return Err("server SETTINGS lack ENABLE_WEBTRANSPORT".to_string());
		}

		let (mut send, recv) = self.quic.open_bi().await.map_err(|e| format!("CONNECT stream: {e}"))?;
		let stream_id = send.id().index() * 4; // client bidi: 4 * index
		send.write_all(&connect_bytes(target, origin, protocols, headers))
			.await
			.map_err(|e| format!("CONNECT: {e}"))?;
		{
			// STOP_SENDING on the CONNECT stream is answered with RESET_STREAM
			// of the same code (quiche), and the session goes on: it ends
			// when the server's side of the CONNECT stream does, lost then
			// rather than closed (end_by_server). A RESET_STREAM on a data
			// stream after the stop reaches the page's read first (the
			// fixture's /close?style=gone, measured on 152)
			let s = self.clone();
			let stopped = send.stopped();
			spawn_local(async move {
				if let Ok(Some(code)) = stopped.await {
					s.connect_stopped.set(true);
					if s.ready.get() && !s.ended.get() {
						if let Some(send) = s.connect_send.borrow_mut().as_mut() {
							let _ = send.reset(code);
						}
					}
				}
			});
		}
		*self.connect_send.borrow_mut() = Some(send);

		let mut r = FrameReader::new(recv);
		let fields = loop {
			let (ty, len) = r
				.frame_header()
				.await?
				.ok_or_else(|| "CONNECT stream ended before a response".to_string())?;
			match ty {
				FRAME_HEADERS if len <= 64 * 1024 => {
					let block = r.take(len as usize).await?;
					break self.decode_section(stream_id, &block).await?;
				}
				FRAME_HEADERS | FRAME_DATA => return Err("malformed response".to_string()),
				_ => r.skip(len).await?,
			}
		};
		let status = fields.iter().find(|(n, _)| n == b":status").map(|(_, v)| v.clone());
		if status.as_deref() != Some(b"200") {
			let status = status.map(|s| String::from_utf8_lossy(&s).into_owned());
			return Err(format!("status {}", status.unwrap_or_else(|| "missing".to_string())));
		}
		let protocol = fields
			.iter()
			.find(|(n, _)| n == b"wt-protocol")
			.and_then(|(_, v)| parse_sf_string(v))
			.filter(|p| protocols.contains(p))
			.unwrap_or_default();
		*self.protocol.borrow_mut() = protocol;
		self.ready.set(true);
		spawn_local(self.clone().connect_stream(r));
		Ok(())
	}
}

struct Options {
	origin: String,
	protocols: Vec<String>,
	headers: Vec<(Vec<u8>, Vec<u8>)>,
	hashes: Vec<Vec<u8>>,
	pem: String,
	timeout_ms: u32,
}

impl Options {
	fn parse(options: &JsValue) -> Self {
		let get = |k: &str| Reflect::get(options, &k.into()).unwrap_or(JsValue::UNDEFINED);
		let list = |k: &str| -> Vec<JsValue> {
			let v = get(k);
			if Array::is_array(&v) {
				v.unchecked_into::<Array>().iter().collect()
			} else {
				Vec::new()
			}
		};
		Self {
			origin: get("origin").as_string().unwrap_or_default(),
			protocols: list("protocols").into_iter().filter_map(|p| p.as_string()).collect(),
			headers: list("headers").into_iter().filter_map(|pair| page_header(&pair)).collect(),
			hashes: list("hashes")
				.into_iter()
				.filter_map(|h| h.dyn_into::<Uint8Array>().ok())
				.map(|h| h.to_vec())
				.collect(),
			pem: get("pem").as_string().unwrap_or_default(),
			timeout_ms: get("timeoutMs")
				.as_f64()
				.map(|v| v.clamp(1.0, 120_000.0) as u32)
				.unwrap_or(4000),
		}
	}
}

/// A string of the page's as the bytes a ByteString is (each code unit one
/// byte), or None when one does not fit
fn byte_string(value: &JsValue) -> Option<Vec<u8>> {
	value.as_string()?.chars().map(|c| u8::try_from(c as u32).ok()).collect()
}

/// One of the page's headers, `[name, value]`: the realm checked it as
/// Chrome does, and what the page could not have set is refused here again
/// (a pseudo-header, a name that is no lower-case token, a value with a NUL,
/// CR or LF, and the fields this client writes itself)
fn page_header(pair: &JsValue) -> Option<(Vec<u8>, Vec<u8>)> {
	if !Array::is_array(pair) {
		return None;
	}
	let pair = pair.unchecked_ref::<Array>();
	let (name, value) = (byte_string(&pair.get(0))?, byte_string(&pair.get(1))?);
	let token = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit() || b"!#$%&'*+-.^_`|~".contains(c);
	let own = [&b"origin"[..], b"wt-available-protocols", b"host", b"cookie"];
	if name.is_empty()
		|| !name.iter().all(token)
		|| own.contains(&name.as_slice())
		|| name.starts_with(b"sec-")
		|| name.starts_with(b"proxy-")
		|| value.iter().any(|c| matches!(c, 0 | b'\r' | b'\n'))
	{
		return None;
	}
	Some((name, value))
}

/// Open a WebTransport session to `url` over the datagram channel.
/// `options`: `{ origin, protocols?, headers?, hashes?, pem?, timeoutMs? }` (see
/// API.md in the stream notes); resolves once the server answers the
/// CONNECT with `:status 200`, rejects with "handshake: ..." otherwise.
#[wasm_bindgen]
pub async fn connect_webtransport(
	url: String,
	readable: ReadableStream,
	writable: WritableStream,
	options: JsValue,
) -> Result<WtSession, JsValue> {
	let fail = |e: &dyn std::fmt::Display| js_error(format!("handshake: {e}"));
	let opts = Options::parse(&options);
	let target = Target::parse(&url).map_err(|e| fail(&e))?;
	let hashes = (!opts.hashes.is_empty()).then(|| opts.hashes.clone());
	let tls = tls_config(&opts.pem, hashes)?;
	// quiche pings a connection with an open request stream (the CONNECT
	// stream) every 15 s, so an idle session stays up (transport_config's
	// keep-alive: the CONNECT stream is open while the session is)
	let transport = transport_config();
	// a fresh config: Chrome's WebTransport client has no TLS session cache
	let config = quic_client_config(tls, transport)?;
	let start = web_time::Instant::now();

	let (closed_tx, mut closed_rx) = futures_channel::oneshot::channel::<()>();
	let socket = Arc::new(ChannelSocket::new(readable, writable, move || {
		let _ = closed_tx.send(());
	})?);
	let stats = socket.stats.clone();
	let endpoint = new_endpoint(socket.clone())?;
	let connecting = endpoint
		.connect_with(config, PEER, &target.host)
		.map_err(|e| fail(&e))?;
	let timeout = TimeoutFuture::new(opts.timeout_ms);
	let quic = match select(Box::pin(connecting), select(&mut closed_rx, timeout)).await {
		Either::Left((Ok(conn), _)) => conn,
		Either::Left((Err(e), _)) => {
			endpoint.close(VarInt::from_u32(0), b"");
			socket.close();
			return Err(fail(&e));
		}
		Either::Right((Either::Left(_), _)) => {
			endpoint.close(VarInt::from_u32(0), b"");
			return Err(fail(&"datagram channel closed"));
		}
		Either::Right((Either::Right(_), _)) => {
			endpoint.close(VarInt::from_u32(0), b"");
			socket.close();
			return Err(fail(&"timed out"));
		}
	};

	let session = Rc::new(Session {
		quic,
		endpoint,
		socket,
		stats: stats.clone(),
		handshake_ms: start.elapsed().as_secs_f64() * 1000.0,
		change: Notify::default(),
		ended: Cell::new(false),
		outcome: RefCell::new(None),
		settings: RefCell::new(None),
		streams: RefCell::new(HashMap::new()),
		next_handle: Cell::new(1),
		incoming_bi: RefCell::new(VecDeque::new()),
		incoming_uni: RefCell::new(VecDeque::new()),
		decoder: RefCell::new(qpack_codec::Decoder::new(QPACK_MAX_TABLE_CAPACITY as usize)),
		decoder_stream: futures_util::lock::Mutex::new((None, false)),
		held: RefCell::new(Vec::new()),
		connect_send: RefCell::new(None),
		peer_done: Cell::new(false),
		connect_stopped: Cell::new(false),
		ready: Cell::new(false),
		tearing_down: Cell::new(false),
		protocol: RefCell::new(String::new()),
		datagrams_sent: Cell::new(0),
		datagrams_received: Cell::new(0),
		sent_base: stats.sent_bytes.load(std::sync::atomic::Ordering::Relaxed),
		written: Cell::new(0),
	});
	{
		// the connection ending ends the session
		let s = session.clone();
		spawn_local(async move {
			let e = s.quic.closed().await;
			s.end(Err(format!("lost: {e}")));
			s.peer_done.set(true);
			s.change.wake();
			s.go_quiet();
		});
	}
	{
		// so does the datagram channel (the wisp stream) closing: nothing
		// can reach the server any more
		let s = session.clone();
		spawn_local(async move {
			if closed_rx.await.is_ok() {
				s.end(Err("lost: datagram channel closed".to_string()));
				s.quic.close(VarInt::from_u32(H3_NO_ERROR), b"");
				s.endpoint.close(VarInt::from_u32(H3_NO_ERROR), b"");
			}
		});
	}
	match session.handshake(&target, &opts.origin, &opts.protocols, &opts.headers).await {
		Ok(()) => Ok(WtSession { s: session }),
		Err(e) => {
			session.end(Err(format!("handshake: {e}")));
			session.close_now();
			Err(fail(&e))
		}
	}
}

/// Waits for the datagrams to carry what the streams were written, `len`
/// more bytes of it now (`UNSENT_AHEAD`). The datagrams' bytes are
/// counted whole (headers, acknowledgements, other streams' and
/// datagrams' bytes, retransmissions), so this never waits longer than
/// the bytes take to leave. A stop or the session's end settles it as
/// the write's own would; a send side over another way settles it.
async fn until_sent(s: &Session, st: &Rc<RefCell<Stream>>, len: u64) -> Result<(), JsValue> {
	let target = s.written.get() + len;
	s.written.set(target);
	poll_fn(|cx| {
		let mut guard = st.borrow_mut();
		let stream = &mut *guard;
		if let Some(n) = stream.stop_code {
			return Poll::Ready(Err(js_error(format!("stop {n}"))));
		}
		if s.ended.get() {
			return Poll::Ready(Err(gone()));
		}
		let sent = s.stats.sent_bytes.load(std::sync::atomic::Ordering::Relaxed) - s.sent_base;
		if sent + UNSENT_AHEAD >= target || stream.send.is_none() {
			return Poll::Ready(Ok(()));
		}
		// woken by the next datagram sent, or by quinn on a STOP_SENDING
		// (or the stream's end), or by the session's end
		s.stats.wake_on_send(cx.waker());
		let stopped = stream.poll_with(WRITE, cx, |stream, cx| {
			let send = stream.send.as_ref().unwrap();
			pin!(send.stopped()).poll(cx)
		});
		match stopped {
			Poll::Ready(Ok(Some(code))) => {
				let n = h3_to_wt(code.into_inner());
				stream.stop_code = Some(n);
				stream.send_open = false;
				Poll::Ready(Err(js_error(format!("stop {n}"))))
			}
			Poll::Ready(_) => Poll::Ready(Ok(())),
			Poll::Pending => Poll::Pending,
		}
	})
	.await
}

/// One WebTransport session: streams by handle, datagrams, close.
#[wasm_bindgen]
pub struct WtSession {
	s: Rc<Session>,
}

#[wasm_bindgen]
impl WtSession {
	/// The server's `wt-protocol` when it is one of those offered, else ''
	#[wasm_bindgen(getter)]
	pub fn protocol(&self) -> String {
		self.s.protocol.borrow().clone()
	}

	/// The largest datagram payload now (0 when the peer takes none)
	#[wasm_bindgen(getter)]
	pub fn max_datagram_size(&self) -> u32 {
		// minus the quarter stream id (session 0: one byte)
		self.s.quic.max_datagram_size().map(|m| m.saturating_sub(1) as u32).unwrap_or(0)
	}

	async fn open(&self, bidi: bool) -> Result<u32, JsValue> {
		let s = self.s.clone();
		if s.ended.get() {
			return Err(gone());
		}
		let (send, recv) = if bidi {
			match select(pin!(s.quic.open_bi()), s.until_ended()).await {
				Either::Left((Ok((send, recv)), _)) => (send, Some(recv)),
				_ => return Err(gone()),
			}
		} else {
			match select(pin!(s.quic.open_uni()), s.until_ended()).await {
				Either::Left((Ok(send), _)) => (send, None),
				_ => return Err(gone()),
			}
		};
		let handle = s.add_stream(Some(send), recv);
		if s.ended.get() {
			return Err(gone());
		}
		// the stream's header goes out as it opens, as Chrome's
		let mut header = Vec::new();
		put_varint(&mut header, if bidi { STREAM_WT_BIDI } else { STREAM_WT_UNI });
		put_varint(&mut header, SESSION_ID);
		self.write(handle, header).await?;
		Ok(handle)
	}

	/// A stream of ours, both ways; its header (`40 41 00`) written
	pub async fn open_bi(&self) -> Result<u32, JsValue> {
		self.open(true).await
	}

	/// A unidirectional stream of ours; its header (`40 54 00`) written
	pub async fn open_uni(&self) -> Result<u32, JsValue> {
		self.open(false).await
	}

	async fn accept(&self, bidi: bool) -> JsValue {
		let s = self.s.clone();
		let queue = if bidi { &s.incoming_bi } else { &s.incoming_uni };
		let handle = wait(&s.change, || {
			if let Some(h) = queue.borrow_mut().pop_front() {
				return Some(Some(h));
			}
			s.ended.get().then_some(None)
		})
		.await;
		match handle {
			Some(h) if !s.ended.get() => h.into(),
			_ => JsValue::UNDEFINED,
		}
	}

	/// The next stream the server opened both ways; undefined once over
	pub async fn accept_bi(&self) -> JsValue {
		self.accept(true).await
	}

	/// The next unidirectional stream from the server; undefined once over
	pub async fn accept_uni(&self) -> JsValue {
		self.accept(false).await
	}

	/// Up to `max` bytes of what has arrived (undefined at FIN). Rejects
	/// "reset <n>" (the peer's RESET_STREAM, n its WebTransport code, 0 for
	/// any other), "gone" (the session ended).
	pub async fn read(&self, handle: u32, max: u32) -> Result<JsValue, JsValue> {
		let s = self.s.clone();
		let st = s.stream(handle)?;
		let max = if max == 0 { 64 * 1024 } else { max as usize };
		let result = poll_fn(|cx| {
			let mut guard = st.borrow_mut();
			let stream = &mut *guard;
			if let Some(n) = stream.reset_code {
				return Poll::Ready(Err(format!("reset {n}")));
			}
			if s.ended.get() {
				return Poll::Ready(Err("gone".to_string()));
			}
			if stream.recv.is_none() {
				return Poll::Ready(Err("not readable".to_string()));
			}
			stream.poll_with(READ, cx, |stream, cx| {
				let recv = stream.recv.as_mut().unwrap();
				let polled = pin!(recv.read_chunk(max, true)).poll(cx);
				match polled {
					Poll::Pending => Poll::Pending,
					Poll::Ready(Ok(Some(chunk))) => Poll::Ready(Ok(Some(chunk.bytes))),
					Poll::Ready(Ok(None)) => {
						stream.recv_open = false;
						Poll::Ready(Ok(None))
					}
					Poll::Ready(Err(ReadError::Reset(code))) => {
						let n = h3_to_wt(code.into_inner());
						stream.reset_code = Some(n);
						stream.recv_open = false;
						Poll::Ready(Err(format!("reset {n}")))
					}
					Poll::Ready(Err(_)) => Poll::Ready(Err("gone".to_string())),
				}
			})
		})
		.await;
		match result {
			Ok(Some(bytes)) => Ok(Uint8Array::from(&bytes[..]).into()),
			Ok(None) => Ok(JsValue::UNDEFINED),
			Err(e) => Err(js_error(e)),
		}
	}

	/// Resolves once quinn has taken every byte (its flow control is the
	/// backpressure) and the session's datagrams have carried all but
	/// `UNSENT_AHEAD` of what its streams were written. Rejects "stop <n>",
	/// "gone".
	pub async fn write(&self, handle: u32, data: Vec<u8>) -> Result<(), JsValue> {
		let s = self.s.clone();
		let st = s.stream(handle)?;
		let mut offset = 0;
		poll_fn(|cx| {
			let mut guard = st.borrow_mut();
			let stream = &mut *guard;
			loop {
				if let Some(n) = stream.stop_code {
					return Poll::Ready(Err(js_error(format!("stop {n}"))));
				}
				if s.ended.get() {
					return Poll::Ready(Err(gone()));
				}
				if offset >= data.len() {
					return Poll::Ready(Ok(()));
				}
				if stream.send.is_none() {
					return Poll::Ready(Err(js_error("not writable")));
				}
				let polled = stream.poll_with(WRITE, cx, |stream, cx| {
					Pin::new(stream.send.as_mut().unwrap()).poll_write(cx, &data[offset..])
				});
				match polled {
					Poll::Pending => return Poll::Pending,
					Poll::Ready(Ok(n)) => offset += n,
					Poll::Ready(Err(WriteError::Stopped(code))) => {
						stream.stop_code = Some(h3_to_wt(code.into_inner()));
						stream.send_open = false;
					}
					Poll::Ready(Err(_)) => return Poll::Ready(Err(gone())),
				}
			}
		})
		.await?;
		until_sent(&s, &st, data.len() as u64).await
	}

	/// FIN after what was written
	pub async fn finish(&self, handle: u32) -> Result<(), JsValue> {
		let st = self.s.stream(handle)?;
		let mut stream = st.borrow_mut();
		if let Some(n) = stream.stop_code {
			return Err(js_error(format!("stop {n}")));
		}
		if self.s.ended.get() {
			return Err(gone());
		}
		let send = stream.send.as_mut().ok_or_else(|| js_error("not writable"))?;
		send.finish().map_err(|_| js_error("closed"))?;
		stream.send_open = false;
		Ok(())
	}

	/// RESET_STREAM with WebTransport code `code`
	pub fn reset(&self, handle: u32, code: u32) {
		let Ok(st) = self.s.stream(handle) else { return };
		let mut stream = st.borrow_mut();
		let stream = &mut *stream;
		if let Some(send) = stream.send.as_mut() {
			if stream.send_open {
				let _ = send.reset(VarInt::from_u64(wt_to_h3(code)).unwrap());
			}
		}
		stream.send_open = false;
		stream.wakers.wake_by_ref();
	}

	/// STOP_SENDING with WebTransport code `code`
	pub fn stop(&self, handle: u32, code: u32) {
		let Ok(st) = self.s.stream(handle) else { return };
		let mut stream = st.borrow_mut();
		let stream = &mut *stream;
		if let Some(recv) = stream.recv.as_mut() {
			if stream.recv_open {
				let _ = recv.stop(VarInt::from_u64(wt_to_h3(code)).unwrap());
			}
		}
		stream.recv_open = false;
		stream.wakers.wake_by_ref();
	}

	/// The peer's STOP_SENDING code (WebTransport; 0 for any other); undefined
	/// once the send side is over another way (finished and acknowledged,
	/// reset, the session ended)
	pub async fn stopped(&self, handle: u32) -> Result<JsValue, JsValue> {
		let s = self.s.clone();
		let st = s.stream(handle)?;
		let code = poll_fn(|cx| {
			let mut stream = st.borrow_mut();
			if let Some(n) = stream.stop_code {
				return Poll::Ready(Some(n));
			}
			if stream.send_over || stream.send.is_none() || s.ended.get() {
				return Poll::Ready(None);
			}
			stream.poll_with(STOPPED, cx, |_, _| Poll::Pending)
		})
		.await;
		Ok(code.map(JsValue::from).unwrap_or(JsValue::UNDEFINED))
	}

	/// The peer's RESET_STREAM code (WebTransport; 0 for any other), seen
	/// without reading; undefined once the receive side is over another way
	pub async fn reset_received(&self, handle: u32) -> Result<JsValue, JsValue> {
		let s = self.s.clone();
		let st = s.stream(handle)?;
		let code = poll_fn(|cx| {
			let mut guard = st.borrow_mut();
			let stream = &mut *guard;
			if let Some(n) = stream.reset_code {
				return Poll::Ready(Some(n));
			}
			if !stream.recv_open || stream.recv.is_none() || s.ended.get() {
				return Poll::Ready(None);
			}
			stream.poll_with(RESET, cx, |stream, cx| {
				let recv = stream.recv.as_mut().unwrap();
				let polled = pin!(recv.received_reset()).poll(cx);
				match polled {
					Poll::Pending => Poll::Pending,
					Poll::Ready(Ok(Some(code))) => {
						let n = h3_to_wt(code.into_inner());
						stream.reset_code = Some(n);
						stream.recv_open = false;
						// a pending read rejects with it too
						stream.wakers.wake_by_ref();
						Poll::Ready(Some(n))
					}
					Poll::Ready(_) => Poll::Ready(None),
				}
			})
		})
		.await;
		Ok(code.map(JsValue::from).unwrap_or(JsValue::UNDEFINED))
	}

	/// Forget a stream. A direction still open is reset / stopped with
	/// WebTransport code 0 (quinn would otherwise finish it, or stop it with
	/// code 0 outside the WebTransport range).
	pub fn release(&self, handle: u32) {
		self.reset(handle, 0);
		self.stop(handle, 0);
		self.s.streams.borrow_mut().remove(&handle);
	}

	/// Send one datagram; false when it cannot go (too large, session over),
	/// dropped as Chrome drops it
	pub fn send_datagram(&self, data: &[u8]) -> bool {
		if self.s.ended.get() {
			return false;
		}
		let mut payload = Vec::with_capacity(data.len() + 1);
		put_varint(&mut payload, SESSION_ID / 4);
		payload.extend_from_slice(data);
		let ok = self.s.quic.send_datagram(Bytes::from(payload)).is_ok();
		if ok {
			self.s.datagrams_sent.set(self.s.datagrams_sent.get() + 1);
		}
		ok
	}

	/// The next datagram of the session; undefined once it is over
	pub async fn read_datagram(&self) -> JsValue {
		let s = self.s.clone();
		loop {
			let read = match select(pin!(s.quic.read_datagram()), s.until_ended()).await {
				Either::Left((Ok(d), _)) => d,
				_ => return JsValue::UNDEFINED,
			};
			if let Some((id, n)) = get_varint(&read) {
				if id == SESSION_ID / 4 {
					s.datagrams_received.set(s.datagrams_received.get() + 1);
					return Uint8Array::from(&read[n..]).into();
				}
			}
		}
	}

	/// CLOSE_WEBTRANSPORT_SESSION (`code`, `reason` cut to 1024 bytes) and
	/// FIN on the CONNECT stream; streams reset with SESSION_GONE; the
	/// connection closes once that is acknowledged (at most a second)
	pub fn close(&self, code: u32, reason: String) {
		if self.s.ended.get() {
			return;
		}
		// the wire carries at most 1024 bytes of the reason, cut at a
		// character; `closed` has it whole, as Chrome's
		let mut cut = reason.len().min(1024);
		while !reason.is_char_boundary(cut) {
			cut -= 1;
		}
		let capsule = close_bytes(code, &reason[..cut]);
		self.s.end(Ok((code, reason)));
		// capsule and FIN; the streams stay as they are until the server
		// ends its side too (then connect_over cancels them), as Chrome's
		let s = self.s.clone();
		spawn_local(async move {
			let send = s.connect_send.borrow_mut().take();
			if let Some(mut send) = send {
				let _ = select(pin!(send.write_all(&capsule)), pin!(TimeoutFuture::new(1000))).await;
				let _ = send.finish();
				*s.connect_send.borrow_mut() = Some(send);
			}
			s.quiet_later();
		});
	}

	/// `{ closeCode, reason }` once the session closed cleanly (either side);
	/// rejects "lost ..." when it ended any other way
	pub async fn closed(&self) -> Result<JsValue, JsValue> {
		let s = self.s.clone();
		let outcome = wait(&s.change, || s.outcome.borrow().clone()).await;
		match outcome {
			Ok((code, reason)) => {
				let o = Object::new();
				Reflect::set(&o, &"closeCode".into(), &code.into())?;
				Reflect::set(&o, &"reason".into(), &reason.into())?;
				Ok(o.into())
			}
			Err(e) => Err(js_error(e)),
		}
	}

	/// Diagnostics: RTT, handshake time, datagram and packet counters
	pub fn stats(&self) -> JsValue {
		let o = Object::new();
		let set = |k: &str, v: f64| {
			let _ = Reflect::set(&o, &k.into(), &v.into());
		};
		let s = &self.s;
		set("rttMs", s.quic.rtt().as_secs_f64() * 1000.0);
		set("handshakeMs", s.handshake_ms);
		set("datagramsSent", s.datagrams_sent.get() as f64);
		set("datagramsReceived", s.datagrams_received.get() as f64);
		set("packetsSent", s.stats.sent.load(std::sync::atomic::Ordering::Relaxed) as f64);
		set("packetsReceived", s.stats.received.load(std::sync::atomic::Ordering::Relaxed) as f64);
		set("bytesSent", s.stats.sent_bytes.load(std::sync::atomic::Ordering::Relaxed) as f64);
		set("bytesReceived", s.stats.received_bytes.load(std::sync::atomic::Ordering::Relaxed) as f64);
		set("mtu", s.quic.stats().path.current_mtu as f64);
		o.into()
	}
}
