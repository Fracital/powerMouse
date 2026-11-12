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
//!   a datagram received on a stream, a control call, data for a channel,
//!   an encoded frame for a media section.
//! - `t(id) -> status` tells the connection the clock advanced.
//! - `o(id) -> len` moves the connection's next output record into the
//!   scratch `p()` points at and answers its length, 0 when there is none.
//! - `d(id)` drops the connection.
//!
//! Records are a tag byte (output) or kind (input) and a payload. Control
//! calls and events are text: `key=value` fields separated by 0x1f. Datagrams,
//! channel data and media frames are binary (see the layouts below and in
//! `media`). Status 0 is success;
//! a failed control call also leaves a result record with an `error` field.
//! A panic aborts, which the loader sees as a trap and treats as a dead
//! instance.
#![allow(clippy::missing_safety_doc)]

use std::alloc::{Layout, alloc, dealloc};
use std::cell::UnsafeCell;
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use str0m::bwe::{Bitrate, BweKind};
use str0m::change::{SdpAnswer, SdpOffer, SdpPendingOffer};
use str0m::channel::{ChannelConfig, ChannelId, Reliability};
use str0m::config::DtlsCert;
use str0m::media::{
	Direction, KeyframeRequestKind, MediaKind, MediaTime, Mid, Simulcast, SimulcastLayer,
};
use str0m::net::{Protocol, Receive};
use str0m::rtp::VideoOrientation;
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};

mod media;
#[cfg(test)]
mod tests;

use media::MediaSlot;

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
/// a frame received on a media section (`media::data_record`)
const OUT_MEDIA_DATA: u8 = 6;

