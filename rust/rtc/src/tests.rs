//! The records boundary driven as a host drives it: two connections wired
//! back to back, every record through the exports. Run by
//! `deploy/rust/test.sh -p rtc` (natively, in the toolchain container).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::*;

/// a self-signed ECDSA P-256 certificate (DER) and its PKCS#8 key, made for
/// these tests alone: the host makes its own with WebCrypto
const CERT: &str = concat!(
	"3082017c30820123a003020102021448f1938b30ededee63a72321d39aed253350e30d300a06082a8648ce3d04030230",
	"133111300f06035504030c0872746320746573743020170d3236313131313031343035325a180f323132363130313830",
	"31343035325a30133111300f06035504030c0872746320746573743059301306072a8648ce3d020106082a8648ce3d03",
	"01070342000438f0405c898d7b077bbdeb2b23014d63c188c06b656b596f84edb2c6e4b6bec6249c1174517793c50ae6",
	"0ad0560dfa6c52305e76e078e0f9fc27c5e1b21f79f8a3533051301d0603551d0e04160414734373a196f98318d8e27b",
	"4e899fc0344ff3a27a301f0603551d23041830168014734373a196f98318d8e27b4e899fc0344ff3a27a300f0603551d",
	"130101ff040530030101ff300a06082a8648ce3d040302034700304402200cab64c65f3997253cdaa2e08922e37b867f",
	"78bc4ce2a15d80c14000df6c05d302201171c9beb134d991a939377ffad213911a484a6233d6892d81213667f2a4f9e1",
);
const KEY: &str = concat!(
	"308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b020101042040c92db1cc9b2718fae87607",
	"cec42b7a86cb5fcfd1bcd54eba663a7564a74472a1440342000438f0405c898d7b077bbdeb2b23014d63c188c06b656b",
	"596f84edb2c6e4b6bec6249c1174517793c50ae60ad0560dfa6c52305e76e078e0f9fc27c5e1b21f79f8",
);

/// the stack's state is one static, as in the wasm instance: one test at a time
static LOCK: Mutex<()> = Mutex::new(());

/// a browser's audio and video codecs, in the words of its SDP
const CODECS: &str = "111,opus,48000,2,minptime=10;useinbandfec=1|63,red,48000,2,111/111\
|9,G722,8000,1,|0,PCMU,8000,1,|8,PCMA,8000,1,|13,CN,8000,1,\
|110,telephone-event,48000,1,0-16|126,telephone-event,8000,1,0-16\
|96,VP8,90000,,|97,rtx,90000,,apt=96\
|103,H264,90000,,level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f\
|104,rtx,90000,,apt=103\
|109,H264,90000,,level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\
|114,rtx,90000,,apt=109\
|123,red,90000,,|124,rtx,90000,,apt=123|125,ulpfec,90000,,";

const EXTS: &str = "1:urn:ietf:params:rtp-hdrext:ssrc-audio-level\
|2:http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time\
|3:http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01\
|4:urn:ietf:params:rtp-hdrext:sdes:mid\
|14:urn:ietf:params:rtp-hdrext:toffset\
|13:urn:3gpp:video-orientation\
|5:http://www.webrtc.org/experiments/rtp-hdrext/playout-delay\
|10:urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id\
|11:urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id\
|8:http://www.webrtc.org/experiments/rtp-hdrext/color-space\
|12:http://example.invalid/not-an-extension";

type Fields = Vec<(String, String)>;

fn get<'a>(fields: &'a Fields, key: &str) -> &'a str {
	fields
		.iter()
		.find(|(k, _)| k == key)
		.map(|(_, v)| v.as_str())
		.unwrap_or("")
}

fn owned(bytes: &[u8]) -> Fields {
	fields(bytes)
		.into_iter()
		.map(|(k, v)| (k.to_string(), v.to_string()))
		.collect()
}

/// a frame the far end received
#[derive(Debug, Clone, PartialEq)]
struct Received {
	media: u8,
	pt: u8,
	codec: u8,
	flags: u8,
	level: u8,
	orientation: u8,
	time: u64,
	seq: u16,
	rid: String,
	data: Vec<u8>,
	colour: [u8; 4],
	/// the size the record states (a keyframe's, or its descriptor's)
	size: (u16, u16),
	/// what its dependency descriptor said: id, spatial and temporal
	/// layer, size, dependencies
	described: Option<(u32, u8, u8, (u16, u16), Vec<u32>)>,
}

struct Peer {
	id: i32,
	address: String,
	events: Vec<Fields>,
	frames: Vec<Received>,
	/// what its channels received
	messages: Vec<Vec<u8>>,
	/// datagrams waiting to cross to the other peer
	outbox: Vec<Vec<u8>>,
	/// when the connection last asked to be called again (its timeout)
	wake: Option<Instant>,
}

impl Drop for Peer {
	fn drop(&mut self) {
		unsafe { d(self.id) };
	}
}

fn give(bytes: &[u8]) -> (*mut u8, usize) {
	let ptr = unsafe { a(bytes.len()) };
	if !bytes.is_empty() {
		unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len()) };
	}
	(ptr, bytes.len())
}

fn record(pairs: &[(&str, &str)]) -> Vec<u8> {
	// a text record without its tag
	text(0, pairs)[1..].to_vec()
}

impl Peer {
	fn new(address: &str, extra: &[(&str, &str)]) -> Peer {
		let mut pairs = vec![("cert", CERT), ("key", KEY), ("local", address)];
		pairs.extend_from_slice(extra);
		let (ptr, len) = give(&record(&pairs));
		let id = unsafe { c(ptr, len) };
		assert!(id >= 0, "no connection from {pairs:?}");
		Peer {
			id,
			address: address.to_string(),
			events: Vec::new(),
			frames: Vec::new(),
			messages: Vec::new(),
			outbox: Vec::new(),
			wake: None,
		}
	}

	/// a media connection as the worker configures it
	fn media(address: &str) -> Peer {
		Peer::new(address, &[("codecs", CODECS), ("exts", EXTS), ("bwe", "300000")])
	}

	/// sort what the connection has to say; the result of a control call, if one is there
	fn drain(&mut self) -> Option<Fields> {
		let mut result = None;
		loop {
			let len = unsafe { o(self.id) };
			if len == 0 {
				return result;
			}
			let bytes = unsafe { std::slice::from_raw_parts(p(), len) }.to_vec();
			match bytes[0] {
				OUT_TRANSMIT => {
					// the same layout comes back in as a datagram, the
					// pair turned around by the far end
					self.outbox.push(bytes[1..].to_vec());
				}
				OUT_EVENT => self.events.push(owned(&bytes[1..])),
				OUT_TIMEOUT => {
					let ms = u32::from_be_bytes(bytes[1..5].try_into().unwrap());
					self.wake = Some(Instant::now() + Duration::from_millis(ms as u64));
				}
				OUT_RESULT => result = Some(owned(&bytes[1..])),
				OUT_CHANNEL_DATA => self.messages.push(bytes[4..].to_vec()),
				OUT_MEDIA_DATA => {
					let rid_len = bytes[21] as usize;
					let half = |at: usize| u16::from_be_bytes([bytes[at], bytes[at + 1]]);
					let size = (half(22 + rid_len), half(24 + rid_len));
					let mut at = 26 + rid_len;
					let mut described = None;
					if bytes[4] & media::FLAG_DESCRIBED != 0 {
						let word = |at: usize| u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap());
						let count = bytes[at + 6] as usize;
						let deps = (0..count).map(|n| word(at + 7 + 4 * n)).collect();
						described = Some((word(at), bytes[at + 4], bytes[at + 5], size, deps));
						at += 7 + 4 * count;
					}
					self.frames.push(Received {
						media: bytes[1],
						pt: bytes[2],
						codec: bytes[3],
						flags: bytes[4],
						level: bytes[5],
						orientation: bytes[6],
						colour: bytes[7..11].try_into().unwrap(),
						time: u64::from_be_bytes(bytes[11..19].try_into().unwrap()),
						seq: u16::from_be_bytes([bytes[19], bytes[20]]),
						rid: String::from_utf8(bytes[22..22 + rid_len].to_vec()).unwrap(),
						data: bytes[at..].to_vec(),
						size,
						described,
					});
				}
				_ => {}
			}
		}
	}

	fn control(&mut self, pairs: &[(&str, &str)]) -> Fields {
		let (ptr, len) = give(&record(pairs));
		let status = unsafe { i(self.id, IN_CONTROL, ptr, len) };
		let result = self.drain().unwrap_or_default();
		assert!(
			status == STATUS_OK,
			"{pairs:?} failed: {}",
			get(&result, "error")
		);
		result
	}

	fn refused(&mut self, pairs: &[(&str, &str)]) -> String {
		let (ptr, len) = give(&record(pairs));
		let status = unsafe { i(self.id, IN_CONTROL, ptr, len) };
		assert_eq!(status, STATUS_FAILED, "{pairs:?} was not refused");
		get(&self.drain().unwrap_or_default(), "error").to_string()
	}

	fn candidate(&self) -> String {
		let (host, port) = self.address.rsplit_once(':').unwrap();
		format!("candidate:1 1 udp 2130706431 {host} {port} typ host")
	}

	#[allow(clippy::too_many_arguments)]
	fn write(
		&mut self,
		media: u8,
		pt: u8,
		flags: u8,
		level: u8,
		orientation: u8,
		time: u64,
		rid: &str,
		data: &[u8],
	) -> i32 {
		self.write_coloured(media, pt, flags, level, orientation, [0; 4], time, rid, data)
	}

	/// a frame with its color space (the color-space extension's bytes)
	#[allow(clippy::too_many_arguments)]
	fn write_coloured(
		&mut self,
		media: u8,
		pt: u8,
		flags: u8,
		level: u8,
		orientation: u8,
		colour: [u8; 4],
		time: u64,
		rid: &str,
		data: &[u8],
	) -> i32 {
		self.write_described(media, pt, flags, level, orientation, colour, time, rid, &[], data)
	}

	/// a frame with a dependency descriptor block (`media::Frame`), with
	/// `FLAG_DESCRIBED` in `flags`
	#[allow(clippy::too_many_arguments)]
	fn write_described(
		&mut self,
		media: u8,
		pt: u8,
		flags: u8,
		level: u8,
		orientation: u8,
		colour: [u8; 4],
		time: u64,
		rid: &str,
		described: &[u8],
		data: &[u8],
	) -> i32 {
		let mut bytes = vec![media, pt, flags, level, orientation];
		bytes.extend_from_slice(&colour);
		bytes.extend_from_slice(&[0, 5]);
		bytes.extend_from_slice(&time.to_be_bytes());
		bytes.push(rid.len() as u8);
		bytes.extend_from_slice(rid.as_bytes());
		bytes.extend_from_slice(described);
		bytes.extend_from_slice(data);
		let (ptr, len) = give(&bytes);
		let status = unsafe { i(self.id, IN_MEDIA_WRITE, ptr, len) };
		self.drain();
		status
	}

	fn receive(&mut self, datagram: &[u8]) {
		let (ptr, len) = give(datagram);
		unsafe { i(self.id, IN_DATAGRAM, ptr, len) };
		self.drain();
	}

	fn tick(&mut self) {
		unsafe { t(self.id) };
		self.drain();
	}

	fn event(&self, name: &str) -> Option<&Fields> {
		self.events.iter().find(|e| get(e, "ev") == name)
	}

	fn events_named(&self, name: &str) -> Vec<&Fields> {
		self.events.iter().filter(|e| get(e, "ev") == name).collect()
	}

	fn connected(&self) -> bool {
		self.event("connected").is_some()
	}
}

/// carry datagrams between the two until `done` says so
fn pump(a: &mut Peer, b: &mut Peer, what: &str, mut done: impl FnMut(&Peer, &Peer) -> bool) {
	let deadline = Instant::now() + Duration::from_secs(20);
	loop {
		for datagram in std::mem::take(&mut a.outbox) {
			b.receive(&datagram);
		}
		for datagram in std::mem::take(&mut b.outbox) {
			a.receive(&datagram);
		}
		a.tick();
		b.tick();
		if done(a, b) {
			return;
		}
		assert!(
			Instant::now() < deadline,
			"timed out waiting for {what}\na: {:?}\nb: {:?}",
			a.events,
			b.events
		);
		std::thread::sleep(Duration::from_millis(1));
	}
}

