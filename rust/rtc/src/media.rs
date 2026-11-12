//! Audio and video over the records boundary (docs/webrtc-over-wisp.md,
//! sections 8 and 9). The stack packetizes and depacketizes; the host
//! encodes and decodes (WebCodecs in the worker), so what crosses here is
//! whole encoded frames: one Opus packet, one VP8 frame, one H.264 access
//! unit in Annex B.
//!
//! The host says what it can encode and decode and how it numbers them (the
//! `codecs` and `exts` fields of the configuration, in the words of the SDP
//! lines a browser writes), so the payload types and the extension ids are
//! the browser's and nothing about a browser version is compiled in here.

use str0m::format::{Codec, CodecConfig, FormatParams, PayloadParams};
use str0m::media::{Direction, Frequency, MediaData, MediaKind, Mid};
use str0m::rtp::{Extension, ExtensionMap};

/// A media section, as the host knows it: the index into the connection's
/// list is its name on both sides of the boundary.
pub struct MediaSlot {
	/// None until the offer that carries the section is made (the stack
	/// holds a change only until it is applied, as with channels)
	pub mid: Option<Mid>,
	pub kind: MediaKind,
	/// the direction this side wants, which every offer of ours states
	/// again (a browser offers the transceiver's direction, not the
	/// negotiated one); None for a section the peer added until the host
	/// has said
	pub wanted: Option<Direction>,
	/// the `a=msid` stream and track of what this side sends
	pub stream: Option<String>,
	pub track: Option<String>,
	/// simulcast layers this side sends, by rid
	pub rids: Vec<String>,
	/// the next offer stops the section
	pub stop: bool,
	/// how many channels there were when the host added the section: an
	/// offer's sections are in the order their owners were made, as a
	/// browser's are
	pub after: usize,
	/// the host has been told the stack has the section
	pub announced: bool,
}

// frame flags, both ways
/// the frame is a keyframe (received frames only: the stack reads it off the payload)
pub const FLAG_KEYFRAME: u8 = 1;
/// nothing was lost between this frame and the one before it (received frames only)
pub const FLAG_CONTIGUOUS: u8 = 2;
/// the first frame after a silence
pub const FLAG_TALKSPURT: u8 = 4;
/// the audio level says a voice is speaking
pub const FLAG_VOICE: u8 = 8;

/// "none" for the level and orientation bytes
pub const ABSENT: u8 = 255;

/// what a payload type carries, for the host's choice of decoder
pub fn codec_id(codec: Codec) -> u8 {
	match codec {
		Codec::Opus => 1,
		Codec::PCMU => 2,
		Codec::PCMA => 3,
		Codec::G722 => 4,
		Codec::CN => 5,
		Codec::Vp8 => 10,
		Codec::Vp9 => 11,
		Codec::H264 => 12,
		Codec::Av1 => 13,
		Codec::H265 => 14,
		_ => 0,
	}
}

pub fn kind_name(kind: MediaKind) -> &'static str {
	match kind {
		MediaKind::Audio => "audio",
		MediaKind::Video => "video",
	}
}

pub fn direction(text: &str) -> Option<Direction> {
	match text {
		"sendrecv" => Some(Direction::SendRecv),
		"sendonly" => Some(Direction::SendOnly),
		"recvonly" => Some(Direction::RecvOnly),
		"inactive" => Some(Direction::Inactive),
		_ => None,
	}
}

fn sends(direction: Direction) -> bool {
	matches!(direction, Direction::SendRecv | Direction::SendOnly)
}

fn receives(direction: Direction) -> bool {
	matches!(direction, Direction::SendRecv | Direction::RecvOnly)
}

fn of(send: bool, receive: bool) -> Direction {
	match (send, receive) {
		(true, true) => Direction::SendRecv,
		(true, false) => Direction::SendOnly,
		(false, true) => Direction::RecvOnly,
		(false, false) => Direction::Inactive,
	}
}

/// A media section of an offer this side has a direction for
pub struct Wanted {
	pub mid: String,
	pub kind: MediaKind,
	pub direction: Direction,
}