// input record kinds
/// `[proto u8][src len u16][src][dst len u16][dst][bytes]`: a datagram received on the stream of this pair
const IN_DATAGRAM: u32 = 1;
/// text: a control call (`op=...`)
const IN_CONTROL: u32 = 2;
/// `[channel u16][binary u8][bytes]`: a message to send on a channel
const IN_CHANNEL_SEND: u32 = 3;
/// a frame to send on a media section (`media::Frame`)
const IN_MEDIA_WRITE: u32 = 4;

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
	/// host-facing media section numbers: the index here
	medias: Vec<MediaSlot>,
	/// media indexes the next offer adds
	media_to_add: Vec<usize>,
	/// the directions the pending offer changed, as they were, for a rollback
	reverted: Vec<(Mid, Direction)>,
	/// for each channel, the bytes written to its stream and where in them
	/// the zero bytes sit that stand for empty messages (RFC 8831 6.6):
	/// the stack counts those as buffered, a page has sent nothing
	wire: Vec<(u64, VecDeque<u64>)>,
	/// for each channel, the page's bufferedAmountLowThreshold and whether
	/// the amount has been above it since the last time it was said low
	low: Vec<(usize, bool)>,
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

	/// the index of the media section with this mid: a new one for a
	/// section the peer added
	fn media_index(&mut self, mid: Mid, kind: MediaKind) -> usize {
		if let Some(index) = self.medias.iter().position(|m| m.mid == Some(mid)) {
			return index;
		}
		self.medias.push(MediaSlot {
			mid: Some(mid),
			kind,
			wanted: None,
			stream: None,
			track: None,
			rids: Vec::new(),
			stop: false,
			after: self.channels.len(),
			announced: false,
		});
		self.medias.len() - 1
	}

	/// Tell the host of each section the stack has now and the host has
	/// not heard of: the stack's own event comes for the sections of an
	/// offer it accepted, and not for the ones an answer confirmed.
	fn announce(&mut self) {
		for index in 0..self.medias.len() {
			let send = self.medias[index].rids.join(",");
			self.announce_one(index, &send, "");
		}
	}

	/// `send` and `recv`: the simulcast layers each way, by rid
	fn announce_one(&mut self, index: usize, send: &str, recv: &str) {
		let slot = &self.medias[index];
		let (Some(mid), false) = (slot.mid, slot.announced) else {
			return;
		};
		let Some(direction) = self.rtc.media(mid).map(|m| m.direction().to_string()) else {
			return;
		};
		let kind = slot.kind;
		self.medias[index].announced = true;
		// Redundant audio is the host's to turn on: a browser sends it
		// only when the peer lists it first, and reads it always
		if kind == MediaKind::Audio {
			self.rtc.direct_api().set_red_send(mid, false);
		}
		let index = index.to_string();
		let mid = mid.to_string();
		let mut pairs = vec![
			("ev", "media"),
			("index", index.as_str()),
			("mid", mid.as_str()),
			("kind", media::kind_name(kind)),
			("dir", direction.as_str()),
		];
		if !send.is_empty() {
			pairs.push(("send_rids", send));
		}
		if !recv.is_empty() {
			pairs.push(("recv_rids", recv));
		}
		self.event(&pairs);
	}

	fn media_field(&self, fields: &[(&str, &str)]) -> Result<usize, String> {
		let index: usize = field(fields, "index")
			.and_then(|v| v.parse().ok())
			.ok_or("no index")?;
		if index >= self.medias.len() {
			return Err("no such media".to_string());
		}
		Ok(index)
	}

	/// the mid of a media section the stack has
	fn media_mid(&self, fields: &[(&str, &str)]) -> Result<Mid, String> {
		let index = self.media_field(fields)?;
		self.medias[index]
			.mid
			.filter(|mid| self.rtc.media(*mid).is_some())
			.ok_or_else(|| "media not negotiated".to_string())
	}

	/// `index:mid` of every media section that has a mid, for the host's
	/// transceivers
	fn mids(&self) -> String {
		let mut out = String::new();
		for (index, slot) in self.medias.iter().enumerate() {
			let Some(mid) = slot.mid else {
				continue;
			};
			if !out.is_empty() {
				out.push(',');
			}
			out.push_str(&index.to_string());
			out.push(':');
			out.push_str(&mid);
		}
		out
	}

	/// Forget the pending offer: the channels and media sections it carried
	/// wait for the next one, and the directions it changed are as they were.
	///
	/// A channel that is offered again is a new one to the stack, which
	/// allocates it only when its offer is answered (the patch of
	/// rust/patches): one negotiated by the page (with an `id`) keeps its
	/// stream id through a rollback.
	fn roll_back(&mut self) {
		if self.pending.take().is_none() {
			return;
		}
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
		for index in 0..self.medias.len() {
			let Some(mid) = self.medias[index].mid else {
				continue;
			};
			if self.rtc.media(mid).is_none() && !self.media_to_add.contains(&index) {
				self.medias[index].mid = None;
				self.media_to_add.push(index);
			}
		}
		self.to_add.sort_unstable();
		self.media_to_add.sort_unstable();
		for (mid, direction) in std::mem::take(&mut self.reverted) {
			// the direction is the session's; the offer that would state it
			// is dropped with the changes
			self.rtc.sdp_api().set_direction(mid, direction);
		}
	}

	/// An encoded frame from the host, for the stack to packetize. A frame
	/// the stack does not take (no such payload, a section that does not
	/// send, a connection not up yet) is dropped, as a sender without a
	/// transport drops it: frames come too often to answer each.
	fn write_frame(&mut self, frame: &media::Frame, now: Instant) -> i32 {
		let Some(mid) = self.medias.get(frame.media).and_then(|m| m.mid) else {
			return STATUS_BAD_RECORD;
		};
		let pt = frame.pt.into();
		// only a payload the section negotiated: the stack would packetize
		// any it has a format for
		if !self.rtc.media(mid).is_some_and(|m| m.remote_pts().contains(&pt)) {
			return STATUS_FAILED;
		}
		let Some(clock) = self
			.rtc
			.codec_config()
			.find(|p| p.pt() == pt)
			.map(|p| p.spec().clock_rate)
		else {
			return STATUS_FAILED;
		};
		let Some(mut writer) = self.rtc.writer(mid) else {
			return STATUS_FAILED;
		};
		if let Some(rid) = frame.rid {
			writer = writer.rid(rid.into());
		}
		if frame.level != media::ABSENT {
			let level = -(frame.level.min(127) as i8);
			writer = writer.audio_level(level, frame.flags & media::FLAG_VOICE != 0);
		}
		if frame.flags & media::FLAG_TALKSPURT != 0 {
			writer = writer.start_of_talkspurt(true);
		}
		if frame.orientation != media::ABSENT {
			writer = writer.video_orientation(VideoOrientation::from(frame.orientation));
		}
		// when the frame was captured: the sender reports pair this with
		// the frame's RTP time, which is what lines audio up with video
		let wallclock = now
			.checked_sub(Duration::from_millis(frame.age as u64))
			.unwrap_or(now);
		match writer.write(pt, wallclock, MediaTime::new(frame.time, clock), frame.data) {
			Ok(()) => STATUS_OK,
			Err(_) => STATUS_FAILED,
		}
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
			// less the stand-in bytes still in it: the stream releases its
			// bytes in the order they were written
			let amount = match self.wire.get_mut(index) {
				Some((written, pads)) => {
					let released = written.saturating_sub(amount as u64);
					while pads.front().is_some_and(|at| *at <= released) {
						pads.pop_front();
					}
					amount.saturating_sub(pads.len())
				}
				None => amount,
			};
			let name = index.to_string();
			if amount != self.buffered[index] {
				self.buffered[index] = amount;
				let amount = amount.to_string();
				self.event(&[("ev", "buffered"), ("index", &name), ("amount", &amount)]);
			}
			// low is said of what the page sent: the stack's own event counts
			// the stand-in bytes too
			if self.low.len() <= index {
				self.low.resize(index + 1, (0, false));
			}
			let (threshold, above) = &mut self.low[index];
			if amount > *threshold {
				*above = true;
			} else if *above {
				*above = false;
				self.event(&[("ev", "buffered_low"), ("index", &name)]);
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
			Event::Closed => self.event(&[("ev", "closed")]),
			Event::MediaAdded(added) => {
				let index = self.media_index(added.mid, added.kind);
				let rids = |layers: &[SimulcastLayer]| {
					layers
						.iter()
						.map(|layer| layer.rid.to_string())
						.collect::<Vec<_>>()
						.join(",")
				};
				let (send, recv) = match &added.simulcast {
					Some(simulcast) => (rids(&simulcast.send), rids(&simulcast.recv)),
					None => (String::new(), String::new()),
				};
				self.announce_one(index, &send, &recv);
			}
			Event::MediaChanged(changed) => {
				if let Some(index) = self.medias.iter().position(|m| m.mid == Some(changed.mid)) {
					let index = index.to_string();
					let direction = changed.direction.to_string();
					self.event(&[("ev", "media_changed"), ("index", &index), ("dir", &direction)]);
				}
			}
			Event::MediaData(data) => {
				if let Some(index) = self.medias.iter().position(|m| m.mid == Some(data.mid)) {
					if let Some(record) = media::data_record(OUT_MEDIA_DATA, index as u8, &data) {
						self.push(record);
					}
				}
			}
			// the peer lost a picture: the host's encoder makes a keyframe
			Event::KeyframeRequest(request) => {
				if let Some(index) = self.medias.iter().position(|m| m.mid == Some(request.mid)) {
					let index = index.to_string();
					let rid = request.rid.map(|rid| rid.to_string()).unwrap_or_default();
					let kind = match request.kind {
						KeyframeRequestKind::Pli => "pli",
						KeyframeRequestKind::Fir => "fir",
					};
					self.event(&[("ev", "keyframe"), ("index", &index), ("rid", &rid), ("kind", kind)]);
				}
			}
			// what the path carries, for the host's encoders to share
			Event::EgressBitrateEstimate(BweKind::Twcc {
				estimate,
				can_probe,
			}) => {
				let bps = estimate.as_u64().to_string();
				self.event(&[
					("ev", "bitrate"),
					("kind", "twcc"),
					("bps", &bps),
					("probe", if can_probe { "1" } else { "0" }),
				]);
			}
			Event::EgressBitrateEstimate(BweKind::Remb { estimate, mid }) => {
				if let Some(index) = self.medias.iter().position(|m| m.mid == Some(mid)) {
					let bps = estimate.as_u64().to_string();
					let index = index.to_string();
					self.event(&[("ev", "bitrate"), ("kind", "remb"), ("bps", &bps), ("index", &index)]);
				}
			}
			// a stream the peer stopped or started sending: the track's mute
			Event::StreamPaused(paused) => {
				if let Some(index) = self.medias.iter().position(|m| m.mid == Some(paused.mid)) {
					let index = index.to_string();
					let rid = paused.rid.map(|rid| rid.to_string()).unwrap_or_default();
					self.event(&[
						("ev", "paused"),
						("index", &index),
						("rid", &rid),
						("paused", if paused.paused { "1" } else { "0" }),
					]);
				}
			}
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
			"media" => {
				let kind = match field(fields, "kind") {
					Some("audio") => MediaKind::Audio,
					Some("video") => MediaKind::Video,
					_ => return Err("no kind".to_string()),
				};
				let wanted = match field(fields, "dir") {
					Some(dir) => media::direction(dir).ok_or("bad dir")?,
					None => Direction::SendRecv,
				};
				let index = self.medias.len();
				if index > u8::MAX as usize {
					return Err("too many media sections".to_string());
				}
				self.medias.push(MediaSlot {
					mid: None,
					kind,
					wanted: Some(wanted),
					stream: field(fields, "stream").map(str::to_string),
					track: field(fields, "track").map(str::to_string),
					rids: field(fields, "rids")
						.map(|rids| {
							rids.split(',')
								.filter(|rid| !rid.is_empty())
								.map(str::to_string)
								.collect()
						})
						.unwrap_or_default(),
					stop: false,
					after: self.channels.len(),
					announced: false,
				});
				self.media_to_add.push(index);
				let index = index.to_string();
				self.result(&[("index", &index)]);
			}
			// the next offer states it; an answer takes it from the
			// `dir<n>` fields of `remote_offer`
			"direction" => {
				let index = self.media_field(fields)?;
				let wanted = field(fields, "dir").and_then(media::direction).ok_or("bad dir")?;
				self.medias[index].wanted = Some(wanted);
				self.result(&[]);
			}
			"stop" => {
				let index = self.media_field(fields)?;
				self.medias[index].stop = true;
				self.result(&[]);
			}
			// ask the peer for a keyframe: a decoder that lost a picture
			"keyframe" => {
				let mid = self.media_mid(fields)?;
				if self.medias[self.media_field(fields)?].kind != MediaKind::Video {
					return Err("not a video section".to_string());
				}
				let kind = match field(fields, "kind") {
					Some("fir") => KeyframeRequestKind::Fir,
					_ => KeyframeRequestKind::Pli,
				};
				let rid = field(fields, "rid").filter(|rid| !rid.is_empty()).map(Into::into);
				let mut writer = self.rtc.writer(mid).ok_or("no such media")?;
				writer.request_keyframe(rid, kind).map_err(|e| e.to_string())?;
				self.result(&[]);
			}
			// what the encoders send at least and would like to send, for
			// the estimator's padding and probing; `reset` starts it again
			"bitrate" => {
				let rate = |key: &str| field(fields, key).and_then(|v| v.parse::<u64>().ok());
				if let Some(bps) = rate("reset") {
					self.rtc.bwe().reset(Bitrate::bps(bps));
				}
				if let (Some(min), Some(desired)) = (rate("min"), rate("desired")) {
					self.rtc.bwe().set_bitrate(Bitrate::bps(min), Bitrate::bps(desired));
				}
				self.result(&[]);
			}
			// what a section negotiated, in the peer's order of preference:
			// the first payload is the one to send
			"payloads" => {
				let mid = self.media_mid(fields)?;
				let media = self.rtc.media(mid).ok_or("no such media")?;
				let mut codecs = String::new();
				for pt in media.remote_pts() {
					if let Some(params) = self.rtc.codec_config().find(|p| p.pt() == *pt) {
						media::payload_entry(params, &mut codecs);
					}
				}
				let mut exts = String::new();
				for (id, extension) in media.remote_extmap().iter() {
					if !exts.is_empty() {
						exts.push('|');
					}
					exts.push_str(&id.to_string());
					exts.push(':');
					exts.push_str(extension.as_uri());
				}
				let direction = media.direction().to_string();
				self.result(&[("codecs", &codecs), ("exts", &exts), ("dir", &direction)]);
			}
			// redundant audio (RFC 2198) on or off for what this side sends
			"red" => {
				let mid = self.media_mid(fields)?;
				let on = field(fields, "on") == Some("1");
				self.rtc.direct_api().set_red_send(mid, on);
				self.result(&[]);
			}
			"offer" => {
				// An offer was made and not answered yet. With nothing new
				// to say it stands, and this is the same offer again (a
				// page that reads a draft and then offers); with something
				// new it is replaced by one that carries both.
				if self.pending.is_some() {
					let fresh = self.restart
						|| !self.to_add.is_empty()
						|| !self.media_to_add.is_empty()
						|| self.medias.iter().any(|slot| {
							slot.mid.and_then(|mid| self.rtc.media(mid)).is_some_and(|media| {
								(slot.stop && !media.stopped())
									|| slot.wanted.is_some_and(|wanted| wanted != media.direction())
							})
						});
					if !fresh {
						let sdp = self.last_local.clone();
						let mids = self.mids();
						self.result(&[("sdp", &sdp), ("mids", &mids)]);
						return Ok(());
					}
					self.roll_back();
				}
				// each section's direction as it is, for the ones this
				// offer changes
				let current: Vec<Option<Direction>> = self
					.medias
					.iter()
					.map(|slot| {
						slot.mid
							.and_then(|mid| self.rtc.media(mid))
							.map(|media| media.direction())
					})
					.collect();
				let mut api = self.rtc.sdp_api();
				if self.restart {
					api.ice_restart(true);
					self.restart = false;
				}
				let add_media = |api: &mut str0m::change::SdpApi, slot: &mut MediaSlot| {
					let simulcast = (!slot.rids.is_empty()).then(|| Simulcast {
						send: slot.rids.iter().map(|rid| SimulcastLayer::new(rid)).collect(),
						recv: Vec::new(),
					});
					slot.mid = Some(api.add_media(
						slot.kind,
						slot.wanted.unwrap_or(Direction::SendRecv),
						slot.stream.clone(),
						slot.track.clone(),
						simulcast,
					));
				};
				// sections in the order their owners were made: a media
				// section before the channels that came after it
				let mut media_to_add = self.media_to_add.drain(..).peekable();
				for index in self.to_add.drain(..) {
					while let Some(media) = media_to_add.next_if(|m| self.medias[*m].after <= index) {
						add_media(&mut api, &mut self.medias[media]);
					}
					let Some(config) = self.configs.get(index).cloned().flatten() else {
						continue;
					};
					let id = api.add_channel_with_config(config);
					self.channels[index] = Some(id);
				}
				for media in media_to_add {
					add_media(&mut api, &mut self.medias[media]);
				}
				// a browser's offer states what each transceiver wants,
				// whatever the last answer left of it
				for (slot, current) in self.medias.iter().zip(&current) {
					let (Some(mid), Some(current)) = (slot.mid, *current) else {
						continue;
					};
					if slot.stop {
						api.stop_media(mid);
					} else if let Some(wanted) = slot.wanted {
						if wanted != current {
							api.set_direction(mid, wanted);
							self.reverted.push((mid, current));
						}
					}
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
				let mids = self.mids();
				self.result(&[("sdp", &sdp), ("mids", &mids)]);
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
					self.reverted.clear();
					self.announce();
				}
				self.result(&[]);
			}
			"remote_offer" => {
				// `dir<n>`: what this side wants of the offer's nth section
				let (sdp, wanted) = media::narrowed(field(fields, "sdp").unwrap_or(""), |n| {
					field(fields, &format!("dir{n}")).and_then(media::direction)
				});
				let sdp = sdp.as_str();
				let offer = SdpOffer::from_sdp_string(sdp).map_err(|e| e.to_string())?;
				// an offer of ours that was never answered is rolled back
				self.roll_back();
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
				for want in wanted {
					if want.mid.is_empty() {
						continue;
					}
					let index = self.media_index(want.mid.as_str().into(), want.kind);
					self.medias[index].wanted = Some(want.direction);
				}
				let mids = self.mids();
				self.result(&[("sdp", &answer), ("mids", &mids)]);
			}
			"rollback" => {
				self.roll_back();
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
				let index: usize = field(fields, "index")
					.and_then(|v| v.parse().ok())
					.ok_or("no index")?;
				if self.low.len() <= index {
					self.low.resize(index + 1, (0, false));
				}
				self.low[index].0 = value;
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
	// what the host encodes and decodes, and the header extensions, as a
	// browser numbers them (`media::codecs`, `media::extensions`)
	if let Some(list) = field(&fields, "codecs") {
		if media::codecs(builder.codec_config(), list).is_err() {
			return -1;
		}
	}
	if let Some(list) = field(&fields, "exts") {
		match media::extensions(list) {
			Ok(map) => builder = builder.set_extension_map(map),
			Err(_) => return -1,
		}
	}
	// send-side bandwidth estimation, from this many bits a second
	if let Some(bps) = field(&fields, "bwe").and_then(|v| v.parse::<u64>().ok()) {
		builder = builder.enable_bwe(Some(Bitrate::bps(bps)));
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
		medias: Vec::new(),
		media_to_add: Vec::new(),
		reverted: Vec::new(),
		wire: Vec::new(),
		low: Vec::new(),
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
				Some(id) => match conn.rtc.channel(id) {
					// an empty message travels as one zero byte (the patch
					// of rust/patches/ to the stack's write)
					Some(mut channel) => match channel.write(binary, bytes.get(3..).unwrap_or(&[])) {
						Ok(true) => {
							let index = index.unwrap_or(0);
							if conn.wire.len() <= index {
								conn.wire.resize(index + 1, (0, VecDeque::new()));
							}
							let (written, pads) = &mut conn.wire[index];
							*written += bytes.len().saturating_sub(3).max(1) as u64;
							if bytes.len() <= 3 {
								pads.push_back(*written);
							}
							STATUS_OK
						}
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
		IN_MEDIA_WRITE => match media::parse_frame(&bytes) {
			Some(frame) => conn.write_frame(&frame, now),
			None => STATUS_BAD_RECORD,
		},
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