/// offer from `a`, answer from `b` (which wants `dirs` of the offer's
/// sections), candidates both ways; the two descriptions
fn negotiate(a: &mut Peer, b: &mut Peer, dirs: &[&str]) -> (String, String) {
	let offer = get(&a.control(&[("op", "offer")]), "sdp").to_string();
	let keys: Vec<String> = (0..dirs.len()).map(|n| format!("dir{n}")).collect();
	let mut pairs = vec![("op", "remote_offer"), ("sdp", offer.as_str())];
	for (key, dir) in keys.iter().zip(dirs) {
		if !dir.is_empty() {
			pairs.push((key, dir));
		}
	}
	let answer = get(&b.control(&pairs), "sdp").to_string();
	a.control(&[("op", "answer"), ("sdp", &answer)]);
	let (ca, cb) = (a.candidate(), b.candidate());
	a.control(&[("op", "remote_candidate"), ("candidate", &cb)]);
	b.control(&[("op", "remote_candidate"), ("candidate", &ca)]);
	(offer, answer)
}

fn section<'a>(sdp: &'a str, n: usize) -> Vec<&'a str> {
	let mut sections: Vec<Vec<&str>> = Vec::new();
	for line in sdp.lines() {
		if line.starts_with("m=") {
			sections.push(Vec::new());
		}
		if let Some(last) = sections.last_mut() {
			last.push(line);
		}
	}
	sections.get(n).cloned().unwrap_or_default()
}

fn has(lines: &[&str], line: &str) -> bool {
	lines.iter().any(|l| *l == line)
}

/// a VP8 keyframe's first bytes (frame tag with the key bit clear, the
/// start code, 64x48) and filler: the stack reads only the tag
fn vp8(key: bool, len: usize, fill: u8) -> Vec<u8> {
	let mut out = vec![if key { 0x10 } else { 0x11 }, 0x02, 0x00, 0x9d, 0x01, 0x2a, 64, 0, 48, 0];
	out.resize(len, fill);
	out
}

#[test]
fn audio_both_ways() {
	let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
	let mut a = Peer::media("10.0.0.1:5000");
	let mut b = Peer::media("10.0.0.2:5000");
	let index = a.control(&[
		("op", "media"),
		("kind", "audio"),
		("dir", "sendrecv"),
		("stream", "stream-a"),
		("track", "track-a"),
	]);
	assert_eq!(get(&index, "index"), "0");
	// a section the stack does not have yet has nothing negotiated
	assert_eq!(
		a.refused(&[("op", "payloads"), ("index", "0")]),
		"media not negotiated"
	);
	let (offer, answer) = negotiate(&mut a, &mut b, &["sendrecv"]);

	// the offer is the browser's codec list, in its order and numbering
	let audio = section(&offer, 0);
	assert!(audio[0].starts_with("m=audio 9 UDP/TLS/RTP/SAVPF "), "{}", audio[0]);
	let pts: Vec<&str> = audio[0].split(' ').skip(3).collect();
	assert_eq!(pts, ["63", "111", "9", "0", "8", "13", "110", "126"], "{}", audio[0]);
	for line in [
		"a=rtpmap:111 opus/48000/2",
		"a=fmtp:111 minptime=10;useinbandfec=1",
		"a=rtpmap:63 red/48000/2",
		"a=fmtp:63 111/111",
		"a=rtpmap:9 G722/8000",
		"a=rtpmap:0 PCMU/8000",
		"a=rtpmap:8 PCMA/8000",
		"a=rtpmap:13 CN/8000",
		"a=rtpmap:110 telephone-event/48000",
		"a=rtpmap:126 telephone-event/8000",
		"a=rtcp-fb:111 transport-cc",
		"a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
		"a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
		"a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
		"a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid",
		"a=msid:stream-a track-a",
		"a=sendrecv",
		"a=rtcp-mux",
	] {
		assert!(has(&audio, line), "the offer has no {line}:\n{offer}");
	}
	// no video payloads or extensions in an audio section, and nothing the
	// stack does not know
	assert!(!audio.iter().any(|l| l.contains("VP8") || l.contains("video-orientation")), "{offer}");
	assert!(!offer.contains("not-an-extension") && !offer.contains("ulpfec"), "{offer}");
	let answered = section(&answer, 0);
	assert!(has(&answered, "a=sendrecv"), "{answer}");
	assert!(has(&answered, "a=rtpmap:111 opus/48000/2"), "{answer}");

	pump(&mut a, &mut b, "the connection", |a, b| a.connected() && b.connected());

	// each side hears of the section: the offerer by its own index, the
	// answerer by a new one, both with the offer's mid
	let added_a = a.event("media").expect("no media event at the offerer").clone();
	let added_b = b.event("media").expect("no media event at the answerer").clone();
	assert_eq!(get(&added_a, "index"), "0");
	assert_eq!(get(&added_b, "index"), "0");
	assert_eq!(get(&added_a, "kind"), "audio");
	assert_eq!(get(&added_a, "dir"), "sendrecv");
	assert_eq!(get(&added_b, "dir"), "sendrecv");
	assert_eq!(get(&added_a, "mid"), get(&added_b, "mid"));
	let mid = get(&added_a, "mid").to_string();
	assert!(has(&audio, &format!("a=mid:{mid}")), "{offer}");

	// what was negotiated, the payload to send first
	let payloads = a.control(&[("op", "payloads"), ("index", "0")]);
	let codecs = get(&payloads, "codecs");
	assert!(
		codecs.starts_with("111,opus,48000,2,minptime=10;useinbandfec=1|63,red,48000,2,111/111"),
		"{codecs}"
	);
	assert!(codecs.contains("|0,PCMU,8000,,") && codecs.contains("|9,G722,16000,,"), "{codecs}");
	assert!(
		get(&payloads, "exts").contains("1:urn:ietf:params:rtp-hdrext:ssrc-audio-level"),
		"{}",
		get(&payloads, "exts")
	);
	assert_eq!(get(&payloads, "dir"), "sendrecv");

	// Opus packets one way, twenty milliseconds apart, and the other way
	let sent: Vec<Vec<u8>> = (0..25u8).map(|n| vec![0xfc, n, n ^ 0x55, 7, 7, n]).collect();
	for (n, packet) in sent.iter().enumerate() {
		let flags = if n == 0 { media::FLAG_TALKSPURT } else { 0 } | media::FLAG_VOICE;
		assert_eq!(a.write(0, 111, flags, 30, media::ABSENT, 960 * n as u64, "", packet), STATUS_OK);
		assert_eq!(b.write(0, 111, 0, media::ABSENT, media::ABSENT, 960 * n as u64, "", &[0xfc, 0xee, n as u8]), STATUS_OK);
		pump(&mut a, &mut b, "a frame each way", |a, b| a.frames.len() > n && b.frames.len() > n);
	}
	assert_eq!(b.frames.len(), sent.len());
	for (n, frame) in b.frames.iter().enumerate() {
		assert_eq!(frame.data, sent[n], "frame {n}");
		assert_eq!(frame.media, 0);
		assert_eq!(frame.pt, 111);
		assert_eq!(frame.codec, 1);
		assert_eq!(frame.level, 30, "frame {n}");
		assert!(frame.flags & media::FLAG_VOICE != 0, "frame {n}");
		assert!(frame.flags & media::FLAG_KEYFRAME == 0);
		assert_eq!(frame.rid, "");
		if n > 0 {
			assert_eq!(frame.time - b.frames[n - 1].time, 960, "frame {n}");
			assert!(frame.flags & media::FLAG_CONTIGUOUS != 0, "frame {n}");
			// one packet a frame: the packets' own numbers
			assert_eq!(frame.seq, b.frames[n - 1].seq.wrapping_add(1), "frame {n}");
		}
	}
	assert_eq!(a.frames.len(), sent.len());
	assert_eq!(a.frames[3].data, [0xfc, 0xee, 3]);
	assert_eq!(a.frames[3].level, media::ABSENT);

	// a lost packet holds nothing back: the next comes at once, marked as
	// following a loss; the lost one coming late is handed on too (NetEq
	// plays a packet that swapped places on the way, and the host puts it
	// back in its place); one that comes twice is not (str0m drops a
	// sequence number it has had: the host's own drop of a packet no newer
	// than what it decoded is for one that comes after its time)
	let before = b.frames.len();
	let packet = |n: u8| [0xfc, 0x33, n];
	a.write(0, 111, 0, media::ABSENT, media::ABSENT, 960 * 25, "", &packet(0));
	let lost = std::mem::take(&mut a.outbox);
	a.write(0, 111, 0, media::ABSENT, media::ABSENT, 960 * 26, "", &packet(1));
	let started = Instant::now();
	pump(&mut a, &mut b, "the packet after a lost one", |_, b| b.frames.len() > before);
	assert!(started.elapsed() < Duration::from_millis(500), "held back {:?}", started.elapsed());
	assert_eq!(b.frames[before].data, packet(1));
	assert!(b.frames[before].flags & media::FLAG_CONTIGUOUS == 0);
	for datagram in &lost {
		b.receive(datagram);
	}
	pump(&mut a, &mut b, "the late packet", |_, b| b.frames.len() > before + 1);
	assert_eq!(b.frames[before + 1].data, packet(0));
	assert_eq!(b.frames[before + 1].time, b.frames[before].time - 960);
	for datagram in &lost {
		b.receive(datagram);
	}
	a.write(0, 111, 0, media::ABSENT, media::ABSENT, 960 * 27, "", &packet(2));
	pump(&mut a, &mut b, "the packet after that", |_, b| b.frames.len() > before + 2);
	assert_eq!(b.frames.len(), before + 3, "the late packet was handed on twice");
	assert_eq!(b.frames[before + 2].data, packet(2));
	assert_eq!(b.frames[before + 2].time, b.frames[before].time + 960);

	// redundant audio is the peer's to read too
	a.control(&[("op", "red"), ("index", "0"), ("on", "1")]);
	let before = b.frames.len();
	for n in 0..5u64 {
		a.write(0, 111, 0, media::ABSENT, media::ABSENT, 960 * (28 + n), "", &[0xfc, 0x77, n as u8]);
		pump(&mut a, &mut b, "a redundant frame", |_, b| b.frames.len() > before + n as usize);
	}
	assert_eq!(b.frames[before + 4].data, [0xfc, 0x77, 4]);
	assert_eq!(b.frames.len(), before + 5, "a redundant block was delivered twice");

	// DTMF and comfort noise: payloads of their own, which the stack
	// passes on as they are, the first event packet marked
	let before = b.frames.len();
	let events: [(u8, &[u8]); 4] = [
		(media::FLAG_TALKSPURT, &[5, 0x0a, 0x00, 0xa0]),
		(0, &[5, 0x8a, 0x01, 0x40]),
		(0, &[5, 0x8a, 0x01, 0x40]),
		(0, &[5, 0x8a, 0x01, 0x40]),
	];
	for (n, (flags, payload)) in events.iter().enumerate() {
		assert_eq!(a.write(0, 126, *flags, media::ABSENT, media::ABSENT, 8000, "", payload), STATUS_OK);
		pump(&mut a, &mut b, "a telephone event", |_, b| b.frames.len() > before + n);
	}
	assert_eq!(a.write(0, 13, 0, media::ABSENT, media::ABSENT, 8160, "", &[40, 127]), STATUS_OK);
	pump(&mut a, &mut b, "comfort noise", |_, b| b.frames.len() > before + 4);
	let heard = &b.frames[before..];
	assert_eq!(heard.len(), 5);
	for (n, (_, payload)) in events.iter().enumerate() {
		assert_eq!((heard[n].pt, heard[n].codec), (126, 6), "event {n}");
		assert_eq!(heard[n].data, *payload, "event {n}");
		assert_eq!(heard[n].level, media::ABSENT, "event {n}");
	}
	assert!(heard[0].flags & media::FLAG_TALKSPURT != 0);
	assert_eq!((heard[4].pt, heard[4].codec), (13, 5));
	assert_eq!(heard[4].data, [40, 127]);

	// a payload the section never negotiated and a section that is not
	// there are dropped and say so in the status
	assert_eq!(a.write(0, 96, 0, media::ABSENT, media::ABSENT, 0, "", &[1]), STATUS_FAILED);
	assert_eq!(a.write(0, 77, 0, media::ABSENT, media::ABSENT, 0, "", &[1]), STATUS_FAILED);
	assert_eq!(a.write(4, 111, 0, media::ABSENT, media::ABSENT, 0, "", &[1]), STATUS_BAD_RECORD);
}

