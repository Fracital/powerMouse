//! HTTP/3 and WebTransport draft 02 over one quinn connection, with the
//! routes of the Go fixture the webtransport suite was first measured with
//! (webtransport-go 0.13): /echo, /push, /close, /reset, /slow, /refuse.
//! What the server does on a close or a stream error follows webtransport-go:
//! a session that ends resets the send side and stops the receive side of
//! every stream still open in it with WEBTRANSPORT_SESSION_GONE.

use std::{
	cell::{Cell, RefCell},
	collections::{BTreeMap, HashMap},
	future::Future,
	net::SocketAddr,
	rc::Rc,
	time::Duration,
};

use futures_channel::oneshot;
use futures_util::{
	future::{self, Either, FutureExt, Shared},
	StreamExt,
};
use js_sys::Date;
use wasm_bindgen::JsValue;
use quinn::{Connection, ReadError, RecvStream, SendStream, VarInt, WriteError};
use wasm_bindgen_futures::spawn_local;

use crate::{
	bridge, emit,
	h3::{
		decode_fields, encode_fields, frame, get_varint, h3_to_wt, put_varint, wt_to_h3, FRAME_DATA, FRAME_HEADERS,
		FRAME_SETTINGS,
	},
	json::{self, Obj},
	runtime::sleep,
};

const STREAM_BIDI: u64 = 0x41;
const STREAM_UNI: u64 = 0x54;
const CAPSULE_CLOSE: u64 = 0x2843;
const SESSION_GONE: u64 = 0x170d7b68;
const BUFFERED_STREAM_REJECTED: u64 = 0x3994bd84;
const H3_NO_ERROR: u64 = 0x100;
const H3_STREAM_CREATION_ERROR: u64 = 0x103;
const H3_FRAME_UNEXPECTED: u64 = 0x105;
const H3_DATAGRAM_ERROR: u64 = 0x33;
const QPACK_DECOMPRESSION_FAILED: u64 = 0x200;

/// The server's SETTINGS, the set the Go fixture sends: H3_DATAGRAM,
/// ENABLE_CONNECT_PROTOCOL, ENABLE_WEBTRANSPORT (draft 02), the later
/// drafts' WT_ENABLED and WT_MAX_SESSIONS. No QPACK dynamic table.
const SETTINGS: [(u64, u64); 5] = [
	(0x33, 1),
	(0x08, 1),
	(0x2b603742, 1),
	(0x2c7cf000, 1),
	(0x14e9cd29, (1 << 62) - 1),
];

/// the subprotocols the server takes, in its order of preference
const PROTOCOLS: [&str; 2] = ["echo-v1", "echo-v2"];

fn vi(v: u64) -> VarInt {
	VarInt::from_u64(v).unwrap_or(VarInt::MAX)
}

#[derive(Default)]
struct Notify(RefCell<Vec<oneshot::Sender<()>>>);

impl Notify {
	fn wait(&self) -> oneshot::Receiver<()> {
		let (tx, rx) = oneshot::channel();
		self.0.borrow_mut().push(tx);
		rx
	}
	fn wake(&self) {
		for tx in self.0.borrow_mut().drain(..) {
			let _ = tx.send(());
		}
	}
}

fn read_error(e: &ReadError) -> (String, Option<u32>) {
	match e {
		ReadError::Reset(code) => match h3_to_wt(code.into_inner()) {
			Some(n) => (format!("stream canceled with error code {n}"), Some(n)),
			None => (format!("stream reset with error code 0x{:x}", code.into_inner()), None),
		},
		e => (e.to_string(), None),
	}
}

fn write_error(e: &WriteError) -> (String, Option<u32>) {
	match e {
		WriteError::Stopped(code) => match h3_to_wt(code.into_inner()) {
			Some(n) => (format!("stream canceled with error code {n}"), Some(n)),
			None => (format!("stream stopped with error code 0x{:x}", code.into_inner()), None),
		},
		e => (e.to_string(), None),
	}
}

/// A receive stream read through a buffer, so a varint can be parsed off its
/// front and what follows handed on.
struct Rd {
	s: RecvStream,
	buf: Vec<u8>,
	pos: usize,
	fin: bool,
}

impl Rd {
	fn new(s: RecvStream) -> Self {
		Self {
			s,
			buf: Vec::new(),
			pos: 0,
			fin: false,
		}
	}

	async fn more(&mut self) -> Result<bool, ReadError> {
		if self.fin {
			return Ok(false);
		}
		match self.s.read_chunk(65536, true).await? {
			Some(c) => {
				if self.pos > 0 {
					self.buf.drain(..self.pos);
					self.pos = 0;
				}
				self.buf.extend_from_slice(&c.bytes);
				Ok(true)
			}
			None => {
				self.fin = true;
				Ok(false)
			}
		}
	}

	async fn varint(&mut self) -> Result<Option<u64>, ReadError> {
		loop {
			if let Some((v, n)) = get_varint(&self.buf[self.pos..]) {
				self.pos += n;
				return Ok(Some(v));
			}
			if !self.more().await? {
				return Ok(None);
			}
		}
	}

	async fn bytes(&mut self, n: usize) -> Result<Option<Vec<u8>>, ReadError> {
		while self.buf.len() - self.pos < n {
			if !self.more().await? {
				return Ok(None);
			}
		}
		let v = self.buf[self.pos..self.pos + n].to_vec();
		self.pos += n;
		Ok(Some(v))
	}

