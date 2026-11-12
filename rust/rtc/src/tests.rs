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
	rid: String,
	data: Vec<u8>,
}

struct Peer {
	id: i32,
	address: String,
	events: Vec<Fields>,
	frames: Vec<Received>,
	/// datagrams waiting to cross to the other peer
	outbox: Vec<Vec<u8>>,
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
			outbox: Vec::new(),
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
				OUT_RESULT => result = Some(owned(&bytes[1..])),
				OUT_MEDIA_DATA => {
					let rid_len = bytes[15] as usize;
					self.frames.push(Received {
						media: bytes[1],
						pt: bytes[2],
						codec: bytes[3],
						flags: bytes[4],
						level: bytes[5],
						orientation: bytes[6],
						time: u64::from_be_bytes(bytes[7..15].try_into().unwrap()),
						rid: String::from_utf8(bytes[16..16 + rid_len].to_vec()).unwrap(),
						data: bytes[16 + rid_len..].to_vec(),
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
		let mut bytes = vec![media, pt, flags, level, orientation, 0, 5];
		bytes.extend_from_slice(&time.to_be_bytes());
		bytes.push(rid.len() as u8);
		bytes.extend_from_slice(rid.as_bytes());
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
		}
	}
	assert_eq!(a.frames.len(), sent.len());
	assert_eq!(a.frames[3].data, [0xfc, 0xee, 3]);
	assert_eq!(a.frames[3].level, media::ABSENT);

	// redundant audio is the peer's to read too
	a.control(&[("op", "red"), ("index", "0"), ("on", "1")]);
	let before = b.frames.len();
	for n in 0..5u64 {
		a.write(0, 111, 0, media::ABSENT, media::ABSENT, 960 * (25 + n), "", &[0xfc, 0x77, n as u8]);
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
	assert_eq!(a.write(1, 96, 0, media::ABSENT, 3, 0, "", &key), STATUS_OK);
	pump(&mut a, &mut b, "the keyframe", |_, b| !b.frames.is_empty());
	assert_eq!(b.frames[0].data, key);
	assert_eq!(b.frames[0].media, 1);
	assert_eq!(b.frames[0].codec, 10);
	assert!(b.frames[0].flags & media::FLAG_KEYFRAME != 0);
	assert_eq!(b.frames[0].orientation, 3);
	for n in 1..=30u64 {
		let delta = vp8(false, 900 + n as usize, n as u8);
		a.write(1, 96, 0, media::ABSENT, media::ABSENT, 3000 * n, "", &delta);
		pump(&mut a, &mut b, "a delta frame", |_, b| b.frames.len() > n as usize);
		assert_eq!(b.frames[n as usize].data, delta, "frame {n}");
		assert!(b.frames[n as usize].flags & media::FLAG_KEYFRAME == 0, "frame {n}");
		assert_eq!(b.frames[n as usize].time - b.frames[n as usize - 1].time, 3000, "frame {n}");
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