#[test]
fn video_frames_keyframes_and_estimate() {
	let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
	let mut a = Peer::media("10.0.0.1:5000");
	let mut b = Peer::media("10.0.0.2:5000");
	a.control(&[("op", "media"), ("kind", "audio"), ("dir", "sendrecv")]);
	a.control(&[("op", "media"), ("kind", "video"), ("dir", "sendrecv"), ("stream", "s"), ("track", "v")]);
	let (offer, answer) = negotiate(&mut a, &mut b, &["sendrecv", "sendrecv"]);
	let video = section(&offer, 1);
	let pts: Vec<&str> = video[0].split(' ').skip(3).collect();
	assert_eq!(pts, ["96", "97", "103", "104", "109", "114"], "{}", video[0]);
	for line in [
		"a=rtpmap:96 VP8/90000",
		"a=rtpmap:97 rtx/90000",
		"a=fmtp:97 apt=96",
		"a=rtpmap:103 H264/90000",
		"a=fmtp:103 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f",
		"a=rtcp-fb:96 goog-remb",
		"a=rtcp-fb:96 transport-cc",
		"a=rtcp-fb:96 ccm fir",
		"a=rtcp-fb:96 nack",
		"a=rtcp-fb:96 nack pli",
		"a=extmap:14 urn:ietf:params:rtp-hdrext:toffset",
		"a=extmap:13 urn:3gpp:video-orientation",
		"a=extmap:5 http://www.webrtc.org/experiments/rtp-hdrext/playout-delay",
		"a=msid:s v",
	] {
		assert!(has(&video, line), "the offer has no {line}:\n{offer}");
	}
	assert!(!video.iter().any(|l| l.contains("opus") || l.contains("ssrc-audio-level")), "{offer}");
	assert!(has(&section(&answer, 1), "a=rtpmap:96 VP8/90000"), "{answer}");
	let mids = a.control(&[("op", "offer")]);
	assert_eq!(get(&mids, "mids").split(',').count(), 2, "{mids:?}");

	pump(&mut a, &mut b, "the connection", |a, b| {
		a.connected() && b.connected() && a.events_named("media").len() == 2 && b.events_named("media").len() == 2
	});
	let payloads = a.control(&[("op", "payloads"), ("index", "1")]);
	assert!(get(&payloads, "codecs").starts_with("96,VP8,90000,,|97,rtx,90000,,apt=96|103,H264,90000,,"), "{payloads:?}");

	// a keyframe of several packets, then deltas: whole frames come out,
	// the first marked as a keyframe, with the rotation it was sent with
	let key = vp8(true, 5000, 0xa5);
	// BT.709 primaries, sRGB transfer, BT.709 matrix, full range: Chrome
	// 156's canvas pictures
	let colour = [1, 13, 1, 2 << 4];
	assert_eq!(a.write_coloured(1, 96, 0, media::ABSENT, 3, colour, 0, "", &key), STATUS_OK);
	pump(&mut a, &mut b, "the keyframe", |_, b| !b.frames.is_empty());
	assert_eq!(b.frames[0].data, key);
	assert_eq!(b.frames[0].media, 1);
	assert_eq!(b.frames[0].codec, 10);
	assert!(b.frames[0].flags & media::FLAG_KEYFRAME != 0);
	assert_eq!(b.frames[0].orientation, 3);
	assert_eq!(b.frames[0].colour, colour, "the color space did not cross");
	for n in 1..=30u64 {
		let delta = vp8(false, 900 + n as usize, n as u8);
		a.write(1, 96, 0, media::ABSENT, media::ABSENT, 3000 * n, "", &delta);
		pump(&mut a, &mut b, "a delta frame", |_, b| b.frames.len() > n as usize);
		assert_eq!(b.frames[n as usize].data, delta, "frame {n}");
		assert!(b.frames[n as usize].flags & media::FLAG_KEYFRAME == 0, "frame {n}");
		assert_eq!(b.frames[n as usize].time - b.frames[n as usize - 1].time, 3000, "frame {n}");
		assert_eq!(b.frames[n as usize].colour, [0; 4], "frame {n} says a color space");
	}

	// H.264 in Annex B both ways: the parameter sets and the picture of a
	// keyframe arrive as one access unit
	let mut unit = Vec::new();
	for nal in [
		&[0x67, 0x42, 0x00, 0x1f, 0x8c, 0x8d, 0x40][..],
		&[0x68, 0xce, 0x3c, 0x80][..],
		&[&[0x65, 0x88, 0x84][..], &[0x5a; 3000][..]].concat()[..],
	] {
		unit.extend_from_slice(&[0, 0, 0, 1]);
		unit.extend_from_slice(nal);
	}
	let before = b.frames.len();
	assert_eq!(a.write(1, 103, 0, media::ABSENT, media::ABSENT, 3000 * 31, "", &unit), STATUS_OK);
	pump(&mut a, &mut b, "the H.264 keyframe", |_, b| b.frames.len() > before);
	assert_eq!(b.frames[before].codec, 12);
	assert_eq!(b.frames[before].pt, 103);
	assert!(b.frames[before].flags & media::FLAG_KEYFRAME != 0);
	assert_eq!(b.frames[before].data, unit, "the access unit is not as it was sent");

	// the receiver lost a picture: the sender is asked for a keyframe
	b.control(&[("op", "keyframe"), ("index", "1"), ("kind", "pli")]);
	pump(&mut a, &mut b, "the keyframe request", |a, _| a.event("keyframe").is_some());
	let request = a.event("keyframe").unwrap();
	assert_eq!(get(request, "index"), "1");
	assert_eq!(get(request, "kind"), "pli");
	b.control(&[("op", "keyframe"), ("index", "1"), ("kind", "fir")]);
	pump(&mut a, &mut b, "the full intra request", |a, _| {
		a.events_named("keyframe").iter().any(|e| get(e, "kind") == "fir")
	});
	// an audio section has no keyframes to ask for
	assert!(!b.refused(&[("op", "keyframe"), ("index", "0")]).is_empty());

	// the estimator reports what the path carries once feedback arrives
	a.control(&[("op", "bitrate"), ("min", "100000"), ("desired", "2500000")]);
	let start = Instant::now();
	let mut n = 32u64;
	while a.event("bitrate").is_none() {
		assert!(start.elapsed() < Duration::from_secs(20), "no bitrate estimate: {:?}", a.events);
		a.write(1, 96, 0, media::ABSENT, media::ABSENT, 3000 * n, "", &vp8(false, 1200, n as u8));
		n += 1;
		// thirty frames a second
		let until = Instant::now() + Duration::from_millis(33);
		pump(&mut a, &mut b, "a frame interval", |_, _| Instant::now() >= until);
	}
	let estimate = a.event("bitrate").unwrap();
	assert_eq!(get(estimate, "kind"), "twcc");
	assert!(get(estimate, "bps").parse::<u64>().unwrap() > 0, "{estimate:?}");
}

#[test]
fn directions_as_a_browser_answers() {
	let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
	let mut a = Peer::media("10.0.0.1:5000");
	let mut b = Peer::media("10.0.0.2:5000");
	a.control(&[("op", "media"), ("kind", "audio"), ("dir", "sendrecv")]);
	a.control(&[("op", "media"), ("kind", "video"), ("dir", "sendonly")]);
	a.control(&[("op", "media"), ("kind", "video"), ("dir", "recvonly")]);
	a.control(&[("op", "media"), ("kind", "audio"), ("dir", "sendrecv")]);
	// the answerer has no track for the first section, sends on the second
	// if it may (it may not), sends on the third, wants nothing of the fourth
	let (offer, answer) = negotiate(&mut a, &mut b, &["recvonly", "sendrecv", "sendrecv", "inactive"]);
	for (n, dir) in ["a=sendrecv", "a=sendonly", "a=recvonly", "a=sendrecv"].iter().enumerate() {
		assert!(has(&section(&offer, n), dir), "section {n} of the offer is not {dir}:\n{offer}");
	}
	for (n, dir) in ["a=recvonly", "a=recvonly", "a=sendonly", "a=inactive"].iter().enumerate() {
		assert!(has(&section(&answer, n), dir), "section {n} of the answer is not {dir}:\n{answer}");
	}
	pump(&mut a, &mut b, "the connection", |a, b| {
		a.connected() && b.connected() && a.events_named("media").len() == 4 && b.events_named("media").len() == 4
	});
	let dirs = |peer: &Peer| -> Vec<String> {
		let mut events = peer.events_named("media");
		events.sort_by_key(|e| get(e, "index").parse::<usize>().unwrap());
		events.iter().map(|e| get(e, "dir").to_string()).collect()
	};
	assert_eq!(dirs(&a), ["sendonly", "sendonly", "recvonly", "inactive"]);
	assert_eq!(dirs(&b), ["recvonly", "recvonly", "sendonly", "inactive"]);

	// frames flow where the answer lets them and nowhere else
	a.write(0, 111, 0, media::ABSENT, media::ABSENT, 0, "", &[0xfc, 1]);
	b.write(0, 111, 0, media::ABSENT, media::ABSENT, 0, "", &[0xfc, 2]);
	b.write(2, 96, 0, media::ABSENT, media::ABSENT, 0, "", &vp8(true, 200, 1));
	a.write(2, 96, 0, media::ABSENT, media::ABSENT, 0, "", &vp8(true, 200, 2));
	a.write(3, 111, 0, media::ABSENT, media::ABSENT, 0, "", &[0xfc, 3]);
	pump(&mut a, &mut b, "the frames", |a, b| !a.frames.is_empty() && !b.frames.is_empty());
	for _ in 0..50 {
		pump(&mut a, &mut b, "quiet", |_, _| true);
	}
	assert_eq!(b.frames.len(), 1, "{:?}", b.frames);
	assert_eq!((b.frames[0].media, b.frames[0].data.as_slice()), (0, &[0xfc, 1][..]));
	assert_eq!(a.frames.len(), 1, "{:?}", a.frames);
	assert_eq!(a.frames[0].media, 2);

	// the offerer's next offer states what it wanted, not what it got; the
	// answerer, with a track now, takes all of the first section
	let again = get(&a.control(&[("op", "offer")]), "sdp").to_string();
	assert!(has(&section(&again, 0), "a=sendrecv"), "{again}");
	assert!(has(&section(&again, 3), "a=sendrecv"), "{again}");
	// that offer rolled back: the sections are as they were negotiated
	a.control(&[("op", "rollback")]);
	assert_eq!(get(&a.control(&[("op", "payloads"), ("index", "0")]), "dir"), "sendonly");
	assert_eq!(get(&a.control(&[("op", "payloads"), ("index", "3")]), "dir"), "inactive");
	let (_, answer) = negotiate(&mut a, &mut b, &["sendrecv", "recvonly", "sendonly", "inactive"]);
	assert!(has(&section(&answer, 0), "a=sendrecv"), "{answer}");
	assert_eq!(get(&a.control(&[("op", "payloads"), ("index", "0")]), "dir"), "sendrecv");
	assert_eq!(get(&b.control(&[("op", "payloads"), ("index", "0")]), "dir"), "sendrecv");
	assert_eq!(get(&b.control(&[("op", "payloads"), ("index", "1")]), "dir"), "recvonly");
	let before = a.frames.len();
	b.write(0, 111, 0, media::ABSENT, media::ABSENT, 960, "", &[0xfc, 9]);
	pump(&mut a, &mut b, "audio the other way", |a, _| a.frames.len() > before);
	assert_eq!(a.frames[before].data, [0xfc, 9]);

	// the answerer offers in its turn: its sections state what it wanted
	// of them when it answered
	b.control(&[("op", "direction"), ("index", "3"), ("dir", "recvonly")]);
	let offer = get(&b.control(&[("op", "offer")]), "sdp").to_string();
	for (n, dir) in ["a=sendrecv", "a=recvonly", "a=sendonly", "a=recvonly"].iter().enumerate() {
		assert!(has(&section(&offer, n), dir), "section {n} of the answerer's offer is not {dir}:\n{offer}");
	}
	assert!(!b.refused(&[("op", "direction"), ("index", "9"), ("dir", "recvonly")]).is_empty());
	assert!(!b.refused(&[("op", "direction"), ("index", "0"), ("dir", "sideways")]).is_empty());
}