	/// the next bytes, what was buffered first; None at the end
	async fn chunk(&mut self, max: usize) -> Result<Option<Vec<u8>>, ReadError> {
		if self.pos < self.buf.len() {
			let end = (self.pos + max).min(self.buf.len());
			let v = self.buf[self.pos..end].to_vec();
			self.pos = end;
			if self.pos == self.buf.len() {
				self.buf.clear();
				self.pos = 0;
			}
			return Ok(Some(v));
		}
		if self.fin {
			return Ok(None);
		}
		match self.s.read_chunk(max, true).await? {
			Some(c) => Ok(Some(c.bytes.to_vec())),
			None => {
				self.fin = true;
				Ok(None)
			}
		}
	}

	fn stop(&mut self, code: u64) {
		if !self.fin {
			let _ = self.s.stop(vi(code));
		}
	}
}

struct Conn {
	conn: Connection,
	remote: SocketAddr,
	settings: RefCell<Option<Vec<(u64, u64)>>>,
	settings_ready: Notify,
	/// sessions by id; None once one has ended (its streams are refused)
	sessions: RefCell<HashMap<u64, Option<Rc<Session>>>>,
	sessions_changed: Notify,
	/// the control stream stays open as long as the connection
	control: RefCell<Option<SendStream>>,
}

impl Conn {
	async fn session(&self, id: u64) -> Option<Rc<Session>> {
		let mut timeout = sleep(Duration::from_secs(5));
		loop {
			if let Some(entry) = self.sessions.borrow().get(&id) {
				return entry.clone();
			}
			let rx = self.sessions_changed.wait();
			if let Either::Right(_) = future::select(rx, &mut timeout).await {
				return None;
			}
		}
	}

	async fn wait_settings(&self, ms: f64) -> Option<Vec<(u64, u64)>> {
		let mut timeout = sleep(Duration::from_secs_f64(ms / 1000.0));
		loop {
			if let Some(s) = self.settings.borrow().as_ref() {
				return Some(s.clone());
			}
			let rx = self.settings_ready.wait();
			if let Either::Right(_) = future::select(rx, &mut timeout).await {
				return None;
			}
		}
	}
}

pub async fn serve(conn: Connection) {
	let c = Rc::new(Conn {
		remote: conn.remote_address(),
		conn: conn.clone(),
		settings: RefCell::new(None),
		settings_ready: Notify::default(),
		sessions: RefCell::new(HashMap::new()),
		sessions_changed: Notify::default(),
		control: RefCell::new(None),
	});
	if let Ok(mut s) = conn.open_uni().await {
		let mut payload = Vec::new();
		for (id, v) in SETTINGS {
			put_varint(&mut payload, id);
			put_varint(&mut payload, v);
		}
		let mut out = vec![0x00];
		out.extend(frame(FRAME_SETTINGS, &payload));
		let _ = s.write_all(&out).await;
		*c.control.borrow_mut() = Some(s);
	}
	spawn_local(uni_loop(c.clone()));
	spawn_local(datagram_loop(c.clone()));
	// how the connection ended, for the measurements of what Chrome sends
	// after a close (no path: the suites' per-run event lists leave it out)
	let watched = conn.clone();
	spawn_local(async move {
		let e = watched.closed().await;
		emit(
			Obj::new()
				.s("event", "connection")
				.s("error", &e.to_string())
				.s("debug", &format!("{e:?}"))
				.raw("at", format!("{}", Date::now()))
				.done(),
		);
	});
	while let Ok((send, recv)) = conn.accept_bi().await {
		spawn_local(bidi(c.clone(), send, recv));
	}
	c.control.borrow_mut().take();
}

async fn uni_loop(c: Rc<Conn>) {
	while let Ok(recv) = c.conn.accept_uni().await {
		spawn_local(uni(c.clone(), recv));
	}
}

async fn uni(c: Rc<Conn>, recv: RecvStream) {
	let mut rd = Rd::new(recv);
	let Ok(Some(ty)) = rd.varint().await else {
		return;
	};
	match ty {
		0x00 => control(c, rd).await,
		// the peer's QPACK encoder and decoder streams: nothing to do with
		// them while the server offers no dynamic table
		0x02 | 0x03 => while let Ok(Some(_)) = rd.chunk(65536).await {},
		STREAM_UNI => {
			let Ok(Some(id)) = rd.varint().await else {
				return;
			};
			match c.session(id).await {
				Some(s) => s.uni(rd).await,
				None => rd.stop(BUFFERED_STREAM_REJECTED),
			}
		}
		_ => rd.stop(H3_STREAM_CREATION_ERROR),
	}
}

async fn control(c: Rc<Conn>, mut rd: Rd) {
	loop {
		let Ok(Some(ty)) = rd.varint().await else {
			return;
		};
		let Ok(Some(len)) = rd.varint().await else {
			return;
		};
		let Ok(Some(payload)) = rd.bytes(len.min(1 << 20) as usize).await else {
			return;
		};
		if ty == FRAME_SETTINGS && c.settings.borrow().is_none() {
			let mut list = Vec::new();
			let mut rest = &payload[..];
			while let Some((id, a)) = get_varint(rest) {
				let Some((v, b)) = get_varint(&rest[a..]) else {
					break;
				};
				list.push((id, v));
				rest = &rest[a + b..];
			}
			*c.settings.borrow_mut() = Some(list);
			c.settings_ready.wake();
		}
	}
}