/// An offer with each media section's direction narrowed to what this side
/// wants of it. The stack answers an offered section with the offer's
/// direction turned around, and a browser answers with what its transceiver
/// wants within that (a section nobody added a track to is answered
/// `recvonly`): so the peer's direction is cut down here, before the stack
/// reads it, to what this side takes of it, and the answer comes out as the
/// browser's would. `want` is asked by section number, 0 for the first `m=`.
pub fn narrowed(offer: &str, want: impl Fn(usize) -> Option<Direction>) -> (String, Vec<Wanted>) {
	let mut out = String::with_capacity(offer.len() + 32);
	let mut wanted = Vec::new();
	// the section being read: its number, what this side wants, whether a
	// direction line was seen and the line ending in use
	let mut section: Option<(usize, Direction, bool)> = None;
	let mut count = 0;
	let mut ending = "\r\n";
	let close = |out: &mut String, section: &Option<(usize, Direction, bool)>, ending: &str| {
		// a section without a direction line offers `sendrecv`
		if let Some((_, want, false)) = section {
			let narrowed = of(receives(*want), sends(*want));
			if narrowed != Direction::SendRecv {
				out.push_str("a=");
				out.push_str(&narrowed.to_string());
				out.push_str(ending);
			}
		}
	};
	for line in offer.split_inclusive('\n') {
		let bare = line.trim_end_matches(['\r', '\n']);
		if line.ends_with("\r\n") {
			ending = "\r\n";
		} else if line.ends_with('\n') {
			ending = "\n";
		}
		if let Some(rest) = bare.strip_prefix("m=") {
			close(&mut out, &section, ending);
			let kind = if rest.starts_with("audio") {
				Some(MediaKind::Audio)
			} else if rest.starts_with("video") {
				Some(MediaKind::Video)
			} else {
				None
			};
			section = match (kind, want(count)) {
				(Some(kind), Some(direction)) => {
					wanted.push(Wanted {
						mid: String::new(),
						kind,
						direction,
					});
					Some((count, direction, false))
				}
				_ => None,
			};
			count += 1;
			out.push_str(line);
			continue;
		}
		if let Some((_, want, seen)) = section.as_mut() {
			if let Some(mid) = bare.strip_prefix("a=mid:") {
				if let Some(last) = wanted.last_mut() {
					last.mid = mid.to_string();
				}
			} else if let Some(offered) = bare.strip_prefix("a=").and_then(direction) {
				*seen = true;
				// the peer sends what this side receives, and receives
				// what this side sends
				let narrowed = of(
					sends(offered) && receives(*want),
					receives(offered) && sends(*want),
				);
				out.push_str("a=");
				out.push_str(&narrowed.to_string());
				out.push_str(&line[bare.len()..]);
				continue;
			}
		}
		out.push_str(line);
	}
	if !out.ends_with('\n') && section.is_some() {
		out.push_str(ending);
	}
	close(&mut out, &section, ending);
	(out, wanted)
}

/// One `pt,name,clock,channels,fmtp` entry of a codec list
struct Entry<'a> {
	pt: u8,
	name: &'a str,
	clock: u32,
	channels: Option<u8>,
	fmtp: &'a str,
}

fn entries(list: &str) -> Result<Vec<Entry<'_>>, String> {
	let mut out = Vec::new();
	for entry in list.split('|').filter(|e| !e.is_empty()) {
		let mut parts = entry.splitn(5, ',');
		let mut next = || parts.next().unwrap_or("");
		let pt = next().parse::<u8>().map_err(|_| format!("bad codec {entry}"))?;
		let name = next();
		let clock = next().parse::<u32>().map_err(|_| format!("bad codec {entry}"))?;
		let channels = next().parse::<u8>().ok();
		let fmtp = next();
		if pt > 127 || name.is_empty() {
			return Err(format!("bad codec {entry}"));
		}
		out.push(Entry {
			pt,
			name,
			clock,
			channels,
			fmtp,
		});
	}
	Ok(out)
}

/// The payload type a `rtx` entry repeats (`apt=96`)
fn repeats(entry: &Entry) -> Option<u8> {
	entry
		.fmtp
		.split(';')
		.find_map(|part| part.trim().strip_prefix("apt="))
		.and_then(|pt| pt.parse().ok())
}