#[test]
fn a_section_paired_and_narrowed_by_the_answerer() {
	let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
	let mut a = Peer::media("10.0.0.1:5000");
	let mut b = Peer::media("10.0.0.2:5000");
	a.control(&[("op", "media"), ("kind", "audio"), ("dir", "sendonly")]);
	// the answerer's page added a track before the offer came: a section
	// of its own, which the offer's takes the place of
	assert_eq!(get(&b.control(&[("op", "media"), ("kind", "audio")]), "index"), "0");
	let offer = get(&a.control(&[("op", "offer")]), "sdp").to_string();
	let accepted = b.control(&[("op", "remote_offer"), ("sdp", &offer), ("dir0", "sendrecv")]);
	assert!(get(&accepted, "mids").starts_with("1:"), "{accepted:?}");
	b.control(&[("op", "withdraw"), ("index", "0")]);
	assert!(!b.refused(&[("op", "withdraw"), ("index", "1")]).is_empty());
	assert!(!b.refused(&[("op", "withdraw"), ("index", "7")]).is_empty());
	// the offer only sends: the section does not send here, and still
	// has a source to name, the same one every time it is asked
	assert_eq!(get(&b.control(&[("op", "payloads"), ("index", "1")]), "dir"), "recvonly");
	let source = get(&b.control(&[("op", "ssrc"), ("index", "1")]), "ssrc").to_string();
	assert!(source.parse::<u32>().is_ok(), "{source}");
	assert_eq!(get(&b.control(&[("op", "ssrc"), ("index", "1")]), "ssrc"), source);
	assert!(!b.refused(&[("op", "ssrc"), ("index", "0")]).is_empty());
	a.control(&[("op", "answer"), ("sdp", get(&accepted, "sdp"))]);
	let (ca, cb) = (a.candidate(), b.candidate());
	a.control(&[("op", "remote_candidate"), ("candidate", &cb)]);
	b.control(&[("op", "remote_candidate"), ("candidate", &ca)]);
	pump(&mut a, &mut b, "the connection", |a, b| a.connected() && b.connected());
	a.write(0, 111, 0, media::ABSENT, media::ABSENT, 0, "", &[0xfc, 1]);
	pump(&mut a, &mut b, "a frame", |_, b| b.frames.len() == 1);
	assert_eq!(b.frames[0].media, 1);

	// the page answers with less than the stack took: nothing arrives
	b.control(&[("op", "direction_now"), ("index", "1"), ("dir", "inactive")]);
	assert_eq!(get(&b.control(&[("op", "payloads"), ("index", "1")]), "dir"), "inactive");
	a.write(0, 111, 0, media::ABSENT, media::ABSENT, 960, "", &[0xfc, 2]);
	for _ in 0..50 {
		pump(&mut a, &mut b, "quiet", |_, _| true);
	}
	assert_eq!(b.frames.len(), 1, "{:?}", b.frames);
	pump(&mut a, &mut b, "the change", |_, b| {
		b.events_named("media_changed").iter().any(|e| get(e, "dir") == "inactive")
	});
	b.control(&[("op", "direction_now"), ("index", "1"), ("dir", "recvonly")]);
	a.write(0, 111, 0, media::ABSENT, media::ABSENT, 1920, "", &[0xfc, 3]);
	pump(&mut a, &mut b, "a frame again", |_, b| b.frames.len() == 2);
	assert_eq!(b.frames[1].data, [0xfc, 3]);
	assert!(!b.refused(&[("op", "direction_now"), ("index", "0"), ("dir", "recvonly")]).is_empty());
	assert!(!b.refused(&[("op", "direction_now"), ("index", "1"), ("dir", "up")]).is_empty());

	// the answerer's own offer: the one section, sending from the source
	// it named, and nothing of the section it took back
	let offer = get(&b.control(&[("op", "offer")]), "sdp").to_string();
	assert_eq!(offer.matches("m=audio").count(), 1, "{offer}");
	assert!(has(&section(&offer, 0), "a=sendrecv"), "{offer}");
	assert!(offer.contains(&format!("a=ssrc:{source} ")), "{source}\n{offer}");
}

#[test]
fn each_negotiation_sets_the_codecs_anew() {
	let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
	let mut a = Peer::media("10.0.0.1:5000");
	let mut b = Peer::media("10.0.0.2:5000");
	a.control(&[("op", "media"), ("kind", "audio")]);
	// an answer that takes PCMU alone (a peer that prefers it)
	let offer = get(&a.control(&[("op", "offer")]), "sdp").to_string();
	let answer = get(&b.control(&[("op", "remote_offer"), ("sdp", &offer), ("dir0", "sendrecv")]), "sdp")
		.to_string();
	// the answer (of one section) with these payloads alone, their lines
	// in this order, as a browser writes them
	let only = |sdp: &str, pts: &str| -> String {
		let kept: Vec<&str> = pts.split(' ').collect();
		let payload = |line: &str| {
			["a=rtpmap:", "a=fmtp:", "a=rtcp-fb:"]
				.iter()
				.find_map(|prefix| line.strip_prefix(prefix))
				.map(|rest| rest.split(' ').next().unwrap_or("").to_string())
		};
		let mut out: Vec<String> = Vec::new();
		for line in sdp.lines() {
			if payload(line).is_some() {
				continue;
			}
			if line.starts_with("m=audio") {
				let head: Vec<&str> = line.split(' ').take(3).collect();
				out.push(format!("{} {pts}", head.join(" ")));
			} else {
				out.push(line.to_string());
			}
		}
		for pt in &kept {
			for line in sdp.lines() {
				if payload(line).as_deref() == Some(*pt) {
					out.push(line.to_string());
				}
			}
		}
		out.join("\r\n") + "\r\n"
	};
	a.control(&[("op", "answer"), ("sdp", &only(&answer, "0"))]);
	let first = |peer: &mut Peer| {
		let codecs = get(&peer.control(&[("op", "payloads"), ("index", "0")]), "codecs").to_string();
		codecs.split(',').nth(1).unwrap_or("").to_string()
	};
	assert_eq!(first(&mut a), "PCMU");
	// offered again with nothing new: a real offer, with every codec
	let again = get(&a.control(&[("op", "offer")]), "sdp").to_string();
	let line = again.lines().find(|line| line.starts_with("m=audio")).unwrap_or("").to_string();
	let pts: Vec<&str> = line.split(' ').skip(3).collect();
	for pt in ["111", "63", "9", "0", "8", "13", "110", "126"] {
		assert!(pts.contains(&pt), "{line}");
	}
	assert!(again.contains("a=rtpmap:9 G722/8000"), "{again}");
	// and its answer is a negotiation: G.722 first now
	let answer = get(&b.control(&[("op", "remote_offer"), ("sdp", &again), ("dir0", "sendrecv")]), "sdp")
		.to_string();
	a.control(&[("op", "answer"), ("sdp", &only(&answer, "9 0 111"))]);
	assert_eq!(first(&mut a), "G722");
}

#[test]
fn the_peers_reports_for_the_stats() {
	let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
	let mut a = Peer::media("10.0.0.1:5000");
	let mut b = Peer::media("10.0.0.2:5000");
	a.control(&[("op", "media"), ("kind", "audio"), ("dir", "sendrecv")]);
	negotiate(&mut a, &mut b, &["sendrecv"]);
	pump(&mut a, &mut b, "the connection", |a, b| a.connected() && b.connected());
	// nothing heard yet: the streams, and no report of either
	let first = a.control(&[("op", "rtcp"), ("index", "0")]);
	assert!(get(&first, "tx").parse::<u32>().is_ok(), "{first:?}");
	assert!(!first.iter().any(|(key, _)| key.starts_with("rr_") || key.starts_with("sr_")), "{first:?}");
	// sound both ways until each side has the other's reports
	let deadline = Instant::now() + Duration::from_secs(15);
	let mut time = 0u64;
	let report = loop {
		a.write(0, 111, 0, media::ABSENT, media::ABSENT, time, "", &[0xfc, 1, 2, 3]);
		b.write(0, 111, 0, media::ABSENT, media::ABSENT, time, "", &[0xfc, 4, 5, 6]);
		time += 960;
		pump(&mut a, &mut b, "a step", |_, _| true);
		let report = a.control(&[("op", "rtcp"), ("index", "0")]);
		let has = |key: &str| report.iter().any(|(name, _)| name == key);
		if has("rr_age") && has("sr_age") {
			break report;
		}
		assert!(Instant::now() < deadline, "no reports: {report:?}");
		std::thread::sleep(Duration::from_millis(20));
	};
	assert!(get(&report, "rx").parse::<u32>().is_ok(), "{report:?}");
	assert_eq!(get(&report, "rr_lost"), "0", "{report:?}");
	assert!(get(&report, "rr_age").parse::<u64>().is_ok(), "{report:?}");
	assert!(get(&report, "sr_count").parse::<u64>().is_ok_and(|n| n >= 1), "{report:?}");
	assert!(get(&report, "sr_packets").parse::<u32>().is_ok_and(|n| n >= 1), "{report:?}");
	// the sender's wallclock, in microseconds since 1970: this year's
	assert!(get(&report, "sr_ntp").parse::<u64>().is_ok_and(|us| us > 1_700_000_000_000_000), "{report:?}");
}

#[test]
fn rollback_keeps_what_was_added() {
	let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
	let mut a = Peer::media("10.0.0.1:5000");
	let mut b = Peer::media("10.0.0.2:5000");
	a.control(&[("op", "channel"), ("label", "data")]);
	a.control(&[("op", "media"), ("kind", "audio")]);
	let first = get(&a.control(&[("op", "offer")]), "sdp").to_string();
	let order = |sdp: &str| -> Vec<String> {
		sdp.lines()
			.filter_map(|l| l.strip_prefix("m="))
			.map(|l| l.split(' ').next().unwrap_or("").to_string())
			.collect()
	};
	// media sections first, the data section after them, as a browser
	// orders a first offer whichever the page made first
	assert_eq!(order(&first), ["audio", "application"], "{first}");
	// a second offer before the first is answered carries the same sections
	a.control(&[("op", "media"), ("kind", "video"), ("rids", "h,m,l")]);
	let second = get(&a.control(&[("op", "offer")]), "sdp").to_string();
	assert_eq!(order(&second), ["audio", "video", "application"], "{second}");
	{
		let mut c = Peer::media("10.0.0.3:5000");
		c.control(&[("op", "media"), ("kind", "video")]);
		c.control(&[("op", "channel"), ("label", "one")]);
		c.control(&[("op", "media"), ("kind", "audio")]);
		c.control(&[("op", "channel"), ("label", "two")]);
		let offer = get(&c.control(&[("op", "offer")]), "sdp").to_string();
		assert_eq!(order(&offer), ["video", "audio", "application"], "{offer}");
	}
	// the layers of a simulcast section, as the offer names them
	let video = second.lines().skip_while(|l| !l.starts_with("m=video")).collect::<Vec<_>>();
	for line in ["a=rid:h send", "a=rid:m send", "a=rid:l send", "a=simulcast:send h;m;l"] {
		assert!(has(&video, line), "the offer has no {line}:\n{second}");
	}
	a.control(&[("op", "rollback")]);
	let (offer, _) = negotiate(&mut a, &mut b, &["sendrecv", "recvonly", ""]);
	assert_eq!(order(&offer), ["audio", "video", "application"], "{offer}");
	pump(&mut a, &mut b, "the connection and the channel", |a, b| {
		a.connected() && b.connected() && a.event("channel_open").is_some() && b.event("channel_open").is_some()
	});
	assert_eq!(a.events_named("media").len(), 2);
	let video = a.events_named("media").into_iter().find(|e| get(e, "kind") == "video").unwrap().clone();
	assert_eq!(get(&video, "send_rids"), "h,m,l");
	// a layer is written by its rid and arrives named
	a.write(1, 96, 0, media::ABSENT, media::ABSENT, 0, "h", &vp8(true, 300, 1));
	a.write(1, 96, 0, media::ABSENT, media::ABSENT, 0, "l", &vp8(true, 100, 2));
	pump(&mut a, &mut b, "both layers", |_, b| b.frames.len() >= 2);
	let mut rids: Vec<&str> = b.frames.iter().map(|f| f.rid.as_str()).collect();
	rids.sort();
	assert_eq!(rids, ["h", "l"]);
	assert_eq!(a.write(1, 96, 0, media::ABSENT, media::ABSENT, 0, "x", &vp8(true, 100, 3)), STATUS_FAILED);
}

