//! The WebRTC stack's wasm boundary (docs/webrtc-over-wisp.md, section 4):
//! str0m driven sans-IO by a host that owns the sockets (wisp streams) and
//! the clock. The host feeds records in and drains records out; nothing
//! here does I/O, spawns or sleeps.
//!
//! The ABI is byte buffers and single-letter names, hand written rather than
//! wasm-bindgen's, so the artifact survives a host's renaming and same-length
//! substitution of its names and needs no glue of its own:
//!
//! - `a(len) -> ptr` gives the host `len` bytes to write into; `f(ptr, len)`
//!   gives them back when the host does not pass them on.
//! - `c(ptr, len) -> id` makes a connection from a configuration record
//!   (owned from then on); a negative id is an error.
//! - `i(id, kind, ptr, len) -> status` feeds a record (owned from then on):
//!   a datagram received on a stream, a control call, data for a channel.
//! - `t(id) -> status` tells the connection the clock advanced.
//! - `o(id) -> len` moves the connection's next output record into the
//!   scratch `p()` points at and answers its length, 0 when there is none.
//! - `d(id)` drops the connection.
//!
//! Records are a tag byte (output) or kind (input) and a payload. Control
//! calls and events are text: `key=value` fields separated by 0x1f. Datagrams
//! and channel data are binary (see the layouts below). Status 0 is success;
//! a failed control call also leaves a result record with an `error` field.
//! A panic aborts, which the loader sees as a trap and treats as a dead
//! instance.
#![allow(clippy::missing_safety_doc)]

use std::alloc::{Layout, alloc, dealloc};
use std::cell::UnsafeCell;
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::time::Instant;

use str0m::change::{SdpAnswer, SdpOffer, SdpPendingOffer};
use str0m::channel::{ChannelConfig, ChannelId, Reliability};
use str0m::config::DtlsCert;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};

/// bytes from a hex string
fn unhex(text: &str) -> Option<Vec<u8>> {
	if text.len() % 2 != 0 {
		return None;
	}
	(0..text.len())
		.step_by(2)
		.map(|at| u8::from_str_radix(text.get(at..at + 2)?, 16).ok())
		.collect()
}

/// field separator of the text records
const SEP: u8 = 0x1f;

// output record tags
/// `[proto u8][src len u16][src][dst len u16][dst][bytes]`: send on the stream of this pair
const OUT_TRANSMIT: u8 = 1;
/// text: an event for the page
const OUT_EVENT: u8 = 2;
/// `[channel u16][binary u8][bytes]`: a message received on a channel
const OUT_CHANNEL_DATA: u8 = 3;
/// `[ms u32]`: call `t` again in this many milliseconds at the latest
const OUT_TIMEOUT: u8 = 4;
/// text: the result of the last control call
const OUT_RESULT: u8 = 5;

// input record kinds
/// `[proto u8][src len u16][src][dst len u16][dst][bytes]`: a datagram received on the stream of this pair
const IN_DATAGRAM: u32 = 1;
/// text: a control call (`op=...`)
const IN_CONTROL: u32 = 2;
/// `[channel u16][binary u8][bytes]`: a message to send on a channel
const IN_CHANNEL_SEND: u32 = 3;

const STATUS_OK: i32 = 0;
const STATUS_NO_CONNECTION: i32 = 1;
const STATUS_BAD_RECORD: i32 = 2;
const STATUS_FAILED: i32 = 3;

struct Conn {
	rtc: Rtc,
	pending: Option<SdpPendingOffer>,
	/// the last local description handed out, for an offer without changes
	last_local: String,
	/// host-facing channel numbers: the index here; None until the offer
	/// that carries the channel is made (str0m's SdpApi holds a change
	/// only until it is applied, so a channel is added at offer time)
	channels: Vec<Option<ChannelId>>,
	/// the configuration of each channel this side created, for a rollback
	configs: Vec<Option<ChannelConfig>>,
	/// channel indexes the next offer adds
	to_add: Vec<usize>,
	/// the next offer restarts ICE
	restart: bool,
	/// the buffered amount last reported for each channel
	buffered: Vec<usize>,
	queue: VecDeque<Vec<u8>>,
}