async fn datagram_loop(c: Rc<Conn>) {
	while let Ok(d) = c.conn.read_datagram().await {
		let Some((quarter, _)) = get_varint(&d) else {
			continue;
		};
		let Some(id) = quarter.checked_mul(4) else {
			continue;
		};
		let session = c.sessions.borrow().get(&id).cloned().flatten();
		if let Some(s) = session {
			if s.route == Route::Bridge {
				let start = get_varint(&d).map(|(_, n)| n).unwrap_or(0);
				bridge::tell("datagram", s.bridge.get(), bridge::bytes(&d[start..]));
				continue;
			}
			// what the Go fixture echoes: the datagram back, under the same
			// quarter stream id; /reset and /slow read none
			if !s.ended.get() && s.route.echoes() {
				let _ = c.conn.send_datagram(d);
			}
		}
	}
}

async fn bidi(c: Rc<Conn>, mut send: SendStream, recv: RecvStream) {
	let id = u64::from(recv.id());
	let mut rd = Rd::new(recv);
	let Ok(Some(ty)) = rd.varint().await else {
		return;
	};
	match ty {
		STREAM_BIDI => {
			let Ok(Some(session)) = rd.varint().await else {
				return;
			};
			match c.session(session).await {
				Some(s) => s.bidi(send, rd).await,
				None => {
					let _ = send.reset(vi(BUFFERED_STREAM_REJECTED));
					rd.stop(BUFFERED_STREAM_REJECTED);
				}
			}
		}
		FRAME_HEADERS => request(c, id, send, rd).await,
		_ => {
			let _ = send.reset(vi(H3_FRAME_UNEXPECTED));
			rd.stop(H3_FRAME_UNEXPECTED);
		}
	}
}

/// Parameters of a query string, decoded as Go's url.ParseQuery does.
fn query(path: &str) -> Vec<(String, String)> {
	let Some((_, q)) = path.split_once('?') else {
		return Vec::new();
	};
	fn unescape(s: &str) -> String {
		let b = s.as_bytes();
		let mut out = Vec::with_capacity(b.len());
		let mut i = 0;
		while i < b.len() {
			match b[i] {
				b'+' => out.push(b' '),
				b'%' if i + 2 < b.len() => {
					match s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()).ok_or(()) {
						Ok(v) => {
							out.push(v);
							i += 2;
						}
						Err(_) => out.push(b'%'),
					}
				}
				c => out.push(c),
			}
			i += 1;
		}
		String::from_utf8_lossy(&out).into_owned()
	}
	q.split(['&', ';'])
		.filter(|p| !p.is_empty())
		.map(|p| {
			let (k, v) = p.split_once('=').unwrap_or((p, ""));
			(unescape(k), unescape(v))
		})
		.collect()
}

/// Go's textproto.CanonicalMIMEHeaderKey, for the /push report
fn canonical(name: &str) -> String {
	if !name.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)) {
		return name.to_string();
	}
	let mut upper = true;
	name.chars()
		.map(|c| {
			let out = if upper { c.to_ascii_uppercase() } else { c.to_ascii_lowercase() };
			upper = c == '-';
			out
		})
		.collect()
}

/// the strings of a structured-field list (RFC 8941), None when it is not a
/// list of strings
fn sf_strings(value: &str) -> Option<Vec<String>> {
	let b = value.as_bytes();
	let mut i = 0;
	let mut out = Vec::new();
	let ows = |i: &mut usize| {
		while *i < b.len() && (b[*i] == b' ' || b[*i] == b'\t') {
			*i += 1;
		}
	};
	let sp = |i: &mut usize| {
		while *i < b.len() && b[*i] == b' ' {
			*i += 1;
		}
	};
	sp(&mut i);
	if i == b.len() {
		return Some(out);
	}
	loop {
		if b.get(i) != Some(&b'"') {
			return None;
		}
		i += 1;
		let mut s = String::new();
		loop {
			match *b.get(i)? {
				b'\\' => {
					let c = *b.get(i + 1)?;
					if c != b'"' && c != b'\\' {
						return None;
					}
					s.push(c as char);
					i += 2;
				}
				b'"' => {
					i += 1;
					break;
				}
				c if (0x20..0x7f).contains(&c) => {
					s.push(c as char);
					i += 1;
				}
				_ => return None,
			}
		}
		// parameters: `;key` or `;key=bare-item`, skipped
		while b.get(i) == Some(&b';') {
			i += 1;
			sp(&mut i);
			let start = i;
			while i < b.len() && (b[i].is_ascii_lowercase() || b[i].is_ascii_digit() || b"_-.*".contains(&b[i])) {
				i += 1;
			}
			if i == start {
				return None;
			}
			if b.get(i) == Some(&b'=') {
				i += 1;
				while i < b.len() && !b",; \t".contains(&b[i]) {
					i += 1;
				}
			}
		}
		out.push(s);
		ows(&mut i);
		if i == b.len() {
			return Some(out);
		}
		if b[i] != b',' {
			return None;
		}
		i += 1;
		ows(&mut i);
		if i == b.len() {
			return None;
		}
	}
}

fn sf_string(s: &str) -> String {
	let mut out = String::from("\"");
	for c in s.chars() {
		if c == '"' || c == '\\' {
			out.push('\\');
		}
		out.push(c);
	}
	out.push('"');
	out
}