#[test]
fn an_offer_read_twice_and_one_replaced() {
	let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
	let mut a = Peer::media("10.0.0.1:5000");
	let mut b = Peer::media("10.0.0.2:5000");
	a.control(&[("op", "channel"), ("label", "chat")]);
	a.control(&[("op", "channel"), ("label", "agreed"), ("negotiated", "7")]);
	// a draft, then the offer: the same description, still answerable
	let draft = get(&a.control(&[("op", "offer")]), "sdp").to_string();
	let offer = get(&a.control(&[("op", "offer")]), "sdp").to_string();
	assert_eq!(draft, offer);
	// something new before the answer: one offer that carries both, and
	// the stack still standing (it panics on a negotiated channel offered
	// twice, so that one stays out)
	a.control(&[("op", "media"), ("kind", "audio")]);
	let replaced = get(&a.control(&[("op", "offer")]), "sdp").to_string();
	assert_eq!(replaced.matches("m=application").count(), 1, "{replaced}");
	assert_eq!(replaced.matches("m=audio").count(), 1, "{replaced}");
	negotiate(&mut a, &mut b, &["sendrecv", ""]);
	pump(&mut a, &mut b, "the channel and the section", |a, b| {
		a.connected()
			&& b.connected()
			&& a.events_named("channel_open").iter().any(|e| get(e, "label") == "chat")
			&& b.event("channel_open").is_some()
			&& a.event("media").is_some()
	});
}

#[test]
fn sections_take_the_names_the_host_gives() {
	let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
	let mut a = Peer::media("10.0.0.1:5000");
	let mut b = Peer::media("10.0.0.2:5000");
	a.control(&[("op", "channel"), ("label", "chat")]);
	a.control(&[("op", "media"), ("kind", "audio")]);
	// the names in the order a browser gives them: media, then data
	let made = a.control(&[("op", "offer"), ("names", "0,1,2")]);
	let first = get(&made, "sdp").to_string();
	assert!(first.contains("a=group:BUNDLE 0 1\r\n"), "{first}");
	assert!(has(&section(&first, 0), "a=mid:0") && section(&first, 0)[0].starts_with("m=audio"), "{first}");
	assert!(has(&section(&first, 1), "a=mid:1") && section(&first, 1)[0].starts_with("m=application"), "{first}");
	assert_eq!(get(&made, "mids"), "0:0");
	// asked again with nothing new, the offer stands under its names
	assert_eq!(get(&a.control(&[("op", "offer"), ("names", "2,3,4")]), "sdp"), first);
	// rolled back and offered again: the names it is given now
	a.control(&[("op", "rollback")]);
	let made = a.control(&[("op", "offer"), ("names", "2,3,4")]);
	let offer = get(&made, "sdp").to_string();
	assert!(offer.contains("a=group:BUNDLE 2 3\r\n"), "{offer}");
	assert_eq!(get(&made, "mids"), "0:2");
	let answer = get(&b.control(&[("op", "remote_offer"), ("sdp", &offer), ("dir0", "sendrecv")]), "sdp").to_string();
	a.control(&[("op", "answer"), ("sdp", &answer)]);
	let (ca, cb) = (a.candidate(), b.candidate());
	a.control(&[("op", "remote_candidate"), ("candidate", &cb)]);
	b.control(&[("op", "remote_candidate"), ("candidate", &ca)]);
	pump(&mut a, &mut b, "the connection", |a, b| a.connected() && b.connected());
	// what the offerer sends arrives on the section of that name
	a.write(0, 111, 0, media::ABSENT, media::ABSENT, 0, "", &[0xfc, 1]);
	pump(&mut a, &mut b, "a frame", |_, b| b.frames.len() == 1);
	// a name a section has is passed over, and a section there is no
	// name left for is named as the stack names one
	a.control(&[("op", "media"), ("kind", "video")]);
	a.control(&[("op", "media"), ("kind", "audio")]);
	let named = get(&a.control(&[("op", "offer"), ("names", "3,2,5")]), "mids").to_string();
	assert!(named.starts_with("0:2,1:5,2:") && !named.ends_with(":"), "{named}");
	a.control(&[("op", "rollback")]);
	let unnamed = get(&a.control(&[("op", "offer")]), "mids").to_string();
	assert!(unnamed.starts_with("0:2,1:") && !unnamed.starts_with("0:2,1:5,"), "{unnamed}");
	// the answerer's own offer: the offer's names stay, its new section
	// takes the one it is given
	b.control(&[("op", "media"), ("kind", "video")]);
	let made = b.control(&[("op", "offer"), ("names", "0,1")]);
	let offer = get(&made, "sdp").to_string();
	assert!(offer.contains("a=group:BUNDLE 2 3 0\r\n"), "{offer}");
}

#[test]
fn a_connection_without_media_is_as_it_was() {
	let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
	let mut a = Peer::new("10.0.0.1:5000", &[]);
	let mut b = Peer::new("10.0.0.2:5000", &[]);
	a.control(&[("op", "channel"), ("label", "data")]);
	let (offer, answer) = negotiate(&mut a, &mut b, &[]);
	assert!(!offer.contains("m=audio") && !offer.contains("m=video"), "{offer}");
	assert!(answer.contains("a=setup:active"), "{answer}");
	pump(&mut a, &mut b, "the channel", |a, b| a.event("channel_open").is_some() && b.event("channel_open").is_some());
	assert!(a.event("media").is_none() && b.event("media").is_none());
}

/// the destination of a transmit record as it sits in the outbox
fn destination(datagram: &[u8]) -> String {
	let src = u16::from_be_bytes([datagram[1], datagram[2]]) as usize;
	let at = 3 + src;
	let dst = u16::from_be_bytes([datagram[at], datagram[at + 1]]) as usize;
	String::from_utf8(datagram[at + 2..at + 2 + dst].to_vec()).unwrap()
}

#[test]
fn a_remote_whose_pair_is_given_up_leaves_the_list() {
	let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
	let mut a = Peer::new("10.0.0.1:5000", &[]);
	let mut b = Peer::new("10.0.0.2:5000", &[]);
	a.control(&[("op", "channel"), ("label", "data")]);
	negotiate(&mut a, &mut b, &[]);
	// a candidate of b's that nothing answers at
	a.control(&[("op", "remote_candidate"), ("candidate", "candidate:2 1 udp 2130706430 10.0.0.9 5000 typ host")]);
	let lists = |peer: &Peer| -> Vec<String> {
		peer.events_named("remotes").iter().map(|e| get(e, "list").to_string()).collect()
	};
	let deadline = Instant::now() + Duration::from_secs(40);
	let mut checks = 0;
	loop {
		for datagram in std::mem::take(&mut a.outbox) {
			if destination(&datagram) == "10.0.0.9:5000" {
				checks += 1;
			} else {
				b.receive(&datagram);
			}
		}
		for datagram in std::mem::take(&mut b.outbox) {
			a.receive(&datagram);
		}
		a.tick();
		b.tick();
		// (the descriptions carry the TCP candidates str0m writes, which
		// the worker never hands on: here they pair too)
		let last = lists(&a).last().cloned().unwrap_or_default();
		if last.starts_with("udp/10.0.0.2:5000") && !last.contains("10.0.0.9") && checks > 0 {
			break;
		}
		assert!(Instant::now() < deadline, "the unanswered pair stayed: {:?} after {checks} checks", lists(&a));
		std::thread::sleep(Duration::from_millis(2));
	}
	let seen = lists(&a);
	assert!(seen.iter().any(|list| list.starts_with("udp/10.0.0.2:5000,udp/10.0.0.9:5000")), "{seen:?}");
	assert!(a.connected() && b.connected());
	// nothing more goes to it
	let before = checks;
	for _ in 0..200 {
		for datagram in std::mem::take(&mut a.outbox) {
			if destination(&datagram) == "10.0.0.9:5000" {
				checks += 1;
			} else {
				b.receive(&datagram);
			}
		}
		for datagram in std::mem::take(&mut b.outbox) {
			a.receive(&datagram);
		}
		a.tick();
		b.tick();
		std::thread::sleep(Duration::from_millis(5));
	}
	assert_eq!(checks, before, "checks went on to the given up remote");
	// b was told of a by a's checks alone (a peer reflexive candidate)
	assert!(lists(&b).last().is_some_and(|list| list.starts_with("udp/10.0.0.1:5000")), "{:?}", lists(&b));
}

/// A message sent while the path is gone (every datagram lost, both ways,
/// for 10 s) arrives within 3 s of the path coming back: Chrome's dcSCTP
/// backs its retransmission timer off to 3 s at most (157, measured);
/// sctp-proto's own limit of 60 s sent it again 3, 9, 21 and 45 s after
/// it was written, so 11 s after this outage
#[test]
fn a_message_sent_into_an_outage_arrives_soon_after_it() {
	let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
	let mut a = Peer::new("10.0.0.1:5000", &[]);
	let mut b = Peer::new("10.0.0.2:5000", &[]);
	let index: u16 = get(&a.control(&[("op", "channel"), ("label", "data")]), "index").parse().unwrap();
	negotiate(&mut a, &mut b, &[]);
	pump(&mut a, &mut b, "the channel", |a, b| a.event("channel_open").is_some() && b.event("channel_open").is_some());
	let mut message = index.to_be_bytes().to_vec();
	message.push(0);
	message.extend_from_slice(b"held");
	let (ptr, len) = give(&message);
	assert_eq!(unsafe { i(a.id, IN_CHANNEL_SEND, ptr, len) }, STATUS_OK);
	a.drain();
	let lost = Instant::now();
	while lost.elapsed() < Duration::from_secs(10) {
		a.outbox.clear();
		b.outbox.clear();
		a.tick();
		b.tick();
		std::thread::sleep(Duration::from_millis(5));
	}
	a.outbox.clear();
	b.outbox.clear();
	assert!(b.messages.is_empty());
	let back = Instant::now();
	pump(&mut a, &mut b, "the message", |_, b| !b.messages.is_empty());
	let took = back.elapsed();
	assert_eq!(b.messages, vec![b"held".to_vec()]);
	assert!(took < Duration::from_millis(3500), "arrived {took:?} after the path came back");
}

/// A channel written to while nothing but checks crosses hands on what
/// Chrome's would (157, measured: 4-byte messages every 200 ms, 59 of
/// them, the window after a retransmission timeout being 1191 bytes and
/// each chunk counting 20) and keeps the rest; its bufferedAmount reads
/// only what it keeps, and all of them arrive, in order, once the path is
/// back. sctp-proto sent every one, its window counting the bytes of the
/// messages only, and counted what was sent and not acknowledged as
/// buffered.
#[test]
fn a_channel_written_to_in_an_outage_holds_what_chromes_holds() {
	let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
	let mut a = Peer::new("10.0.0.1:5000", &[]);
	let mut b = Peer::new("10.0.0.2:5000", &[]);
	let index: u16 = get(&a.control(&[("op", "channel"), ("label", "data")]), "index").parse().unwrap();
	negotiate_udp(&mut a, &mut b);
	pump(&mut a, &mut b, "the channel", |a, b| a.event("channel_open").is_some() && b.event("channel_open").is_some());
	let stun = |datagram: &[u8]| parse_datagram(datagram).is_some_and(|(_, _, _, payload)| payload.first().is_some_and(|b| *b < 4));
	// the channel's own open message acknowledged, as in a call that has
	// gone on a while
	run(&mut a, &mut b, 1000, false, &mut Vec::new(), None);
	let name = index.to_string();
	let buffered = |a: &Peer| {
		a.events_named("buffered")
			.iter()
			.rev()
			.find(|e| get(e, "index") == name)
			.map(|e| get(e, "amount").parse::<usize>().unwrap())
			.unwrap_or(0)
	};
	let mut amounts = Vec::new();
	let mut sent = Vec::new();
	let mut next = Instant::now();
	let end = Instant::now() + Duration::from_millis(14000);
	while Instant::now() < end {
		if Instant::now() >= next {
			let body = format!("m{:03}", sent.len());
			let mut message = index.to_be_bytes().to_vec();
			message.push(0);
			message.extend_from_slice(body.as_bytes());
			let (ptr, len) = give(&message);
			assert_eq!(unsafe { i(a.id, IN_CHANNEL_SEND, ptr, len) }, STATUS_OK);
			a.drain();
			sent.push(body.into_bytes());
			amounts.push(buffered(&a));
			next += Duration::from_millis(200);
		}
		for datagram in std::mem::take(&mut a.outbox) {
			if stun(&datagram) {
				b.receive(&datagram);
			}
		}
		for datagram in std::mem::take(&mut b.outbox) {
			if stun(&datagram) {
				a.receive(&datagram);
			}
		}
		a.tick();
		b.tick();
		std::thread::sleep(Duration::from_millis(1));
	}
	assert!(b.messages.is_empty());
	let out = amounts.iter().take_while(|amount| **amount == 0).count();
	assert!(out == 59, "{out} of {} messages handed on in the outage, bufferedAmount {amounts:?}", sent.len());
	let held: Vec<usize> = (1..=sent.len() - out).map(|n| n * 4).collect();
	assert_eq!(amounts[out..], held[..], "bufferedAmount once the window was full");
	pump(&mut a, &mut b, "the messages", |_, b| b.messages.len() >= sent.len());
	assert_eq!(b.messages, sent);
	pump(&mut a, &mut b, "nothing buffered", |a, _| buffered(a) == 0);
}