/// The codecs of a connection from the host's list: entries
/// `pt,name,clock,channels,fmtp` separated by `|`, which are a browser's
/// `a=rtpmap` and `a=fmtp` lines in its order of preference. `rtx` entries
/// name the payload they repeat (`apt=`). A `red` entry for Opus is taken
/// where the stack can number it (63 over 111, which is the browser's
/// numbering); payloads the stack has no format for (`ulpfec`, video `red`,
/// `flexfec-03`) are left out, so they are never negotiated.
pub fn codecs(config: &mut CodecConfig, list: &str) -> Result<(), String> {
	let entries = entries(list)?;
	config.clear();
	for entry in &entries {
		let codec = Codec::from(entry.name);
		let pt = entry.pt;
		let rtx = entries
			.iter()
			.find(|e| Codec::from(e.name) == Codec::Rtx && repeats(e) == Some(pt))
			.map(|e| e.pt);
		match codec {
			Codec::Rtx | Codec::Red | Codec::Unknown | Codec::Null => continue,
			Codec::Opus if pt == 111 => {
				// "111/111": both blocks of a redundant packet are Opus
				let red = entries.iter().any(|e| {
					Codec::from(e.name) == Codec::Red
						&& e.pt == 63 && e.clock == entry.clock
						&& e.fmtp.split('/').all(|p| p.trim() == "111")
				});
				// the stack's own entry is the browser's: 48 kHz, two
				// channels, `minptime=10;useinbandfec=1`
				config.enable_opus(true, red);
			}
			// the static payload types, which the stack numbers itself
			Codec::PCMU if pt == 0 => config.enable_pcmu(true, false),
			Codec::PCMA if pt == 8 => config.enable_pcma(true, false),
			Codec::G722 if pt == 9 => config.enable_g722(true, false),
			Codec::CN if pt == 13 && entry.clock == 8000 => config.enable_comfort_noise(true),
			_ => {
				// G.722 is 16 kHz audio whose RTP clock says 8000
				let clock = if codec == Codec::G722 { 16000 } else { entry.clock };
				let clock = Frequency::new(clock).ok_or_else(|| format!("bad clock for {pt}"))?;
				let channels = if codec.is_video() || codec.is_tele() {
					None
				} else {
					entry.channels.or(Some(1))
				};
				config.add_config(
					pt.into(),
					rtx.map(Into::into),
					codec,
					clock,
					channels,
					FormatParams::parse_line(entry.fmtp),
				);
			}
		}
	}
	Ok(())
}

/// A negotiated payload in the words of the codec list, with its `rtx` and
/// `red` entries after it
pub fn payload_entry(params: &PayloadParams, out: &mut String) {
	let spec = params.spec();
	let mut push = |pt: u8, name: &str, clock: u32, channels: Option<u8>, fmtp: &str| {
		if !out.is_empty() {
			out.push('|');
		}
		out.push_str(&pt.to_string());
		out.push(',');
		out.push_str(name);
		out.push(',');
		out.push_str(&clock.to_string());
		out.push(',');
		if let Some(channels) = channels {
			out.push_str(&channels.to_string());
		}
		out.push(',');
		out.push_str(fmtp);
	};
	let pt = *params.pt();
	// the clock the host counts frames in: G.722's is 16000 here though
	// its RTP clock says 8000
	let clock = spec.clock_rate.get();
	push(
		pt,
		&spec.codec.to_string(),
		clock,
		spec.channels,
		&spec.format.to_string(),
	);
	if let Some(rtx) = params.resend() {
		push(*rtx, "rtx", clock, None, &format!("apt={pt}"));
	}
	if let Some(red) = params.red() {
		push(*red, "red", clock, spec.channels, &format!("{pt}/{pt}"));
	}
}