struct State {
	conns: Vec<Option<Conn>>,
	out: Vec<u8>,
	crypto: bool,
}

struct Slot(UnsafeCell<Option<State>>);
// wasm has one thread: the host calls one export at a time
unsafe impl Sync for Slot {}

static STATE: Slot = Slot(UnsafeCell::new(None));

fn state() -> &'static mut State {
	// SAFETY: single threaded, and no reference outlives the export call
	let slot = unsafe { &mut *STATE.0.get() };
	slot.get_or_insert_with(|| State {
		conns: Vec::new(),
		out: Vec::new(),
		crypto: false,
	})
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn a(len: usize) -> *mut u8 {
	if len == 0 {
		return std::ptr::null_mut();
	}
	unsafe { alloc(Layout::from_size_align_unchecked(len, 1)) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn f(ptr: *mut u8, len: usize) {
	if len == 0 || ptr.is_null() {
		return;
	}
	unsafe { dealloc(ptr, Layout::from_size_align_unchecked(len, 1)) }
}

/// the bytes the host wrote at `ptr`, owned from here on
unsafe fn take(ptr: *mut u8, len: usize) -> Vec<u8> {
	if len == 0 || ptr.is_null() {
		return Vec::new();
	}
	unsafe { Vec::from_raw_parts(ptr, len, len) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn p() -> *const u8 {
	state().out.as_ptr()
}

/// `key=value` fields of a text record
fn fields(text: &[u8]) -> Vec<(&str, &str)> {
	let mut out = Vec::new();
	for part in text.split(|b| *b == SEP) {
		let Ok(part) = std::str::from_utf8(part) else {
			continue;
		};
		if let Some((key, value)) = part.split_once('=') {
			out.push((key, value));
		}
	}
	out
}

fn field<'a>(fields: &[(&'a str, &'a str)], key: &str) -> Option<&'a str> {
	fields.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

/// a text record from `key=value` pairs
fn text(tag: u8, pairs: &[(&str, &str)]) -> Vec<u8> {
	let mut out = vec![tag];
	for (i, (key, value)) in pairs.iter().enumerate() {
		if i > 0 {
			out.push(SEP);
		}
		out.extend_from_slice(key.as_bytes());
		out.push(b'=');
		out.extend_from_slice(value.as_bytes());
	}
	out
}

fn read_u16(bytes: &[u8], at: usize) -> Option<u16> {
	Some(u16::from_be_bytes([*bytes.get(at)?, *bytes.get(at + 1)?]))
}

/// `[proto u8][src len u16][src][dst len u16][dst][bytes]`
fn parse_datagram(bytes: &[u8]) -> Option<(Protocol, SocketAddr, SocketAddr, &[u8])> {
	let proto = match bytes.first()? {
		1 => Protocol::Udp,
		2 => Protocol::Tcp,
		_ => return None,
	};
	let src_len = read_u16(bytes, 1)? as usize;
	let src = std::str::from_utf8(bytes.get(3..3 + src_len)?).ok()?;
	let at = 3 + src_len;
	let dst_len = read_u16(bytes, at)? as usize;
	let dst = std::str::from_utf8(bytes.get(at + 2..at + 2 + dst_len)?).ok()?;
	let payload = bytes.get(at + 2 + dst_len..)?;
	Some((proto, src.parse().ok()?, dst.parse().ok()?, payload))
}

fn transmit_record(proto: Protocol, src: SocketAddr, dst: SocketAddr, payload: &[u8]) -> Vec<u8> {
	let src = src.to_string();
	let dst = dst.to_string();
	let mut out = Vec::with_capacity(6 + src.len() + dst.len() + payload.len());
	out.push(OUT_TRANSMIT);
	out.push(match proto {
		Protocol::Udp => 1,
		_ => 2,
	});
	out.extend_from_slice(&(src.len() as u16).to_be_bytes());
	out.extend_from_slice(src.as_bytes());
	out.extend_from_slice(&(dst.len() as u16).to_be_bytes());
	out.extend_from_slice(dst.as_bytes());
	out.extend_from_slice(payload);
	out
}

/// Whether an offer lets the answerer choose the DTLS role (`a=setup:actpass`)
fn offers_either_role(offer: &str) -> bool {
	offer
		.lines()
		.any(|line| line.trim_end() == "a=setup:actpass")
}

/// Whether this side, the offerer, opens the SCTP association whatever the
/// DTLS roles are. RFC 8841 has both sides open it and browsers do; the
/// stack opens it only as the DTLS client, and a peer that goes by the ICE
/// role instead (aiortc, werift: the controlled side waits) answers an offer
/// as the DTLS client and waits too, so nobody would. Opening it from here
/// is what a browser does, but the stack then keeps its default for the
/// peer's message size (64 KiB) and not the answer's: so only for an answer
/// that allows no more than that, which is what those peers send (a browser
/// allows more, and opens the association itself).
fn initiates_sctp(answer: &str) -> bool {
	let mut application = false;
	let mut size: u32 = 65536;
	for line in answer.lines() {
		let line = line.trim_end();
		if line.starts_with("m=") {
			application = line.starts_with("m=application");
		} else if application {
			if let Some(value) = line.strip_prefix("a=max-message-size:") {
				// 0 is "any size"
				size = match value.trim().parse::<u32>() {
					Ok(0) | Err(_) => u32::MAX,
					Ok(n) => n,
				};
			}
		}
	}
	answer.lines().any(|l| l.starts_with("m=application")) && size <= 65536
}

fn ice_state(state: IceConnectionState) -> &'static str {
	match state {
		IceConnectionState::New => "new",
		IceConnectionState::Checking => "checking",
		IceConnectionState::Connected => "connected",
		IceConnectionState::Completed => "completed",
		IceConnectionState::Disconnected => "disconnected",
	}
}

impl Conn {
	fn push(&mut self, record: Vec<u8>) {
		self.queue.push_back(record);
	}

	fn event(&mut self, pairs: &[(&str, &str)]) {
		self.push(text(OUT_EVENT, pairs));
	}

	fn result(&mut self, pairs: &[(&str, &str)]) {
		self.push(text(OUT_RESULT, pairs));
	}

	fn index_of(&mut self, id: ChannelId) -> usize {
		if let Some(index) = self.channels.iter().position(|c| *c == Some(id)) {
			return index;
		}
		self.channels.push(Some(id));
		self.configs.push(None);
		self.channels.len() - 1
	}

	fn channel_id(&self, fields: &[(&str, &str)]) -> Result<ChannelId, String> {
		let index: usize = field(fields, "index")
			.and_then(|v| v.parse().ok())
			.ok_or("no index")?;
		self.channels
			.get(index)
			.copied()
			.flatten()
			.ok_or_else(|| "no such channel".to_string())
	}

	/// what each channel has queued, reported when it changed: the page's
	/// `bufferedAmount` follows these
	fn report_buffered(&mut self) {
		self.buffered.resize(self.channels.len(), 0);
		for index in 0..self.channels.len() {
			let Some(id) = self.channels[index] else {
				continue;
			};
			let amount = self
				.rtc
				.channel(id)
				.map(|mut c| c.buffered_amount())
				.unwrap_or(0);
			if amount != self.buffered[index] {
				self.buffered[index] = amount;
				let index = index.to_string();
				let amount = amount.to_string();
				self.event(&[("ev", "buffered"), ("index", &index), ("amount", &amount)]);
			}
		}
	}

	/// drain str0m until it wants a timer
	fn drive(&mut self) {
		self.drive_stack();
		self.report_buffered();
	}

	fn drive_stack(&mut self) {
		loop {
			let output = match self.rtc.poll_output() {
				Ok(output) => output,
				Err(error) => {
					let message = error.to_string();
					self.event(&[("ev", "error"), ("message", &message)]);
					return;
				}
			};
			match output {
				Output::Timeout(at) => {
					let ms = at.saturating_duration_since(Instant::now()).as_millis();
					let mut record = vec![OUT_TIMEOUT];
					record.extend_from_slice(&(ms.min(u32::MAX as u128) as u32).to_be_bytes());
					self.push(record);
					return;
				}
				Output::Transmit(transmit) => {
					let contents: Vec<u8> = transmit.contents.into();
					self.push(transmit_record(
						transmit.proto,
						transmit.source,
						transmit.destination,
						&contents,
					));
				}
				Output::Event(event) => self.handle_event(event),
			}
		}
	}

	fn handle_event(&mut self, event: Event) {
		match event {
			Event::Connected => self.event(&[("ev", "connected")]),
			Event::IceConnectionStateChange(state) => {
				self.event(&[("ev", "ice"), ("state", ice_state(state))]);
			}
			Event::ChannelOpen(id, label) => {
				let index = self.index_of(id).to_string();
				let config = self.rtc.channel(id).and_then(|c| c.config().cloned());
				let mut pairs: Vec<(String, String)> = vec![
					("ev".into(), "channel_open".into()),
					("index".into(), index),
					("label".into(), label),
				];
				if let Some(config) = config {
					pairs.push(("ordered".into(), if config.ordered { "1" } else { "0" }.into()));
					pairs.push(("protocol".into(), config.protocol));
					match config.reliability {
						Reliability::Reliable => {}
						Reliability::MaxPacketLifetime { lifetime } => {
							pairs.push(("maxPacketLifeTime".into(), lifetime.to_string()));
						}
						Reliability::MaxRetransmits { retransmits } => {
							pairs.push(("maxRetransmits".into(), retransmits.to_string()));
						}
					}
					if let Some(stream) = config.negotiated {
						pairs.push(("negotiated".into(), stream.to_string()));
					}
				}
				if let Some(stream) = self.rtc.direct_api().sctp_stream_id_by_channel_id(id) {
					pairs.push(("stream".into(), stream.to_string()));
				}
				let borrowed: Vec<(&str, &str)> =
					pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
				self.event(&borrowed);
			}
			Event::ChannelData(data) => {
				let index = self.index_of(data.id) as u16;
				let mut record = Vec::with_capacity(4 + data.data.len());
				record.push(OUT_CHANNEL_DATA);
				record.extend_from_slice(&index.to_be_bytes());
				record.push(if data.binary { 1 } else { 0 });
				record.extend_from_slice(&data.data);
				self.push(record);
			}
			Event::ChannelClose(id) => {
				let index = self.index_of(id).to_string();
				self.event(&[("ev", "channel_close"), ("index", &index)]);
			}
			Event::ChannelBufferedAmountLow(id) => {
				let index = self.index_of(id).to_string();
				self.event(&[("ev", "buffered_low"), ("index", &index)]);
			}
			Event::Closed => self.event(&[("ev", "closed")]),
			_ => {}
		}
	}

	fn channel_config(fields: &[(&str, &str)]) -> ChannelConfig {
		let mut config = ChannelConfig {
			label: field(fields, "label").unwrap_or("").to_string(),
			ordered: field(fields, "ordered") != Some("0"),
			protocol: field(fields, "protocol").unwrap_or("").to_string(),
			..Default::default()
		};
		if let Some(n) = field(fields, "maxRetransmits").and_then(|v| v.parse().ok()) {
			config.reliability = Reliability::MaxRetransmits { retransmits: n };
		} else if let Some(n) = field(fields, "maxPacketLifeTime").and_then(|v| v.parse().ok()) {
			config.reliability = Reliability::MaxPacketLifetime { lifetime: n };
		}
		if let Some(n) = field(fields, "negotiated").and_then(|v| v.parse().ok()) {
			config.negotiated = Some(n);
		}
		config
	}

	fn control(&mut self, fields: &[(&str, &str)]) -> Result<(), String> {
		match field(fields, "op").unwrap_or("") {
			"channel" => {
				let config = Self::channel_config(fields);
				let index = self.channels.len();
				self.channels.push(None);
				self.configs.push(Some(config));
				self.to_add.push(index);
				let index = index.to_string();
				self.result(&[("index", &index)]);
			}
			"offer" => {
				let mut api = self.rtc.sdp_api();
				if self.restart {
					api.ice_restart(true);
					self.restart = false;
				}
				for index in self.to_add.drain(..) {
					let Some(config) = self.configs.get(index).cloned().flatten() else {
						continue;
					};
					let id = api.add_channel_with_config(config);
					self.channels[index] = Some(id);
				}
				// a channel on a negotiated connection needs no offer: it is
				// opened at once and the description stays as it was
				let sdp = match api.apply() {
					Some((offer, pending)) => {
						self.pending = Some(pending);
						offer.to_sdp_string()
					}
					None => self.last_local.clone(),
				};
				self.last_local = sdp.clone();
				self.result(&[("sdp", &sdp)]);
			}
			"answer" => {
				let sdp = field(fields, "sdp").unwrap_or("");
				let answer = SdpAnswer::from_sdp_string(sdp).map_err(|e| e.to_string())?;
				if let Some(pending) = self.pending.take() {
					if initiates_sctp(sdp) {
						self.rtc.direct_api().start_sctp(true);
					}
					self.rtc
						.sdp_api()
						.accept_answer(pending, answer)
						.map_err(|e| e.to_string())?;
				}
				self.result(&[]);
			}
			"remote_offer" => {
				let sdp = field(fields, "sdp").unwrap_or("");
				let offer = SdpOffer::from_sdp_string(sdp).map_err(|e| e.to_string())?;
				// an offer of ours that was never answered is rolled back
				self.pending = None;
				// An offer leaves the DTLS roles to the answerer (actpass),
				// and a browser's answer takes the client's (active); the
				// stack would take the server's. Starting DTLS as the
				// client first settles it: the stack keeps a role it has.
				if offers_either_role(sdp) {
					self.rtc
						.direct_api()
						.start_dtls(true)
						.map_err(|e| e.to_string())?;
				}
				let answer = self
					.rtc
					.sdp_api()
					.accept_offer(offer)
					.map_err(|e| e.to_string())?
					.to_sdp_string();
				self.last_local = answer.clone();
				self.result(&[("sdp", &answer)]);
			}
			"rollback" => {
				// the channels the offer carried wait for the next one
				if self.pending.take().is_some() {
					for index in 0..self.channels.len() {
						let Some(id) = self.channels[index] else {
							continue;
						};
						if self.configs[index].is_some()
							&& self.rtc.direct_api().sctp_stream_id_by_channel_id(id).is_none()
							&& !self.to_add.contains(&index)
						{
							self.channels[index] = None;
							self.to_add.push(index);
						}
					}
				}
				self.result(&[]);
			}
			"remote_candidate" => {
				let line = field(fields, "candidate").unwrap_or("");
				let candidate = Candidate::from_sdp_string(line).map_err(|e| e.to_string())?;
				self.rtc.add_remote_candidate(candidate);
				self.result(&[]);
			}
			"local_candidate" => {
				let line = field(fields, "candidate").unwrap_or("");
				let candidate = Candidate::from_sdp_string(line).map_err(|e| e.to_string())?;
				let added = self.rtc.add_local_candidate(candidate).is_some();
				self.result(&[("added", if added { "1" } else { "0" })]);
			}
			"relay_candidate" => {
				// a TURN allocation the host made: `addr` is the relayed
				// address, which the stack sends from through the host
				let addr: SocketAddr = field(fields, "addr")
					.and_then(|v| v.parse().ok())
					.ok_or("no addr")?;
				let local: SocketAddr = field(fields, "local")
					.and_then(|v| v.parse().ok())
					.ok_or("no local")?;
				let candidate = Candidate::relayed(addr, local, "udp").map_err(|e| e.to_string())?;
				match self.rtc.add_local_candidate(candidate) {
					Some(added) => {
						let line = added.to_sdp_string();
						self.result(&[("candidate", &line)]);
					}
					None => self.result(&[]),
				}
			}
			"creds" => {
				let api = self.rtc.direct_api();
				let creds = api.local_ice_credentials();
				let fingerprint = api.local_dtls_fingerprint().to_string();
				self.result(&[
					("ufrag", &creds.ufrag),
					("pass", &creds.pass),
					("fingerprint", &fingerprint),
				]);
			}
			"ice_restart" => {
				self.restart = true;
				self.result(&[]);
			}
			"channel_close" => {
				let id = self.channel_id(fields)?;
				self.rtc.direct_api().close_data_channel(id);
				self.result(&[]);
			}
			"low_threshold" => {
				let value: usize = field(fields, "value")
					.and_then(|v| v.parse().ok())
					.ok_or("no value")?;
				let id = self.channel_id(fields)?;
				if let Some(mut channel) = self.rtc.channel(id) {
					channel.set_buffered_amount_low_threshold(value);
				}
				self.result(&[]);
			}
			// the SCTP shutdown and the DTLS close_notify are queued: the
			// caller sends what comes out before it destroys the connection
			"close" => {
				if self.rtc.close().is_err() {
					self.rtc.disconnect();
				}
				self.result(&[]);
			}
			op => return Err(format!("unknown op {op}")),
		}
		Ok(())
	}
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn c(ptr: *mut u8, len: usize) -> i32 {
	let config = unsafe { take(ptr, len) };
	let fields = fields(&config);
	let state = state();
	if !state.crypto {
		str0m::crypto::from_feature_flags().install_process_default();
		state.crypto = true;
	}
	// the send buffer and the message size are Chrome's: 16 MiB queued
	// before a send fails, messages of up to 256 KiB
	let mut builder = Rtc::builder()
		.set_sctp_max_buffered_amount(16 * 1024 * 1024)
		.set_sctp_max_message_size(262144);
	if field(&fields, "ice_lite") == Some("1") {
		builder = builder.set_ice_lite(true);
	}
	// the DTLS certificate (DER) and its PKCS#8 key, hex: the host generates
	// them with WebCrypto, the crypto backend here generates none
	match (
		field(&fields, "cert").and_then(unhex),
		field(&fields, "key").and_then(unhex),
	) {
		(Some(certificate), Some(private_key)) => {
			builder = builder.set_dtls_cert(DtlsCert {
				certificate,
				private_key,
			});
		}
		_ => return -1,
	}
	let mut rtc = builder.build(Instant::now());
	// the host's own address for its sockets: every stream is one pair of
	// this and a remote (docs/webrtc-over-wisp.md, section 5)
	if let Some(local) = field(&fields, "local") {
		let Ok(addr) = local.parse::<SocketAddr>() else {
			return -1;
		};
		match Candidate::host(addr, "udp") {
			Ok(candidate) => {
				rtc.add_local_candidate(candidate);
			}
			Err(_) => return -1,
		}
	}
	let conn = Conn {
		rtc,
		pending: None,
		last_local: String::new(),
		channels: Vec::new(),
		configs: Vec::new(),
		to_add: Vec::new(),
		restart: false,
		buffered: Vec::new(),
		queue: VecDeque::new(),
	};
	if let Some(index) = state.conns.iter().position(|c| c.is_none()) {
		state.conns[index] = Some(conn);
		index as i32
	} else {
		state.conns.push(Some(conn));
		(state.conns.len() - 1) as i32
	}
}

fn conn(id: i32) -> Option<&'static mut Conn> {
	state().conns.get_mut(id as usize)?.as_mut()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn i(id: i32, kind: u32, ptr: *mut u8, len: usize) -> i32 {
	let bytes = unsafe { take(ptr, len) };
	let Some(conn) = conn(id) else {
		return STATUS_NO_CONNECTION;
	};
	let now = Instant::now();
	let mut status = match kind {
		IN_DATAGRAM => match parse_datagram(&bytes) {
			Some((proto, source, destination, payload)) => {
				match Receive::new(proto, source, destination, payload) {
					Ok(receive) => match conn.rtc.handle_input(Input::Receive(now, receive)) {
						Ok(()) => STATUS_OK,
						Err(error) => {
							let message = error.to_string();
							conn.event(&[("ev", "error"), ("message", &message)]);
							STATUS_FAILED
						}
					},
					// not STUN, DTLS, RTP or RTCP: dropped, as a socket would
					Err(_) => STATUS_OK,
				}
			}
			None => STATUS_BAD_RECORD,
		},
		IN_CONTROL => {
			let fields = fields(&bytes);
			match conn.control(&fields) {
				Ok(()) => STATUS_OK,
				Err(error) => {
					conn.result(&[("error", &error)]);
					STATUS_FAILED
				}
			}
		}
		IN_CHANNEL_SEND => {
			let index = read_u16(&bytes, 0).map(|n| n as usize);
			let binary = bytes.get(2).copied().unwrap_or(0) == 1;
			match index.and_then(|index| conn.channels.get(index).copied().flatten()) {
				// An empty message is not sent: the stack takes a stream
				// sequence number for it and writes no chunk (it should be
				// one zero byte under the "empty" payload identifiers,
				// RFC 8831 6.6), and an ordered channel's later messages
				// would wait for it for ever at the peer
				Some(_) if bytes.len() <= 3 => STATUS_OK,
				Some(id) => match conn.rtc.channel(id) {
					Some(mut channel) => match channel.write(binary, &bytes[3..]) {
						Ok(true) => STATUS_OK,
						// more than the send buffer has room for
						Ok(false) => {
							conn.result(&[("error", "full")]);
							STATUS_FAILED
						}
						Err(error) => {
							let message = error.to_string();
							conn.result(&[("error", &message)]);
							STATUS_FAILED
						}
					},
					None => STATUS_FAILED,
				},
				None => STATUS_BAD_RECORD,
			}
		}
		_ => STATUS_BAD_RECORD,
	};
	// a call can leave work that is due now (checks to a candidate just
	// added, a message just queued): the clock advances with every call
	if kind != IN_DATAGRAM {
		if let Err(error) = conn.rtc.handle_input(Input::Timeout(now)) {
			let message = error.to_string();
			conn.event(&[("ev", "error"), ("message", &message)]);
			status = STATUS_FAILED;
		}
	}
	conn.drive();
	status
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn t(id: i32) -> i32 {
	let Some(conn) = conn(id) else {
		return STATUS_NO_CONNECTION;
	};
	if let Err(error) = conn.rtc.handle_input(Input::Timeout(Instant::now())) {
		let message = error.to_string();
		conn.event(&[("ev", "error"), ("message", &message)]);
	}
	conn.drive();
	STATUS_OK
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn o(id: i32) -> usize {
	let Some(record) = conn(id).and_then(|conn| conn.queue.pop_front()) else {
		return 0;
	};
	let state = state();
	state.out = record;
	state.out.len()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn d(id: i32) {
	if let Some(slot) = state().conns.get_mut(id as usize) {
		*slot = None;
	}
}