/// whether a datagram is a STUN binding request (a check)
fn is_check(datagram: &[u8]) -> bool {
	parse_datagram(datagram).is_some_and(|(_, _, _, payload)| payload.starts_with(&[0, 1]))
}

/// `negotiate` without the TCP candidates the descriptions carry (which
/// the worker never hands on): a UDP pair, as in a call through the proxy
fn negotiate_udp(a: &mut Peer, b: &mut Peer) {
	let udp = |sdp: &str| {
		sdp.split("\r\n").filter(|line| !(line.starts_with("a=candidate:") && line.contains(" tcp "))).collect::<Vec<_>>().join("\r\n")
	};
	let offer = udp(get(&a.control(&[("op", "offer")]), "sdp"));
	let answer = udp(get(&b.control(&[("op", "remote_offer"), ("sdp", &offer)]), "sdp"));
	a.control(&[("op", "answer"), ("sdp", &answer)]);
	let (ca, cb) = (a.candidate(), b.candidate());
	a.control(&[("op", "remote_candidate"), ("candidate", &cb)]);
	b.control(&[("op", "remote_candidate"), ("candidate", &ca)]);
}

/// Carry datagrams between the two for `ms`, or drop every one when
/// `lost`; the checks `a` sent, by destination, at their times. When `a`
/// last heard from `b`. With a channel `pulse`, `a` sends a message on it
/// every 200 ms, as a call's data flows.
fn run(a: &mut Peer, b: &mut Peer, ms: u64, lost: bool, checks: &mut Vec<(String, Instant)>, pulse: Option<u16>) -> Option<Instant> {
	let end = Instant::now() + Duration::from_millis(ms);
	let mut heard = None;
	let mut next = Instant::now();
	while Instant::now() < end {
		if let Some(index) = pulse.filter(|_| Instant::now() >= next) {
			let mut message = index.to_be_bytes().to_vec();
			message.push(0);
			message.extend_from_slice(b"pulse");
			let (ptr, len) = give(&message);
			assert_eq!(unsafe { i(a.id, IN_CHANNEL_SEND, ptr, len) }, STATUS_OK);
			a.drain();
			next += Duration::from_millis(200);
		}
		for datagram in std::mem::take(&mut a.outbox) {
			let to = destination(&datagram);
			if is_check(&datagram) {
				checks.push((to.clone(), Instant::now()));
			}
			if !lost && to == b.address {
				b.receive(&datagram);
			}
		}
		for datagram in std::mem::take(&mut b.outbox) {
			if !lost {
				a.receive(&datagram);
				heard = Some(Instant::now());
			}
		}
		a.tick();
		b.tick();
		std::thread::sleep(Duration::from_millis(1));
	}
	heard
}

fn gaps(times: &[Instant]) -> Vec<u128> {
	times.windows(2).map(|w| (w[1] - w[0]).as_millis()).collect()
}

/// Chrome checks the pair it sends on as libwebrtc's loop does (157,
/// measured): every 2.656 s once connected a while; every 62.5 ms once
/// nothing came from the peer for 2.5 s; once more 15 s after the first
/// check that went unanswered, and then no more. str0m's agent checked it
/// every 3 s and, once its answers stopped, 0.25 to 3 s apart until it
/// gave up 22 s on.
#[test]
fn the_pair_sent_on_is_checked_as_chromes_is() {
	let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
	let mut a = Peer::new("10.0.0.1:5000", &[]);
	let mut b = Peer::new("10.0.0.2:5000", &[]);
	let index: u16 = get(&a.control(&[("op", "channel"), ("label", "data")]), "index").parse().unwrap();
	negotiate_udp(&mut a, &mut b);
	pump(&mut a, &mut b, "the channel", |a, b| a.event("channel_open").is_some() && b.event("channel_open").is_some());
	let mut checks = Vec::new();
	let heard = run(&mut a, &mut b, 9000, false, &mut checks, Some(index)).unwrap();
	let connected: Vec<Instant> = checks.iter().filter(|(to, _)| *to == b.address).map(|(_, at)| *at).collect();
	let steady = gaps(&connected);
	assert!(
		steady.len() >= 3 && steady[steady.len() - 2..].iter().all(|gap| (2640..=2680).contains(gap)),
		"checks while connected {steady:?} ms apart"
	);
	let lost = Instant::now();
	let mut checks = Vec::new();
	run(&mut a, &mut b, 17500, true, &mut checks, Some(index));
	let gone: Vec<Instant> = checks.iter().filter(|(to, _)| *to == b.address).map(|(_, at)| *at).collect();
	let since = |at: &Instant| (*at - lost).as_millis();
	let apart = gaps(&gone);
	// the regular check (at most 2.7 s on) and then the fast ones, from
	// 2.5 s after the peer was last heard
	let fast = apart.iter().filter(|gap| (55..=75).contains(*gap)).count();
	assert!(
		gone.len() > 150 && fast * 10 >= apart.len() * 9,
		"{} checks after the peer went, {apart:?} ms apart",
		gone.len()
	);
	let first = since(&gone[0]);
	let last = since(gone.last().unwrap());
	assert!(first <= 2800, "the first check after the peer went at {first} ms");
	// from the turn after 2.5 s without a word from the peer, or after the
	// first check that went unanswered if that was later (a pair whose last
	// check was answered is receiving): natively 2.7 to 2.92 s
	let fast_from = (gone[apart.iter().position(|gap| *gap < 100).unwrap()] - heard).as_millis();
	assert!((2500..=2950).contains(&fast_from), "checked every 62.5 ms from {fast_from} ms after the peer was last heard");
	assert!(
		last >= first + 15000 && last <= first + 15130,
		"the last check {last} ms after the peer went, the first unanswered at {first} ms"
	);
}

/// A remote nothing answers at, beside the pair sent on, is checked as
/// Chrome checks it (157, measured: 192, 254 and 317 ms after it was
/// added, then 531 ms apart, 1062 ms where the pair sent on took its
/// turn, the last 14.72 s on: 25 checks) and given up 15 s after its first
/// check. str0m's agent checked it 9 times in 16 s, backing off to 3 s.
#[test]
fn a_remote_nothing_answers_at_is_checked_as_chromes_is() {
	let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
	let mut a = Peer::new("10.0.0.1:5000", &[]);
	let mut b = Peer::new("10.0.0.2:5000", &[]);
	a.control(&[("op", "channel"), ("label", "data")]);
	negotiate_udp(&mut a, &mut b);
	pump(&mut a, &mut b, "the channel", |a, b| a.event("channel_open").is_some() && b.event("channel_open").is_some());
	let mut checks = Vec::new();
	run(&mut a, &mut b, 3000, false, &mut checks, None);
	a.control(&[("op", "remote_candidate"), ("candidate", "candidate:2 1 udp 2130706430 10.0.0.9 5000 typ host")]);
	let added = Instant::now();
	let mut checks = Vec::new();
	run(&mut a, &mut b, 17000, false, &mut checks, None);
	let dead: Vec<Instant> = checks.iter().filter(|(to, _)| to == "10.0.0.9:5000").map(|(_, at)| *at).collect();
	let apart = gaps(&dead);
	assert!((22..=28).contains(&dead.len()), "{} checks, {apart:?} ms apart", dead.len());
	// three at the weak interval, a turn and two strong ones to the next
	assert!(apart[..2].iter().all(|gap| (55..=75).contains(gap)), "the first checks {apart:?} ms apart");
	assert!((580..=610).contains(&apart[2]), "the fourth {apart:?} ms apart");
	assert!(
		apart[3..].iter().all(|gap| (520..=545).contains(gap) || (1050..=1075).contains(gap)),
		"then {apart:?} ms apart"
	);
	let first = (dead[0] - added).as_millis();
	let last = (*dead.last().unwrap() - dead[0]).as_millis();
	assert!(first <= 300, "first checked {first} ms after it was added");
	assert!(last <= 15000, "the last check {last} ms after the first");
}

/// Carry datagrams between the two for `ms` (none when `lost`), calling
/// each only when its timeout says, as the worker does; the checks `a`
/// sent to `b`, at their times, and how often `a`, called when it asked,
/// had nothing due yet and asked to be called again at once
fn run_on_timeouts(a: &mut Peer, b: &mut Peer, ms: u64, lost: bool) -> (Vec<Instant>, usize) {
	let end = Instant::now() + Duration::from_millis(ms);
	let mut checks = Vec::new();
	let mut early = 0;
	while Instant::now() < end {
		let due = [a.wake, b.wake].into_iter().flatten().min().unwrap_or(end).min(end);
		if let Some(wait) = due.checked_duration_since(Instant::now()) {
			std::thread::sleep(wait);
		}
		let now = Instant::now();
		if a.wake.is_some_and(|at| at <= now) {
			let outbox = a.outbox.len();
			a.tick();
			if a.outbox.len() == outbox && a.wake.is_some_and(|at| at <= Instant::now()) {
				early += 1;
			}
		}
		if b.wake.is_some_and(|at| at <= now) {
			b.tick();
		}
		for datagram in std::mem::take(&mut a.outbox) {
			if is_check(&datagram) && destination(&datagram) == b.address {
				checks.push(Instant::now());
			}
			if !lost {
				b.receive(&datagram);
			}
		}
		for datagram in std::mem::take(&mut b.outbox) {
			if !lost {
				a.receive(&datagram);
			}
		}
	}
	(checks, early)
}

/// A check goes out when the turn of Chrome's loop that sends it is due,
/// called at the time the connection asks, as the worker calls it: on a
/// pair nothing answers every 62.5 ms, and once connected 2656.25 ms
/// apart (Chrome 157, measured: no jitter). The agent put every wake at
/// least 50 ms (its Ta) after the last, and the bandwidth estimate wakes
/// the connection every 25 ms, so each turn went at the next of those
/// wakes: checks 50 and 75 ms apart, and 2650 and 2675 ms. And a
/// timeout in whole milliseconds rounded down woke the connection before
/// anything was due, so the worker set its timer again for 0 ms, which
/// Chrome holds for 4 ms: checks 59 and 66 ms apart.
#[test]
fn a_check_goes_out_when_its_turn_is_due() {
	let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
	// the bandwidth estimate on, as the worker configures every connection
	let mut a = Peer::new("10.0.0.1:5000", &[("bwe", "300000")]);
	let mut b = Peer::new("10.0.0.2:5000", &[("bwe", "300000")]);
	a.control(&[("op", "channel"), ("label", "data")]);
	negotiate_udp(&mut a, &mut b);
	// (the first turn is the metronome's first tick, whenever that is)
	let (checks, early) = run_on_timeouts(&mut a, &mut b, 2000, true);
	let lone = gaps(&checks);
	assert!(
		lone.len() >= 25 && lone[1..].iter().all(|gap| (61..=64).contains(gap)),
		"checks nothing answers {lone:?} ms apart"
	);
	// a timeout that came before what it was for: a browser holds the
	// timer the worker sets again for 0 ms 4 ms once timers nest
	assert_eq!(early, 0, "woken before anything was due");
	let mut a = Peer::new("10.0.0.1:5000", &[("bwe", "300000")]);
	let mut b = Peer::new("10.0.0.2:5000", &[("bwe", "300000")]);
	a.control(&[("op", "channel"), ("label", "data")]);
	negotiate_udp(&mut a, &mut b);
	pump(&mut a, &mut b, "the channel", |a, b| a.event("channel_open").is_some() && b.event("channel_open").is_some());
	let steady = gaps(&run_on_timeouts(&mut a, &mut b, 11000, false).0);
	assert!(
		steady.len() >= 4 && steady[steady.len() - 2..].iter().all(|gap| (2654..=2659).contains(gap)),
		"checks while connected {steady:?} ms apart"
	);
}