/// The header extensions of a connection from the host's list: entries
/// `id:uri` separated by `|`, a browser's `a=extmap` lines. Extensions the
/// stack does not know are left out, so they are never negotiated.
pub fn extensions(list: &str) -> Result<ExtensionMap, String> {
	let known = [
		Extension::AudioLevel,
		Extension::AbsoluteSendTime,
		Extension::AbsoluteCaptureTime,
		Extension::TransmissionTimeOffset,
		Extension::VideoOrientation,
		Extension::TransportSequenceNumber,
		Extension::PlayoutDelay,
		Extension::VideoContentType,
		Extension::VideoTiming,
		Extension::RtpStreamId,
		Extension::RepairedRtpStreamId,
		Extension::RtpMid,
		Extension::ColorSpace,
	];
	let mut map = ExtensionMap::empty();
	for entry in list.split('|').filter(|e| !e.is_empty()) {
		let (id, uri) = entry.split_once(':').ok_or_else(|| format!("bad extension {entry}"))?;
		let id: u8 = id.parse().map_err(|_| format!("bad extension {entry}"))?;
		if let Some(extension) = known.iter().find(|e| e.as_uri() == uri) {
			map.set(id, extension.clone());
		}
	}
	Ok(map)
}

/// A frame the host sends:
/// `[media u8][pt u8][flags u8][level u8][orientation u8][age ms u16][time u64][rid len u8][rid][bytes]`
pub struct Frame<'a> {
	pub media: usize,
	pub pt: u8,
	pub flags: u8,
	/// the audio level in -dBov (0 loudest, 127 silence), or `ABSENT`
	pub level: u8,
	/// the rotation, as `urn:3gpp:video-orientation` numbers it, or `ABSENT`
	pub orientation: u8,
	/// how long ago the frame was captured, for the wallclock the sender
	/// reports give its RTP time
	pub age: u16,
	/// the frame's time in units of its payload's clock
	pub time: u64,
	pub rid: Option<&'a str>,
	pub data: &'a [u8],
}

pub fn parse_frame(bytes: &[u8]) -> Option<Frame<'_>> {
	let head = bytes.get(..16)?;
	let rid_len = head[15] as usize;
	let rid = bytes.get(16..16 + rid_len)?;
	Some(Frame {
		media: head[0] as usize,
		pt: head[1],
		flags: head[2],
		level: head[3],
		orientation: head[4],
		age: u16::from_be_bytes([head[5], head[6]]),
		time: u64::from_be_bytes(head[7..15].try_into().ok()?),
		rid: if rid_len == 0 {
			None
		} else {
			Some(std::str::from_utf8(rid).ok()?)
		},
		data: &bytes[16 + rid_len..],
	})
}

/// A frame the stack received, after the tag:
/// `[media u8][pt u8][codec u8][flags u8][level u8][orientation u8][time u64][rid len u8][rid][bytes]`.
/// None for what is not a frame of a codec (telephone events).
pub fn data_record(tag: u8, media: u8, data: &MediaData) -> Option<Vec<u8>> {
	let codec = codec_id(data.params.spec().codec);
	if codec == 0 {
		return None;
	}
	let mut flags = 0;
	if data.is_keyframe() {
		flags |= FLAG_KEYFRAME;
	}
	if data.contiguous {
		flags |= FLAG_CONTIGUOUS;
	}
	if data.audio_start_of_talk_spurt {
		flags |= FLAG_TALKSPURT;
	}
	if data.ext_vals.voice_activity == Some(true) {
		flags |= FLAG_VOICE;
	}
	let level = match data.ext_vals.audio_level {
		Some(level) => level.unsigned_abs().min(127),
		None => ABSENT,
	};
	let orientation = match data.ext_vals.video_orientation {
		Some(orientation) => orientation as u8,
		None => ABSENT,
	};
	let rid = data.rid.as_ref().map(|rid| rid.as_bytes()).unwrap_or(&[]);
	let mut out = Vec::with_capacity(17 + rid.len() + data.data.len());
	out.push(tag);
	out.push(media);
	out.push(*data.pt);
	out.push(codec);
	out.push(flags);
	out.push(level);
	out.push(orientation);
	out.extend_from_slice(&data.time.numer().to_be_bytes());
	out.push(rid.len() as u8);
	out.extend_from_slice(rid);
	out.extend_from_slice(&data.data);
	Some(out)
}