async fn respond(send: &mut SendStream, rd: &mut Rd, fields: &[(&str, &str)], body: &[u8]) {
	let mut out = frame(FRAME_HEADERS, &encode_fields(fields));
	if !body.is_empty() {
		out.extend(frame(FRAME_DATA, body));
	}
	let _ = send.write_all(&out).await;
	let _ = send.finish();
	rd.stop(H3_NO_ERROR);
}

async fn request(c: Rc<Conn>, id: u64, mut send: SendStream, mut rd: Rd) {
	let Ok(Some(len)) = rd.varint().await else {
		return;
	};
	let Ok(Some(block)) = rd.bytes(len.min(1 << 20) as usize).await else {
		return;
	};
	let Some(fields) = decode_fields(&block) else {
		c.conn.close(vi(QPACK_DECOMPRESSION_FAILED), b"");
		return;
	};
	let get = |name: &str| {
		fields
			.iter()
			.find(|(k, _)| k == name)
			.map(|(_, v)| v.clone())
			.unwrap_or_default()
	};
	let (method, path, authority, protocol, scheme) =
		(get(":method"), get(":path"), get(":authority"), get(":protocol"), get(":scheme"));
	// every request, whatever its route, with the status it is answered
	// (so a suite can tell a session the server never heard of from one it
	// refused)
	let request_event = |status: u16| {
		emit(
			Obj::new()
				.s("event", "request")
				.s("path", &path)
				.s("method", &method)
				.s("protocol", &protocol)
				.s("authority", &authority)
				.n("status", status as u64)
				.done(),
		)
	};
	let route = match path.split('?').next().unwrap_or("") {
		"/echo" => Route::Echo,
		"/push" => Route::Push,
		"/close" => Route::Close,
		"/reset" => Route::Reset,
		"/slow" => Route::Slow,
		"/bridge" => Route::Bridge,
		"/refuse" => {
			request_event(403);
			emit(
				Obj::new()
					.s("event", "refused")
					.s("path", &path)
					.s("protocol", &protocol)
					.done(),
			);
			respond(&mut send, &mut rd, &[(":status", "403")], b"").await;
			return;
		}
		_ => {
			request_event(404);
			respond(
				&mut send,
				&mut rd,
				&[
					(":status", "404"),
					("content-type", "text/plain; charset=utf-8"),
					("x-content-type-options", "nosniff"),
				],
				b"404 page not found\n",
			)
			.await;
			return;
		}
	};
	let fields_json = json::array(
		fields
			.iter()
			.map(|(k, v)| json::array([json::string(k), json::string(v)])),
	);
	let event = Obj::new()
		.s("event", "connect")
		.s("path", &path)
		.s("method", &method)
		.s("authority", &authority)
		.s("protocol", &protocol)
		.s("scheme", &scheme)
		.raw("fields", fields_json.clone());
	// the client's SETTINGS, which the Go fixture waits for too
	let settings = c.wait_settings(5000.0).await;
	let event = event.raw(
		"settings",
		match &settings {
			Some(list) => json::array(
				list.iter()
					.map(|(id, v)| json::array([json::string(&format!("0x{id:x}")), json::number(*v)])),
			),
			None => "null".into(),
		},
	);
	let event = event.s("remote", &c.remote.to_string());
	let refusal = if method != "CONNECT" || (protocol != "webtransport" && protocol != "webtransport-h3") {
		Some("not a WebTransport CONNECT")
	} else {
		match &settings {
			None => Some("webtransport: didn't receive the client's SETTINGS on time"),
			Some(list) if !list.iter().any(|&(id, v)| (id == 0x33 || id == 0xffd277) && v == 1) => {
				Some("webtransport: missing datagram support")
			}
			_ => None,
		}
	};
	if let Some(why) = refusal {
		request_event(500);
		emit(event.s("upgradeError", why).done());
		respond(&mut send, &mut rd, &[(":status", "500")], b"").await;
		return;
	}
	// the first of the client's protocols the server takes
	let offered = fields
		.iter()
		.filter(|(k, _)| k == "wt-available-protocols")
		.map(|(_, v)| v.as_str())
		.collect::<Vec<_>>()
		.join(", ");
	let offered_list = sf_strings(&offered).unwrap_or_default();
	// /bridge takes the first protocol offered, as holyWisp's listener does
	let selected = offered_list
		.iter()
		.find(|p| route == Route::Bridge || PROTOCOLS.contains(&p.as_str()))
		.cloned();

	let (gone_tx, gone_rx) = oneshot::channel();
	let session = Rc::new(Session {
		id,
		query: query(&path),
		path: path.clone(),
		route,
		conn: c.conn.clone(),
		send: RefCell::new(None),
		ended: Cell::new(false),
		cause: RefCell::new(String::new()),
		gone_tx: RefCell::new(Some(gone_tx)),
		gone: gone_rx.shared(),
		bridge: Cell::new(0),
		closed_at: Cell::new(0.0),
	});
	c.sessions.borrow_mut().insert(id, Some(session.clone()));
	c.sessions_changed.wake();

	// ?wtp= answers with that wt-protocol value as it is (empty: none), and
	// each ?resp=name:value adds a field to the answer, for the
	// measurements of which answers Chrome takes
	let wt_protocol = match session.param("wtp") {
		Some(v) if v.is_empty() => None,
		Some(v) => Some(v),
		None => selected.as_deref().map(sf_string),
	};
	let extra: Vec<(String, String)> = session
		.query
		.iter()
		.filter(|(k, _)| k == "resp")
		.filter_map(|(_, v)| v.split_once(':').map(|(a, b)| (a.to_string(), b.to_string())))
		.collect();
	let mut response = vec![(":status", "200")];
	if let Some(p) = &wt_protocol {
		response.push(("wt-protocol", p.as_str()));
	}
	for (k, v) in &extra {
		response.push((k.as_str(), v.as_str()));
	}
	request_event(200);
	let _ = send.write_all(&frame(FRAME_HEADERS, &encode_fields(&response))).await;
	*session.send.borrow_mut() = Some(send);
	let event = match &selected {
		Some(p) => event.s("wtProtocol", p),
		None => event,
	};
	emit(event.done());

	if route == Route::Bridge {
		let weak = Rc::downgrade(&session);
		let handle = bridge::add_session(
			c.conn.clone(),
			id,
			Box::new(move |code, reason| {
				if let Some(s) = weak.upgrade() {
					s.close_local(code, reason, false);
				}
			}),
		);
		session.bridge.set(handle);
		let info = Obj::new()
			.s("path", &path)
			.raw("fields", fields_json.clone())
			.raw("offered", json::array(offered_list.iter().map(|p| json::string(p))))
			.raw(
				"protocol",
				match &selected {
					Some(p) => json::string(p),
					None => "null".into(),
				},
			)
			.raw(
				"maxDatagram",
				format!("{}", bridge::max_datagram(handle)),
			)
			.done();
		bridge::tell("session", handle, JsValue::from_str(&info));
	}

	match route {
		Route::Push => {
			// what the Go fixture reported: its header map (canonical names,
			// sorted, values in order) and the request's host, path and
			// protocol; plus the fields as they came, in order
			let mut headers: BTreeMap<String, Vec<String>> = BTreeMap::new();
			for (k, v) in fields.iter().filter(|(k, _)| !k.starts_with(':')) {
				headers.entry(canonical(k)).or_default().push(json::string(v));
			}
			let mut map = Obj::new();
			for (k, v) in headers {
				map = map.raw(&k, json::array(v));
			}
			let report = Obj::new()
				.raw("fields", fields_json)
				.raw("headers", map.done())
				.s("host", &authority)
				.s("path", &path)
				.s("proto", &protocol)
				.done();
			spawn_local(session.clone().push(report));
		}
		Route::Close => {
			let code = session.param("code").and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
			let reason = session.param("reason").unwrap_or_default();
			let after = session.param("after").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
			let gone = session.param("style").as_deref() == Some("gone");
			if after <= 0 {
				// right behind the response, as the Go fixture's goroutine
				session.close_local(code, reason, gone);
			} else {
				let s = session.clone();
				spawn_local(async move {
					if let Either::Left(_) = future::select(sleep(Duration::from_millis(after as u64)), s.gone()).await {
						s.close_local(code, reason, gone);
					}
				});
			}
		}
		_ => {}
	}

	// the CONNECT stream: capsules until the session ends
	let outcome = match future::select(Box::pin(read_capsules(&mut rd)), session.gone()).await {
		Either::Left((end, _)) => Some(end),
		Either::Right(_) => None,
	};
	match outcome {
		Some(end) => {
			let (closed, connect_code, cause) = match end.clone() {
				End::Close(code, reason) => (
					Obj::new()
						.s("event", "closed")
						.s("path", &path)
						.s("cause", &reason)
						.n("code", code as u64)
						.s("reason", &reason)
						.b("remote", true),
					SESSION_GONE,
					reason,
				),
				End::Lost(cause) => (
					Obj::new().s("event", "closed").s("path", &path).s("cause", &cause),
					H3_DATAGRAM_ERROR,
					cause,
				),
			};
			// what ended the CONNECT stream, as JSON: the peer's capsule, a FIN
			// ("EOF") or a reset
			let seen = match &end {
				End::Close(code, reason) => Obj::new().n("code", *code as u64).s("reason", reason).done(),
				End::Lost(cause) => Obj::new().s("cause", cause).done(),
			};
			// (after a close of the server's own, the session has ended
			// already: this is the peer's answer to it)
			if session.ended.get() && session.observe() {
				emit(
					Obj::new()
						.s("event", "answer")
						.s("path", &path)
						.s("on", "connect stream")
						.raw("seen", seen.clone())
						.raw("ms", session.since_close())
						.done(),
				);
			}
			if session.route == Route::Bridge {
				bridge::tell("closed", session.bridge.get(), JsValue::from_str(&seen));
				bridge::remove_session(session.bridge.get());
			}
			if session.end(cause) {
				if let Some(s) = session.send.borrow_mut().as_mut() {
					let _ = s.reset(vi(connect_code));
				}
				rd.stop(connect_code);
				emit(closed.done());
			}
			session.release();
		}
		None => {
			// closed here with style=gone: stop reading
			rd.stop(SESSION_GONE);
		}
	}
	c.sessions.borrow_mut().insert(id, None);
}