/// What getStats lists, Chrome 157 measured: a pair from when it forms
/// (waiting, before its first check) until the turn that gives it up, 15
/// s after its first check. On a connection with no other pair that is the
/// turn that reads disconnected (and failed), 15.05 s on; the pair sent
/// on is checked once more there and leaves the list at the next turn.
/// The stack said nothing of its pairs: the worker listed every pair it
/// had seen a packet of, for ever, in progress.
#[test]
fn the_pairs_are_listed_as_chromes_are() {
	let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
	let lists = |peer: &Peer| -> Vec<(usize, String)> {
		peer.events
			.iter()
			.enumerate()
			.filter(|(_, e)| get(e, "ev") == "pairs")
			.map(|(n, e)| (n, get(e, "list").to_string()))
			.collect()
	};
	// a connection whose only remote nothing answers at
	let mut a = Peer::new("10.0.0.1:5000", &[]);
	let mut b = Peer::new("10.0.0.2:5000", &[]);
	a.control(&[("op", "channel"), ("label", "data")]);
	let bare = |sdp: &str| sdp.split("\r\n").filter(|line| !line.starts_with("a=candidate:")).collect::<Vec<_>>().join("\r\n");
	let offer = bare(get(&a.control(&[("op", "offer")]), "sdp"));
	let answer = bare(get(&b.control(&[("op", "remote_offer"), ("sdp", &offer)]), "sdp"));
	a.control(&[("op", "answer"), ("sdp", &answer)]);
	a.tick();
	a.control(&[("op", "remote_candidate"), ("candidate", "candidate:2 1 udp 2130706430 10.0.0.9 5000 typ host")]);
	let added = Instant::now();
	let formed = lists(&a);
	assert_eq!(formed.last().map(|(_, l)| l.as_str()), Some("10.0.0.1:5000|10.0.0.9:5000|0"), "as it was added: {formed:?}");
	let mut first = None;
	let mut emptied = None;
	let mut given_up = None;
	while Instant::now() < added + Duration::from_millis(16500) {
		for datagram in std::mem::take(&mut a.outbox) {
			if is_check(&datagram) && first.is_none() {
				first = Some(Instant::now());
			}
		}
		let before = a.events.len();
		a.tick();
		for (n, e) in a.events.iter().enumerate().skip(before) {
			if get(e, "ev") == "pairs" && get(e, "list").is_empty() {
				emptied.get_or_insert((n, Instant::now()));
			}
			if get(e, "ev") == "ice" && get(e, "state") == "disconnected" {
				given_up.get_or_insert((n, Instant::now()));
			}
		}
		std::thread::sleep(Duration::from_millis(1));
	}
	let first = first.expect("no check");
	let (n, at) = emptied.unwrap_or_else(|| panic!("the pair stayed: {:?}", lists(&a)));
	let (m, then) = given_up.expect("never disconnected");
	let after = (at - first).as_millis();
	assert!((15000..=15130).contains(&after), "the pair left the list {after} ms after its first check");
	// in the same turn as the state
	assert!(n.abs_diff(m) <= 2 && (then - at).as_millis() <= 2, "listed until {after} ms, disconnected {} ms", (then - first).as_millis());

	// the pair sent on, once the peer is gone
	let mut a = Peer::new("10.0.0.1:5000", &[]);
	let mut b = Peer::new("10.0.0.2:5000", &[]);
	let index: u16 = get(&a.control(&[("op", "channel"), ("label", "data")]), "index").parse().unwrap();
	negotiate_udp(&mut a, &mut b);
	pump(&mut a, &mut b, "the channel", |a, b| a.event("channel_open").is_some() && b.event("channel_open").is_some());
	let mut checks = Vec::new();
	run(&mut a, &mut b, 6000, false, &mut checks, Some(index));
	assert_eq!(lists(&a).last().map(|(_, l)| l.as_str()), Some("10.0.0.1:5000|10.0.0.2:5000|1"), "{:?}", lists(&a));
	let seen = a.events.len();
	let lost = Instant::now();
	let mut last_check = lost;
	let mut gone = None;
	while Instant::now() < lost + Duration::from_millis(17500) {
		for datagram in std::mem::take(&mut a.outbox) {
			if is_check(&datagram) {
				last_check = Instant::now();
			}
		}
		std::mem::take(&mut b.outbox);
		let before = a.events.len();
		a.tick();
		b.tick();
		if gone.is_none() && a.events[before..].iter().any(|e| get(e, "ev") == "pairs" && get(e, "list").is_empty()) {
			gone = Some(Instant::now());
		}
		std::thread::sleep(Duration::from_millis(1));
	}
	let later: Vec<String> = lists(&a).into_iter().filter(|(n, _)| *n >= seen).map(|(_, l)| l).collect();
	// unwritable once 5 checks went unanswered over 5 s, then gone
	assert_eq!(later, ["10.0.0.1:5000|10.0.0.2:5000|0", ""], "the lists once the peer went");
	// at the turn after its last check
	let after = (gone.unwrap() - last_check).as_millis();
	assert!((40..=80).contains(&after), "the pair sent on left the list {after} ms after its last check");
}

#[test]
fn a_passive_tcp_candidate_is_checked_over_tcp_from_port_9() {
	let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
	let mut a = Peer::new("10.0.0.1:5000", &[]);
	let mut b = Peer::new("10.0.0.2:5000", &[]);
	a.control(&[("op", "channel"), ("label", "data")]);
	negotiate(&mut a, &mut b, &[]);
	a.control(&[("op", "remote_candidate"), ("candidate", "candidate:3 1 tcp 1518280447 10.0.0.9 443 typ host tcptype passive")]);
	let deadline = Instant::now() + Duration::from_secs(5);
	let mut over_tcp = None;
	while over_tcp.is_none() {
		for datagram in std::mem::take(&mut a.outbox) {
			if destination(&datagram) == "10.0.0.9:443" {
				over_tcp = Some(datagram);
			} else {
				b.receive(&datagram);
			}
		}
		for datagram in std::mem::take(&mut b.outbox) {
			a.receive(&datagram);
		}
		a.tick();
		b.tick();
		assert!(Instant::now() < deadline, "no check to the passive candidate");
		std::thread::sleep(Duration::from_millis(2));
	}
	let datagram = over_tcp.unwrap();
	// TCP, from the active candidate at port 9
	assert_eq!(datagram[0], 2);
	let src = u16::from_be_bytes([datagram[1], datagram[2]]) as usize;
	assert_eq!(std::str::from_utf8(&datagram[3..3 + src]).unwrap(), "10.0.0.1:9");
	let lists: Vec<String> = a.events_named("remotes").iter().map(|e| get(e, "list").to_string()).collect();
	assert!(lists.iter().any(|list| list.contains("tcp/10.0.0.9:443")), "{lists:?}");
}

