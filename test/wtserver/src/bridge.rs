//! The /bridge route: a session whose bidirectional streams and datagrams
//! the host (test/wtserver.mjs) serves itself, for a relay written in
//! JavaScript (test/wisp-wt.mjs speaks Wisp on it as holyWisp's WebTransport
//! listener does). The host's function `bridge(kind, id, value)` hears:
//!
//!   protocol  id: 0; value: JSON (the protocols offered, in order), asked
//!             before the 200: the host answers the one to choose (a
//!             string among them), or anything else for the first
//!   session   id: the session's handle; value: JSON (path, fields,
//!             offered protocols, the protocol chosen, maxDatagram)
//!   bidi      id: the stream's handle; value: its session's handle
//!   data      id: a stream; value: the bytes (Uint8Array)
//!   written   id: a stream; value: the bytes of one write QUIC took
//!   fin       id: a stream, its peer finished it
//!   reset     id: a stream; value: why it failed (text)
//!   datagram  id: a session; value: the bytes after the quarter stream id
//!   closed    id: a session; value: JSON (code and reason of a close
//!             capsule, or cause)
//!
//! and answers through Server's bridge_* methods. Handles are numbers of
//! the module's own, unique across connections (every connection's first
//! session is stream 0).

use std::{
	cell::{Cell, RefCell},
	collections::HashMap,
	rc::Rc,
};

use futures_channel::mpsc;
use js_sys::{Function, Uint8Array};
use quinn::Connection;
use wasm_bindgen::JsValue;

use crate::h3::put_varint;

pub enum Cmd {
	Write(Vec<u8>),
	Finish,
	Reset(u32),
}

pub struct BridgeSession {
	pub conn: Connection,
	/// the session's quarter stream id, every datagram's prefix
	pub prefix: Vec<u8>,
	pub close: Box<dyn Fn(u32, String)>,
	/// opens a server bidirectional stream on the session: its handle
	pub open: Box<dyn Fn() -> u32>,
}

thread_local! {
	static BRIDGE: RefCell<Option<Function>> = const { RefCell::new(None) };
	static STREAMS: RefCell<HashMap<u32, mpsc::UnboundedSender<Cmd>>> = RefCell::new(HashMap::new());
	static SESSIONS: RefCell<HashMap<u32, Rc<BridgeSession>>> = RefCell::new(HashMap::new());
	static NEXT: Cell<u32> = const { Cell::new(1) };
}

pub fn set(f: Function) {
	BRIDGE.with(|b| *b.borrow_mut() = Some(f));
}

fn next() -> u32 {
	NEXT.with(|n| {
		let v = n.get();
		n.set(v + 1);
		v
	})
}

/// tells the host; never called with a borrow of the tables held, since the
/// host answers from inside the call
pub fn tell(kind: &str, id: u32, value: JsValue) {
	let f = BRIDGE.with(|b| b.borrow().clone());
	if let Some(f) = f {
		let _ = f.call3(&JsValue::NULL, &JsValue::from_str(kind), &JsValue::from(id), &value);
	}
}

/// asks the host, which answers from inside the call
pub fn ask(kind: &str, id: u32, value: JsValue) -> JsValue {
	let f = BRIDGE.with(|b| b.borrow().clone());
	match f {
		Some(f) => f
			.call3(&JsValue::NULL, &JsValue::from_str(kind), &JsValue::from(id), &value)
			.unwrap_or(JsValue::UNDEFINED),
		None => JsValue::UNDEFINED,
	}
}

pub fn bytes(b: &[u8]) -> JsValue {
	Uint8Array::from(b).into()
}

pub fn add_session(
	conn: Connection,
	session_id: u64,
	close: Box<dyn Fn(u32, String)>,
	open: Box<dyn Fn() -> u32>,
) -> u32 {
	let mut prefix = Vec::new();
	put_varint(&mut prefix, session_id / 4);
	let handle = next();
	SESSIONS.with(|s| s.borrow_mut().insert(handle, Rc::new(BridgeSession { conn, prefix, close, open })));
	handle
}

/// a server bidirectional stream opened on the session: its handle (what
/// is written on it waits until it is open), -1 when the session is gone
pub fn open_bidi(handle: u32) -> i64 {
	match session(handle) {
		Some(s) => (s.open)() as i64,
		None => -1,
	}
}

pub fn remove_session(handle: u32) {
	SESSIONS.with(|s| s.borrow_mut().remove(&handle));
}

fn session(handle: u32) -> Option<Rc<BridgeSession>> {
	SESSIONS.with(|s| s.borrow().get(&handle).cloned())
}

/// a stream's handle and what the host's commands for it arrive on
pub fn add_stream() -> (u32, mpsc::UnboundedReceiver<Cmd>) {
	let (tx, rx) = mpsc::unbounded();
	let handle = next();
	STREAMS.with(|s| s.borrow_mut().insert(handle, tx));
	(handle, rx)
}

pub fn remove_stream(handle: u32) {
	STREAMS.with(|s| s.borrow_mut().remove(&handle));
}

pub fn command(stream: u32, cmd: Cmd) {
	let tx = STREAMS.with(|s| s.borrow().get(&stream).cloned());
	if let Some(tx) = tx {
		let _ = tx.unbounded_send(cmd);
	}
}

/// the bytes a datagram of the session can carry (after its prefix), -1
/// when the connection takes none
pub fn max_datagram(handle: u32) -> i32 {
	let Some(s) = session(handle) else {
		return -1;
	};
	match s.conn.max_datagram_size() {
		Some(n) if n > s.prefix.len() => (n - s.prefix.len()) as i32,
		_ => -1,
	}
}

/// false when the datagram was not sent (too large, or the session is gone)
pub fn datagram(handle: u32, data: &[u8]) -> bool {
	let Some(s) = session(handle) else {
		return false;
	};
	let mut out = s.prefix.clone();
	out.extend_from_slice(data);
	s.conn.send_datagram(out.into()).is_ok()
}

pub fn close(handle: u32, code: u32, reason: String) {
	if let Some(s) = session(handle) {
		(s.close)(code, reason);
	}
}