fn tick() -> crate::runtime::Sleep {
	sleep(Duration::ZERO)
}

/// A stream of a session that ended, taken down as webtransport-go does,
/// STOP_SENDING and RESET_STREAM with WEBTRANSPORT_SESSION_GONE, the stop in
/// an earlier packet: Chrome that hears the reset first closes the stream
/// before the stop reaches the page's writer ("The stream was aborted by the
/// remote server" where the Go fixture's page mostly reads "Received
/// STOP_SENDING.").
async fn teardown(send: &mut SendStream, rd: &mut Rd) {
	rd.stop(SESSION_GONE);
	tick().await;
	let _ = send.reset(vi(SESSION_GONE));
}

#[derive(Clone)]
enum End {
	Close(u32, String),
	Lost(String),
}

async fn read_capsules(rd: &mut Rd) -> End {
	let mut capsules: Vec<u8> = Vec::new();
	loop {
		let ty = match rd.varint().await {
			Ok(Some(t)) => t,
			Ok(None) => return End::Lost("EOF".into()),
			Err(e) => return End::Lost(read_error(&e).0),
		};
		let len = match rd.varint().await {
			Ok(Some(l)) => l,
			Ok(None) => return End::Lost("EOF".into()),
			Err(e) => return End::Lost(read_error(&e).0),
		};
		let payload = match rd.bytes(len.min(1 << 20) as usize).await {
			Ok(Some(p)) => p,
			Ok(None) => return End::Lost("EOF".into()),
			Err(e) => return End::Lost(read_error(&e).0),
		};
		if ty != FRAME_DATA {
			continue;
		}
		capsules.extend(payload);
		loop {
			let Some((cty, a)) = get_varint(&capsules) else {
				break;
			};
			let Some((clen, b)) = get_varint(&capsules[a..]) else {
				break;
			};
			let start = a + b;
			let end = start + clen as usize;
			if capsules.len() < end {
				break;
			}
			if cty == CAPSULE_CLOSE {
				if clen < 4 {
					return End::Lost("invalid CLOSE_WEBTRANSPORT_SESSION capsule".into());
				}
				let code = u32::from_be_bytes(capsules[start..start + 4].try_into().unwrap());
				let reason = String::from_utf8_lossy(&capsules[start + 4..end]).into_owned();
				return End::Close(code, reason);
			}
			capsules.drain(..end);
		}
	}
}