#[test]
fn narrowed_offers() {
	let offer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=sendrecv\r\n\
m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\na=sendonly\r\n\
m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:2\r\n\
m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:3\r\n";
	let want = |dirs: [&'static str; 4]| move |n: usize| media::direction(dirs.get(n).copied().unwrap_or(""));
	let lines = |sdp: &str| -> Vec<String> {
		sdp.lines().filter(|l| l.starts_with("a=") && !l.starts_with("a=mid")).map(str::to_string).collect()
	};
	// what the peer is left offering: its direction within what this side takes
	let (sdp, wanted) = media::narrowed(offer, want(["recvonly", "sendrecv", "", "sendrecv"]));
	assert_eq!(lines(&sdp), ["a=sendonly", "a=sendonly"]);
	assert_eq!(wanted.iter().map(|w| w.mid.as_str()).collect::<Vec<_>>(), ["0", "1", "3"]);
	let (sdp, _) = media::narrowed(offer, want(["sendonly", "sendonly", "", "recvonly"]));
	assert_eq!(lines(&sdp), ["a=recvonly", "a=inactive", "a=sendonly"]);
	let (sdp, _) = media::narrowed(offer, want(["inactive", "recvonly", "", "inactive"]));
	assert_eq!(lines(&sdp), ["a=inactive", "a=sendonly", "a=inactive"]);
	// nothing wanted, nothing touched; the line endings are the offer's
	let (sdp, wanted) = media::narrowed(offer, |_| None);
	assert_eq!(sdp, offer);
	assert!(wanted.is_empty());
	let bare = offer.replace("\r\n", "\n");
	let (sdp, _) = media::narrowed(&bare, want(["recvonly", "sendrecv", "", "recvonly"]));
	assert!(!sdp.contains('\r'));
	assert_eq!(lines(&sdp), ["a=sendonly", "a=sendonly", "a=sendonly"]);
}

#[test]
fn bad_configurations_are_refused() {
	let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
	for (key, value) in [
		("codecs", "opus"),
		("codecs", "300,opus,48000,2,"),
		("codecs", "111,opus,fast,2,"),
		("exts", "urn:ietf:params:rtp-hdrext:sdes:mid"),
		("exts", "x:urn:ietf:params:rtp-hdrext:sdes:mid"),
	] {
		let (ptr, len) = give(&record(&[("cert", CERT), ("key", KEY), (key, value)]));
		assert_eq!(unsafe { c(ptr, len) }, -1, "{key}={value} made a connection");
	}
}

/// a picture's descriptor block as the host writes it (`media::Frame`)
fn described(layers: u8, temporal: u8, number: u16, chain: u8, fdiffs: &[u8], size: (u16, u16)) -> Vec<u8> {
	let mut out = vec![layers, temporal];
	out.extend_from_slice(&number.to_be_bytes());
	out.push(chain);
	out.push(fdiffs.len() as u8);
	out.extend_from_slice(fdiffs);
	out.extend_from_slice(&size.0.to_be_bytes());
	out.extend_from_slice(&size.1.to_be_bytes());
	out
}

#[test]
fn dependency_descriptors_written_and_read() {
	use str0m::rtp::FramePosition;
	use std::sync::Arc;
	let both = FramePosition { first: true, last: true };
	// L1T3 as WebCodecs encodes it: T0 T2 T1 T2 from a keyframe, each
	// picture on its template; the keyframe's first packet has the structure
	let structure = Arc::new(dd::temporal_structure(3, (640, 360)));
	let pattern: [(u8, &[u16], u8); 6] = [(0, &[], 0), (2, &[1], 1), (1, &[2], 2), (2, &[1], 3), (0, &[4], 4), (2, &[1], 1)];
	let mut known = None;
	for (n, (temporal, fdiffs, chain)) in pattern.iter().enumerate() {
		let sent = dd::Sent {
			structure: structure.clone(),
			attach: n == 0,
			number: 65534u16.wrapping_add(n as u16),
			temporal: *temporal,
			fdiffs: fdiffs.to_vec(),
			chain: *chain,
		};
		let bytes = dd::write(&sent, both);
		// a picture on its template needs no more than the three bytes
		assert_eq!(bytes.len() == 3, n != 0, "picture {n}: {bytes:02x?}");
		assert_eq!(bytes[0] & 0xc0, 0xc0);
		let read = dd::read(&bytes, &mut known).expect("read");
		assert_eq!(known.as_deref(), Some(&*structure), "picture {n}");
		assert_eq!(read.temporal, *temporal, "picture {n}");
		assert_eq!(read.spatial, 0);
		assert_eq!(read.fdiffs, fdiffs.to_vec(), "picture {n}");
		assert_eq!(read.size, Some((640, 360)));
		assert_eq!(read.number, 65534u16.wrapping_add(n as u16));
		// the keyframe's later packets go without the structure
		if n == 0 {
			let later = dd::write(&sent, FramePosition { first: false, last: true });
			assert_eq!(later.len(), 3);
			assert_eq!(later[0] & 0xc0, 0x40);
		}
	}
	// a picture off its template (simulcast layers share the ids): custom
	// dependencies and chain
	let off = dd::Sent { structure: structure.clone(), attach: false, number: 9, temporal: 0, fdiffs: vec![8], chain: 8 };
	let read = dd::read(&dd::write(&off, both), &mut known).unwrap();
	assert_eq!((read.temporal, read.fdiffs), (0, vec![8]));
	let far = dd::Sent { structure: structure.clone(), attach: false, number: 10, temporal: 2, fdiffs: vec![300, 2], chain: 200 };
	assert_eq!(dd::read(&dd::write(&far, both), &mut known).unwrap().fdiffs, vec![300, 2]);
	// without a structure no picture can be read
	assert!(dd::read(&dd::write(&off, both), &mut None).is_none());
	// a structure of two spatial layers with their sizes, as a Chrome VP9
	// or AV1 sender's L2T2 has one: each layer's picture reads its own
	let t = |spatial, temporal, dtis: &[u8], fdiffs: &[u16], chains: &[u8]| dd::Template {
		spatial,
		temporal,
		dtis: dtis.to_vec(),
		fdiffs: fdiffs.to_vec(),
		chains: chains.to_vec(),
	};
	let spatial = Arc::new(dd::Structure {
		offset: 5,
		targets: 4,
		templates: vec![
			t(0, 0, &[2, 2, 2, 2], &[], &[0, 0]),
			t(0, 0, &[2, 2, 2, 2], &[4], &[4, 3]),
			t(0, 1, &[0, 2, 0, 2], &[2], &[2, 1]),
			t(1, 0, &[0, 0, 2, 2], &[1], &[1, 1]),
			t(1, 0, &[0, 0, 2, 2], &[4, 1], &[1, 1]),
			t(1, 1, &[0, 0, 0, 2], &[2, 1], &[3, 2]),
		],
		protected_by: vec![0, 0, 1, 1],
		chain_count: 2,
		sizes: vec![(320, 180), (640, 360)],
	});
	let mut known = None;
	// written with the general writer: the structure, then a picture of the
	// upper layer on its template
	let mut w = Vec::new();
	let key = dd::Sent { structure: spatial.clone(), attach: true, number: 1, temporal: 0, fdiffs: vec![], chain: 0 };
	w.push(dd::write(&key, both));
	let read = dd::read(&w[0], &mut known).unwrap();
	assert_eq!(known.as_deref(), Some(&*spatial));
	assert_eq!((read.spatial, read.size), (0, Some((320, 180))));
	// template 3 + offset 5 = id 8: spatial 1, depends on the picture before
	let upper = [0xc0 | 8, 0, 2];
	let read = dd::read(&upper, &mut known).unwrap();
	assert_eq!((read.spatial, read.temporal, read.fdiffs.clone(), read.size), (1, 0, vec![1], Some((640, 360))));
	// ids count on past 16 bits, back and forward
	let mut track = dd::Track::default();
	assert_eq!(track.id(65535), 65535);
	assert_eq!(track.id(1), 65537);
	assert_eq!(track.id(65534), 65534);
}

#[test]
fn video_with_dependency_descriptors() {
	let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
	let exts = format!("{EXTS}|7:{}|9:{}", dd::URI, dd::LAYERS_URI);
	let mut a = Peer::new("10.0.0.1:5000", &[("codecs", CODECS), ("exts", &exts), ("bwe", "300000")]);
	let mut b = Peer::new("10.0.0.2:5000", &[("codecs", CODECS), ("exts", &exts), ("bwe", "300000")]);
	a.control(&[("op", "media"), ("kind", "video"), ("dir", "sendrecv"), ("stream", "s"), ("track", "v")]);
	let (offer, answer) = negotiate(&mut a, &mut b, &["sendrecv"]);
	let line = format!("a=extmap:7 {}", dd::URI);
	assert!(has(&section(&offer, 0), &line), "{offer}");
	assert!(has(&section(&answer, 0), &line), "{answer}");
	assert!(has(&section(&answer, 0), &format!("a=extmap:9 {}", dd::LAYERS_URI)), "{answer}");
	pump(&mut a, &mut b, "the connection", |a, b| a.connected() && b.connected());

	// L1T3 from a keyframe of several packets: each picture comes with what
	// its descriptor said, ids counted on and dependencies as ids
	let pattern: [(u8, &[u8], u8); 9] = [(0, &[], 0), (2, &[1], 1), (1, &[2], 2), (2, &[1], 3), (0, &[4], 4), (2, &[1], 1), (1, &[2], 2), (2, &[1], 3), (0, &[4], 4)];
	for (n, (temporal, fdiffs, chain)) in pattern.iter().enumerate() {
		let key = n == 0;
		let data = vp8(key, if key { 5000 } else { 700 + n }, n as u8);
		let flags = media::FLAG_DESCRIBED | if key { media::FLAG_KEYFRAME } else { 0 };
		let block = described(3, *temporal, 65535u16.wrapping_add(n as u16), *chain, fdiffs, (640, 360));
		let status = a.write_described(0, 96, flags, media::ABSENT, media::ABSENT, [0; 4], 3000 * n as u64, "", &block, &data);
		assert_eq!(status, STATUS_OK);
		pump(&mut a, &mut b, "a described picture", |_, b| b.frames.len() > n);
		let got = &b.frames[n];
		assert_eq!(got.data, data, "picture {n}");
		assert!(got.flags & media::FLAG_PART == 0, "picture {n}");
		let id = 65535 + n as u32;
		let deps: Vec<u32> = fdiffs.iter().map(|&f| id - f as u32).collect();
		assert_eq!(got.described, Some((id, 0, *temporal, (640, 360), deps)), "picture {n}");
	}
	// without the block a picture goes without a descriptor
	let plain = vp8(false, 800, 1);
	a.write(0, 96, 0, media::ABSENT, media::ABSENT, 3000 * 9, "", &plain);
	pump(&mut a, &mut b, "a plain picture", |_, b| b.frames.len() > 9);
	assert_eq!(b.frames[9].described, None);
	assert_eq!(b.frames[9].data, plain);
}

/// Packets of libopus 1.5.2 (narrowband, mediumband, wideband: the copy
/// decodes bit for bit as libopus's decode_fec does) and of Chrome 156
/// (wideband SILK and fullband hybrid), each with the copy made of its LBRR
/// frame, none from a packet without one or a CELT packet
/// (test/fixtures/rtc/opus-lbrr.json, which rtc-media-unit also reads
/// through the artifact)
const LBRR: [(&str, Option<&str>); 13] = [
	("08c2e1f323ac6d71238b591b42f4e6b78689f380cce8c3e1ec78d10ecb6d7ca5afa62d4fc51c4363f7d0a6fd14f939d8bb9d49c90b107e50649b6f0219bf56bb453806ed752062b348", Some("0882e1f323ac6d71238b591b42f4e6b78689f380cce8c3e1ec78d10ecb6d7ca4")),
	("08eafa09d2b3520404be95bb168415dd8d138318f1ad81fc46c8fb8ad21d73872aa4b6d898168fd47e699d682bca91d9fbac3c50fffcef649c9cf5ce66e1d75ff630", Some("08aafa09d2b3520404be95bb168415dd8d138318f1ad81fc46c8fb8ad1")),
	("28c2e30b5ca11a9a8fa4a42ad2d3c20bfbf1a3ad56dbc63fde57b6e1f800715ad0cb9677841affe1707215cadd3ae1dd43d73189e094456cbabea9c9017de81cedd3e9afe436fbfa9a29a89c47826954dca1952560", Some("2882e30b5ca11a9a8fa4a42ad2d3c20bfbf1a3ad56dbc63fde57b6e1f80070")),
	("28eafd32606350644f54a2127ca29c928493ef479c8027963b77d6b031c68ae41fe2a450bfc72856a93ca1d1779fb76ebcac55a908dbdfbc35cc7043bdb302689f7a5b0e6eb6ec6f2d9d518993abc69da0", Some("28aafd32606350644f54a2127ca29c928493ef479c8027963b77d6b031c68ae380")),
	("48c33fddd0efe0dd29571f24dfa29b91a246a076c212b146247e4d5936fa54d862b2ac3c4cecc236f3917a09960cc63bbeda2a09964c6c779a73c365463980", Some("48833fddd0efe0dd29571f24dfa29b91a246a076c212b146247e4d58")),
	("48eebad1961a00c596a2a1eabc6a3ff5334d9ed4569e005c92bb29442b4b32c7f255bcac0eb11894cae84a62a8150555e6aed5b7c60c266f20e078eedd60", Some("48aebad1961a00c596a2a1eabc6a3ff5334d9ed4569e005c92b8")),
	("48c507ee77ed7b5be1d502da31b1fea89c15e835338529cb946b4a0539c3f94463a1301a47af61474173bce612edaba3bdd9ab46df236eee5c8f2192", Some("488507ee77ed7b5be1d502da31b1fea0")),
	("48d3a1e9c5be1955f5e56405f33f18a7abd5f34ee1cd69023dfd227c0162ff3cb89da022f000563036fe08b90a9ad2d5a21cfe21072c783ae202f930fbbba08c98cc869920110f07ca789ff41b875ab756f27ddec79af3a47f30ccb1e584534e0dc43ee5cdce0e01cd3c", Some("4893a1e9c5be1955f5e56405f33f18a7abd5f34ee1cd69023dfd227c0162ff3cb89da022f000563036fe08b90a9ad2d5a21cfe21072c783ae202f930fbbba08c98cc869920110f07ca789ff41b875ab756f27ddea0")),
	("48eb4235cd566ecd9cbb37d807cc07e38fa2a6c0b793a05f4c56435851853c3438ee6eb5090f2778bf71012cc7e35ff9ad95e49374e4fea4d437e455312cd0f9d1b85e26680cec64476b5a2fc1c561a9bb60", Some("48ab4235cd566ecd9cbb37d807cc07e38fa2a6c0b793a05f4c56435851853c3438ee6c")),
	("78c30ba21ac77562b31482b341b33f8de8c3e0d99b399d4c55ae40a389705620f5ed72a28823d2c253b6468aa2aa5e08fc08d16da5336d24d50e749ecd4d076ded4e8e54b1270b3b497465dac4a5b972", Some("48830ba21ac77562b31482b341b33f8de8c3e0d99b399d4c55ae4080")),
	("78e518cb5eeddedc89963278ae3a2fc26432c98a25292a1de2ac7dba5c9b69d9e32d1fc66b0056baecb7f9eb6f12fffc8bfcf3c91e20c55d98978aae3a193c2c19bd93ae", Some("48a518cb5eeddedc89963278ae3a2fc26432c98a")),
	("7882b4da8bb7697c7c378b2c076c6af47b8ac9e824c0d5189a3f3338037d90e756e06816b2c45934ffb43e316bc15cede5695f9df317ff529e3890cbc733c1fb2235e510eac85aabb02893c892439db3fbaa9a00fe7d8c34b309ff67535784", None),
	("f843b12c5b984f11cd4f3e814a16e621166bc2d92a5ae826e3f99150e93ec12e3c0945405a7702bc7abf91f5150dbdce1d5c301ad769b484c6793490a6ae38e89a1e28a04b526f2de4cd9ae31d490ece1d", None),
];

#[test]
fn lbrr_copies_become_packets_of_their_own() {
	let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
	let copy_of = |packet: &[u8]| {
		let (ptr, len) = give(packet);
		match unsafe { l(ptr, len) } {
			0 => None,
			len => Some(unsafe { std::slice::from_raw_parts(p(), len) }.to_vec()),
		}
	};
	for (packet, copy) in LBRR {
		let packet = unhex(packet).unwrap();
		let made = copy_of(&packet);
		assert_eq!(made, copy.map(|copy| unhex(copy).unwrap()), "{packet:02x?}");
		if let Some(made) = made {
			// the copy's symbols are the LBRR frame's, in one mono frame
			assert_eq!(lbrr::symbols(&made, false), lbrr::symbols(&packet, true));
			assert_eq!(made[0] & 7, 0);
		}
	}
	// nothing, or one byte, carries no copy
	assert_eq!(copy_of(&[]), None);
	assert_eq!(copy_of(&[8]), None);
}