#[derive(Clone, Copy, PartialEq)]
enum Route {
	Echo,
	Push,
	Close,
	Reset,
	Slow,
	Bridge,
}

impl Route {
	/// the routes that echo streams and datagrams
	fn echoes(self) -> bool {
		matches!(self, Route::Echo | Route::Push | Route::Close)
	}
}

struct Session {
	id: u64,
	path: String,
	route: Route,
	query: Vec<(String, String)>,
	conn: Connection,
	/// the CONNECT stream's send side (the response went out on it)
	send: RefCell<Option<SendStream>>,
	ended: Cell<bool>,
	cause: RefCell<String>,
	gone_tx: RefCell<Option<oneshot::Sender<()>>>,
	gone: Shared<oneshot::Receiver<()>>,
	/// the session's handle on the host's side (/bridge), else 0
	bridge: Cell<u32>,
	/// when the server closed the session (Date.now()), else 0
	closed_at: Cell<f64>,
}

impl Session {
	fn gone(&self) -> Shared<oneshot::Receiver<()>> {
		self.gone.clone()
	}

	fn param(&self, key: &str) -> Option<String> {
		self.query.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
	}

	/// ?observe=1: say what the peer does after the server's close (the
	/// "answer" events), for the measurements in docs/webtransport.md
	fn observe(&self) -> bool {
		self.param("observe").is_some()
	}

	/// ms since the server's close, as a JSON number (null before it)
	fn since_close(&self) -> String {
		match self.closed_at.get() {
			t if t > 0.0 => format!("{}", Date::now() - t),
			_ => "null".into(),
		}
	}

	/// the first call ends the session (and says so)
	fn end(&self, cause: String) -> bool {
		if self.ended.replace(true) {
			return false;
		}
		*self.cause.borrow_mut() = cause;
		true
	}

	/// every stream task still running hears `gone` and takes its stream
	/// down (teardown)
	fn release(&self) {
		if let Some(tx) = self.gone_tx.borrow_mut().take() {
			let _ = tx.send(());
		}
	}

	/// `f`'s output, None if the session ended first
	async fn until_gone<F: Future>(&self, f: F) -> Option<F::Output> {
		match future::select(Box::pin(f), self.gone()).await {
			Either::Left((out, _)) => Some(out),
			Either::Right(_) => None,
		}
	}

	fn header(&self, ty: u64) -> Vec<u8> {
		let mut out = Vec::new();
		put_varint(&mut out, ty);
		put_varint(&mut out, self.id);
		out
	}

	/// The server closes the session: CLOSE_WEBTRANSPORT_SESSION, then FIN.
	/// By default that is all (the data streams are left as they are, and
	/// the CONNECT stream is still read: the page reads the code and reason,
	/// and its open streams fail with "The session is closed."). With `gone`
	/// (/close?style=gone) first every open stream is taken down as
	/// webtransport-go does (teardown), and the CONNECT stream is stopped.
	fn close_local(self: &Rc<Self>, code: u32, reason: String, gone: bool) {
		if !self.end(reason.clone()) {
			return;
		}
		self.closed_at.set(Date::now());
		if gone {
			self.release();
		}
		let mut capsule = Vec::new();
		put_varint(&mut capsule, CAPSULE_CLOSE);
		put_varint(&mut capsule, 4 + reason.len() as u64);
		capsule.extend(code.to_be_bytes());
		capsule.extend(reason.as_bytes());
		let data = frame(FRAME_DATA, &capsule);
		let s = self.clone();
		spawn_local(async move {
			if gone {
				// after the session's streams are taken down (teardown)
				tick().await;
				tick().await;
			}
			let send = s.send.borrow_mut().take();
			if let Some(mut send) = send {
				if send.write_all(&data).await.is_err() {
					let _ = send.reset(vi(SESSION_GONE));
				}
				let _ = send.finish();
				if s.observe() {
					// a STOP_SENDING of the peer's on the CONNECT stream, or
					// every byte of it (capsule and FIN) acknowledged
					let stopped = send.stopped();
					let o = s.clone();
					spawn_local(async move {
						let seen = match stopped.await {
							Ok(Some(code)) => Obj::new().s("stopSending", &format!("0x{:x}", code.into_inner())).done(),
							Ok(None) => Obj::new().b("acked", true).done(),
							Err(e) => Obj::new().s("error", &e.to_string()).done(),
						};
						emit(
							Obj::new()
								.s("event", "answer")
								.s("path", &o.path)
								.s("on", "connect send side")
								.raw("seen", seen)
								.raw("ms", o.since_close())
								.done(),
						);
						drop(send);
					});
				}
			}
			emit(
				Obj::new()
					.s("event", "closed")
					.s("path", &s.path)
					.s("cause", &reason)
					.n("code", code as u64)
					.s("reason", &reason)
					.b("remote", false)
					.done(),
			);
		});
	}

	async fn bidi(self: Rc<Self>, send: SendStream, rd: Rd) {
		match self.route {
			Route::Echo | Route::Push | Route::Close => self.echo_bidi(send, rd).await,
			Route::Reset => self.reset_bidi(send, rd).await,
			Route::Slow => self.slow_bidi(send, rd).await,
			Route::Bridge => self.bridge_bidi(send, rd).await,
		}
	}

	async fn uni(self: Rc<Self>, mut rd: Rd) {
		match self.route {
			Route::Echo | Route::Push | Route::Close => self.echo_uni(rd).await,
			Route::Reset => {
				// after the first byte, stop sending with ?stop= (0 if absent)
				let stop = self.param("stop").and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
				match self.until_gone(rd.bytes(1)).await {
					Some(_) => rd.stop(wt_to_h3(stop)),
					None => rd.stop(SESSION_GONE),
				}
			}
			// never accepted: left unread until the session ends
			Route::Slow | Route::Bridge => {
				let _ = self.gone().await;
				rd.stop(SESSION_GONE);
			}
		}
	}

	fn stream_event(&self, kind: &str, bytes: u64) -> Obj {
		Obj::new().s("event", kind).s("path", &self.path).n("bytes", bytes)
	}

	/// /bridge: the stream is the host's (bridge.rs). What arrives is told
	/// to it as it arrives; what it writes goes out in order, until it
	/// finishes or resets the stream or the session ends.
	async fn bridge_bidi(self: Rc<Self>, mut send: SendStream, mut rd: Rd) {
		let (handle, mut rx) = bridge::add_stream();
		bridge::tell("bidi", handle, JsValue::from(self.bridge.get()));
		let gone = self.gone();
		spawn_local(async move {
			loop {
				match future::select(rx.next(), gone.clone()).await {
					Either::Left((Some(bridge::Cmd::Write(b)), _)) => {
						if send.write_all(&b).await.is_err() {
							break;
						}
					}
					Either::Left((Some(bridge::Cmd::Finish), _)) => {
						let _ = send.finish();
						break;
					}
					Either::Left((Some(bridge::Cmd::Reset(code)), _)) => {
						let _ = send.reset(vi(wt_to_h3(code)));
						break;
					}
					Either::Left((None, _)) => break,
					Either::Right(_) => {
						let _ = send.reset(vi(SESSION_GONE));
						break;
					}
				}
			}
			bridge::remove_stream(handle);
		});
		loop {
			match self.until_gone(rd.chunk(65536)).await {
				Some(Ok(Some(b))) => bridge::tell("data", handle, bridge::bytes(&b)),
				Some(Ok(None)) => {
					bridge::tell("fin", handle, JsValue::NULL);
					break;
				}
				Some(Err(e)) => {
					bridge::tell("reset", handle, JsValue::from_str(&read_error(&e).0));
					break;
				}
				None => {
					rd.stop(SESSION_GONE);
					bridge::tell("reset", handle, JsValue::from_str("the session ended"));
					break;
				}
			}
		}
	}

	async fn echo_bidi(self: Rc<Self>, mut send: SendStream, mut rd: Rd) {
		enum Fail {
			Read(ReadError),
			Write(WriteError),
		}
		let mut n = 0u64;
		let out = self
			.until_gone(async {
				loop {
					match rd.chunk(32 * 1024).await {
						Ok(Some(b)) => {
							if let Err(e) = send.write_all(&b).await {
								return Some(Fail::Write(e));
							}
							n += b.len() as u64;
						}
						Ok(None) => return None,
						Err(e) => return Some(Fail::Read(e)),
					}
				}
			})
			.await;
		let event = self.stream_event("bidi", n);
		match out {
			Some(None) => {
				let _ = send.finish();
				emit(event.done());
			}
			Some(Some(Fail::Read(e))) => {
				let (text, code) = read_error(&e);
				let event = event.s("error", &text);
				emit(match code {
					Some(c) => event.n("code", c as u64).b("remoteError", true).done(),
					None => event.done(),
				});
				let _ = send.finish();
			}
			Some(Some(Fail::Write(e))) => {
				let (text, code) = write_error(&e);
				let event = event.s("error", &text);
				emit(match code {
					Some(c) => event.n("code", c as u64).b("remoteError", true).done(),
					None => event.done(),
				});
				// a stopped stream is reset with the peer's code (as quic-go
				// does); the receive side stays open until the session ends
				if let WriteError::Stopped(code) = e {
					let _ = send.reset(code);
				}
				let _ = self.gone().await;
				rd.stop(SESSION_GONE);
			}
			None => {
				teardown(&mut send, &mut rd).await;
				emit(event.s("error", &self.cause.borrow()).done());
			}
		}
	}

	async fn echo_uni(self: Rc<Self>, mut rd: Rd) {
		let mut data = Vec::new();
		let out = self
			.until_gone(async {
				loop {
					match rd.chunk(65536).await {
						Ok(Some(b)) => data.extend(b),
						Ok(None) => return Ok(()),
						Err(e) => return Err(e),
					}
				}
			})
			.await;
		let event = self.stream_event("uni", data.len() as u64);
		match out {
			Some(Ok(())) => {
				emit(event.done());
				if self.ended.get() {
					return;
				}
				// echoed on a new stream of the server's
				let Some(Ok(mut s)) = self.until_gone(self.conn.open_uni()).await else {
					return;
				};
				let mut out = self.header(STREAM_UNI);
				out.extend(data);
				match self.until_gone(s.write_all(&out)).await {
					Some(_) => {
						let _ = s.finish();
					}
					None => {
						let _ = s.reset(vi(SESSION_GONE));
					}
				}
			}
			Some(Err(e)) => {
				let (text, code) = read_error(&e);
				let event = event.s("error", &text);
				emit(match code {
					Some(c) => event.n("code", c as u64).done(),
					None => event.done(),
				});
			}
			None => {
				rd.stop(SESSION_GONE);
				emit(event.s("error", &self.cause.borrow()).done());
			}
		}
	}

	async fn reset_bidi(self: Rc<Self>, mut send: SendStream, mut rd: Rd) {
		let reset = self.param("reset").map(|v| v.parse::<u32>().unwrap_or(0));
		let stop = self.param("stop").map(|v| v.parse::<u32>().unwrap_or(0));
		let event = Obj::new().s("event", "reset").s("path", &self.path).done();
		if self.until_gone(rd.bytes(1)).await.is_none() {
			teardown(&mut send, &mut rd).await;
			emit(event);
			return;
		}
		// the stop in an earlier packet than the reset: Chrome that hears the
		// reset first closes the stream before the stop reaches the page's
		// writer (the Go fixture does either, by chance)
		if let Some(code) = stop {
			rd.stop(wt_to_h3(code));
			if reset.is_some() {
				tick().await;
			}
		}
		if let Some(code) = reset {
			let _ = send.reset(vi(wt_to_h3(code)));
		}
		emit(event);
		// what was left open stays open until the session ends
		let _ = self.gone().await;
		if stop.is_none() {
			rd.stop(SESSION_GONE);
			tick().await;
		}
		if reset.is_none() {
			let _ = send.reset(vi(SESSION_GONE));
		}
	}

	async fn slow_bidi(self: Rc<Self>, mut send: SendStream, mut rd: Rd) {
		let delay = self.param("delay").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
		let counted = self
			.until_gone(async {
				sleep(Duration::from_millis(delay.max(0) as u64)).await;
				let mut n = 0u64;
				while let Ok(Some(b)) = rd.chunk(65536).await {
					n += b.len() as u64;
				}
				n
			})
			.await;
		let Some(n) = counted else {
			teardown(&mut send, &mut rd).await;
			return;
		};
		match self.until_gone(send.write_all(n.to_string().as_bytes())).await {
			Some(_) => {
				let _ = send.finish();
			}
			None => {
				let _ = send.reset(vi(SESSION_GONE));
			}
		}
	}

	/// /push: a uni stream with the report, then a bidi stream that says
	/// "server bidi", echoes one read and finishes
	async fn push(self: Rc<Self>, report: String) {
		let Some(Ok(mut uni)) = self.until_gone(self.conn.open_uni()).await else {
			return;
		};
		let mut out = self.header(STREAM_UNI);
		out.extend(report.as_bytes());
		if self.until_gone(uni.write_all(&out)).await.is_none() {
			let _ = uni.reset(vi(SESSION_GONE));
			return;
		}
		let _ = uni.finish();
		let Some(Ok((mut send, recv))) = self.until_gone(self.conn.open_bi()).await else {
			return;
		};
		let mut rd = Rd::new(recv);
		let mut out = self.header(STREAM_BIDI);
		out.extend(b"server bidi");
		let wrote = self.until_gone(send.write_all(&out)).await;
		let got = match wrote {
			Some(_) => self.until_gone(rd.chunk(4096)).await,
			None => None,
		};
		let Some(got) = got else {
			teardown(&mut send, &mut rd).await;
			return;
		};
		if let Ok(Some(b)) = got {
			if self.until_gone(send.write_all(&b)).await.is_none() {
				teardown(&mut send, &mut rd).await;
				return;
			}
		}
		let _ = send.finish();
		let _ = self.gone().await;
		rd.stop(SESSION_GONE);
	}
}
