//! The dependency descriptor header extension (the AV1 RTP payload
//! specification, appendix A), which Chrome negotiates for a video sender
//! made with a scalabilityMode or with simulcast layers, and sends then on
//! every packet of every picture. What it says of a picture (its id, the
//! pictures it depends on, its spatial and temporal layer, its size) is what
//! an encoded transform's frames read of a received picture.
//!
//! The sender here encodes one spatial layer of one, two or three temporal
//! layers (WebCodecs' L1T1, L1T2 and L1T3), and describes them with the
//! template structures WebRTC uses for those modes. The receiver reads any
//! structure: a Chrome sender's spatial layers are parts of one picture
//! here (str0m's FrameParts), each with its own descriptor.

use std::sync::Arc;

use str0m::rtp::{ExtensionSerializer, ExtensionValues, FramePosition};

pub const URI: &str =
	"https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension";
/// offered and answered with the descriptor, as Chrome does; never sent here
pub const LAYERS_URI: &str = "http://www.webrtc.org/experiments/rtp-hdrext/video-layers-allocation00";

/// A frame template: a picture of its layer whose dependencies are these
#[derive(Clone, Debug, PartialEq)]
pub struct Template {
	pub spatial: u8,
	pub temporal: u8,
	/// how each decode target needs the picture (0 not at all, 1
	/// discardable, 2 switch, 3 required)
	pub dtis: Vec<u8>,
	/// how many pictures back each one it depends on is
	pub fdiffs: Vec<u16>,
	/// how many pictures back each chain's previous picture is
	pub chains: Vec<u8>,
}

/// A template dependency structure: sent with a keyframe, and what the
/// descriptors of the pictures after it name their template from
#[derive(Clone, Debug, PartialEq)]
pub struct Structure {
	/// the template id of the first template
	pub offset: u8,
	pub targets: usize,
	pub templates: Vec<Template>,
	/// the chain that protects each decode target, with none when empty
	pub protected_by: Vec<u8>,
	pub chain_count: usize,
	/// each spatial layer's size
	pub sizes: Vec<(u16, u16)>,
}

struct Bits<'a> {
	buf: &'a [u8],
	at: usize,
}

impl Bits<'_> {
	fn read(&mut self, n: usize) -> Option<u32> {
		let mut v = 0u32;
		for _ in 0..n {
			let byte = *self.buf.get(self.at / 8)?;
			v = (v << 1) | ((byte >> (7 - self.at % 8)) & 1) as u32;
			self.at += 1;
		}
		Some(v)
	}

	/// a non-symmetric unsigned value of `n` values (`ns(n)`)
	fn ns(&mut self, n: u32) -> Option<u32> {
		let w = 32 - n.leading_zeros();
		let m = (1u32 << w) - n;
		let v = self.read(w as usize - 1)?;
		if v < m {
			return Some(v);
		}
		Some((v << 1) - m + self.read(1)?)
	}
}

#[derive(Default)]
struct Writer {
	out: Vec<u8>,
	bits: usize,
}

impl Writer {
	fn put(&mut self, v: u32, n: usize) {
		for i in (0..n).rev() {
			if self.bits % 8 == 0 {
				self.out.push(0);
			}
			if (v >> i) & 1 == 1 {
				*self.out.last_mut().unwrap() |= 0x80 >> (self.bits % 8);
			}
			self.bits += 1;
		}
	}

	fn ns(&mut self, v: u32, n: u32) {
		let w = 32 - n.leading_zeros();
		let m = (1u32 << w) - n;
		if v < m {
			self.put(v, w as usize - 1);
		} else {
			self.put(v + m, w as usize);
		}
	}
}

fn read_structure(bits: &mut Bits) -> Option<Structure> {
	let offset = bits.read(6)? as u8;
	let targets = bits.read(5)? as usize + 1;
	let mut templates = Vec::new();
	let (mut spatial, mut temporal) = (0u8, 0u8);
	loop {
		templates.push(Template {
			spatial,
			temporal,
			dtis: Vec::new(),
			fdiffs: Vec::new(),
			chains: Vec::new(),
		});
		match bits.read(2)? {
			1 => temporal += 1,
			2 => {
				temporal = 0;
				spatial += 1;
			}
			3 => break,
			_ => {}
		}
		if templates.len() > 64 {
			return None;
		}
	}
	for template in &mut templates {
		for _ in 0..targets {
			template.dtis.push(bits.read(2)? as u8);
		}
	}
	for template in &mut templates {
		while bits.read(1)? == 1 {
			template.fdiffs.push(bits.read(4)? as u16 + 1);
		}
	}
	let chain_count = bits.ns(targets as u32 + 1)? as usize;
	let mut protected_by = Vec::new();
	if chain_count > 0 {
		for _ in 0..targets {
			protected_by.push(bits.ns(chain_count as u32)? as u8);
		}
		for template in &mut templates {
			for _ in 0..chain_count {
				template.chains.push(bits.read(4)? as u8);
			}
		}
	}
	let mut sizes = Vec::new();
	if bits.read(1)? == 1 {
		for _ in 0..=spatial {
			sizes.push((
				(bits.read(16)? as u16).saturating_add(1),
				(bits.read(16)? as u16).saturating_add(1),
			));
		}
	}
	Some(Structure {
		offset,
		targets,
		templates,
		protected_by,
		chain_count,
		sizes,
	})
}

fn write_structure(w: &mut Writer, s: &Structure) {
	w.put(s.offset as u32, 6);
	w.put(s.targets as u32 - 1, 5);
	for pair in s.templates.windows(2) {
		let (a, b) = (&pair[0], &pair[1]);
		w.put(
			if b.spatial > a.spatial {
				2
			} else if b.temporal > a.temporal {
				1
			} else {
				0
			},
			2,
		);
	}
	w.put(3, 2);
	for t in &s.templates {
		for &dti in &t.dtis {
			w.put(dti as u32, 2);
		}
	}
	for t in &s.templates {
		for &fdiff in &t.fdiffs {
			w.put(1, 1);
			w.put((fdiff as u32).saturating_sub(1), 4);
		}
		w.put(0, 1);
	}
	w.ns(s.chain_count as u32, s.targets as u32 + 1);
	if s.chain_count > 0 {
		for &chain in &s.protected_by {
			w.ns(chain as u32, s.chain_count as u32);
		}
		for t in &s.templates {
			for &diff in &t.chains {
				w.put(diff as u32, 4);
			}
		}
	}
	w.put(!s.sizes.is_empty() as u32, 1);
	for &(width, height) in &s.sizes {
		w.put((width as u32).saturating_sub(1), 16);
		w.put((height as u32).saturating_sub(1), 16);
	}
}

/// What a received descriptor says of its picture
#[derive(Debug, PartialEq)]
pub struct Described {
	pub number: u16,
	pub spatial: u8,
	pub temporal: u8,
	pub fdiffs: Vec<u16>,
	pub size: Option<(u16, u16)>,
}

/// Reads a descriptor with the structure the stream last had (the one it
/// carries replaces that). None for one that names no template of it.
pub fn read(buf: &[u8], structure: &mut Option<Arc<Structure>>) -> Option<Described> {
	let mut bits = Bits { buf, at: 0 };
	bits.read(2)?;
	let template_id = bits.read(6)? as u8;
	let number = bits.read(16)? as u16;
	let (mut dtis, mut fdiffs, mut chains) = (false, false, false);
	if buf.len() > 3 {
		let attached = bits.read(1)? == 1;
		let active = bits.read(1)? == 1;
		dtis = bits.read(1)? == 1;
		fdiffs = bits.read(1)? == 1;
		chains = bits.read(1)? == 1;
		if attached {
			*structure = Some(Arc::new(read_structure(&mut bits)?));
		}
		if active {
			bits.read(structure.as_ref()?.targets)?;
		}
	}
	let s = structure.as_ref()?;
	let index = (template_id as usize + 64 - s.offset as usize) % 64;
	let template = s.templates.get(index)?;
	if dtis {
		bits.read(2 * s.targets)?;
	}
	let fdiffs = if fdiffs {
		let mut list = Vec::new();
		loop {
			let size = bits.read(2)? as usize;
			if size == 0 {
				break;
			}
			list.push(bits.read(4 * size)? as u16 + 1);
		}
		list
	} else {
		template.fdiffs.clone()
	};
	if chains {
		bits.read(8 * s.chain_count)?;
	}
	Some(Described {
		number,
		spatial: template.spatial,
		temporal: template.temporal,
		fdiffs,
		size: s.sizes.get(template.spatial as usize).copied(),
	})
}

/// The structure of a sender of one spatial layer and this many temporal
/// layers (1 to 3), as WebRTC's L1T1, L1T2 and L1T3 have it: one chain,
/// through the base layer, and the picture's size (none for 0x0)
pub fn temporal_structure(layers: u8, size: (u16, u16)) -> Structure {
	let t = |temporal: u8, dtis: &[u8], fdiffs: &[u16], chain: u8| Template {
		spatial: 0,
		temporal,
		dtis: dtis.to_vec(),
		fdiffs: fdiffs.to_vec(),
		chains: vec![chain],
	};
	let templates = match layers {
		2 => vec![t(0, &[2, 2], &[], 0), t(0, &[2, 2], &[2], 2), t(1, &[0, 1], &[1], 1)],
		3 => vec![
			t(0, &[2, 2, 2], &[], 0),
			t(0, &[2, 2, 2], &[4], 4),
			t(1, &[0, 1, 2], &[2], 2),
			t(2, &[0, 0, 1], &[1], 1),
			t(2, &[0, 0, 1], &[1], 3),
		],
		_ => vec![t(0, &[2], &[], 0), t(0, &[2], &[1], 1)],
	};
	let targets = templates[0].dtis.len();
	Structure {
		offset: 0,
		targets,
		templates,
		protected_by: vec![0; targets],
		chain_count: 1,
		sizes: if size.0 > 0 && size.1 > 0 { vec![size] } else { Vec::new() },
	}
}

/// What a sent picture's descriptor says (a frame's user value)
#[derive(Debug)]
pub struct Sent {
	pub structure: Arc<Structure>,
	/// the structure goes with the picture's first packet (a keyframe)
	pub attach: bool,
	pub number: u16,
	pub temporal: u8,
	pub fdiffs: Vec<u16>,
	/// how many pictures back the first chain's last one is
	pub chain: u8,
}

/// A sent picture's descriptor on one of its packets: the template that
/// says the most of it, and what the template does not say besides
pub fn write(sent: &Sent, position: FramePosition) -> Vec<u8> {
	let s = &sent.structure;
	let fits = |t: &&Template| t.spatial == 0 && t.temporal == sent.temporal;
	let exact = s
		.templates
		.iter()
		.position(|t| fits(&t) && t.fdiffs == sent.fdiffs && t.chains.first() == Some(&sent.chain));
	let index = exact
		.or_else(|| s.templates.iter().position(|t| fits(&t) && t.fdiffs == sent.fdiffs))
		.or_else(|| s.templates.iter().position(|t| fits(&t)))
		.unwrap_or(0);
	let template = &s.templates[index];
	let attach = sent.attach && position.first;
	let fdiffs = template.fdiffs != sent.fdiffs;
	// (the first chain's, which is the base layer's: the only one here)
	let chains = template.chains.first().is_some_and(|&c| c != sent.chain);
	let mut w = Writer::default();
	w.put(position.first as u32, 1);
	w.put(position.last as u32, 1);
	w.put(((index + s.offset as usize) % 64) as u32, 6);
	w.put(sent.number as u32, 16);
	if attach || fdiffs || chains {
		w.put(attach as u32, 1);
		w.put(0, 2);
		w.put(fdiffs as u32, 1);
		w.put(chains as u32, 1);
		if attach {
			write_structure(&mut w, s);
		}
		if fdiffs {
			for &fdiff in &sent.fdiffs {
				let v = (fdiff as u32).saturating_sub(1);
				let size = if v < 16 { 1 } else if v < 256 { 2 } else { 3 };
				w.put(size, 2);
				w.put(v, 4 * size as usize);
			}
			w.put(0, 2);
		}
		if chains {
			for (at, &chain) in template.chains.iter().enumerate() {
				w.put(if at == 0 { sent.chain } else { chain } as u32, 8);
			}
		}
	}
	w.out
}

/// The extension as the stack writes and reads it: a frame's `Sent` value
/// on each of its packets, and a received packet's bytes kept (`Received`)
/// with where the packet sits in its picture
#[derive(Debug)]
pub struct Serializer;

/// a received packet's descriptor, as it came
#[derive(Debug)]
pub struct Received(pub Vec<u8>);

fn written(ev: &ExtensionValues) -> Option<Vec<u8>> {
	let sent = ev.user_values.get::<Sent>()?;
	let position = ev.user_values.get::<FramePosition>().copied().unwrap_or(FramePosition {
		first: true,
		last: true,
	});
	Some(write(sent, position))
}

impl ExtensionSerializer for Serializer {
	fn write_to(&self, buf: &mut [u8], ev: &ExtensionValues) -> usize {
		match written(ev) {
			Some(bytes) if bytes.len() <= buf.len() => {
				buf[..bytes.len()].copy_from_slice(&bytes);
				bytes.len()
			}
			_ => 0,
		}
	}

	fn parse_value(&self, buf: &[u8], ev: &mut ExtensionValues) -> bool {
		if buf.len() < 3 {
			return false;
		}
		ev.user_values.set(FramePosition {
			first: buf[0] & 0x80 != 0,
			last: buf[0] & 0x40 != 0,
		});
		ev.user_values.set(Received(buf.to_vec()));
		true
	}

	fn is_video(&self) -> bool {
		true
	}

	fn is_audio(&self) -> bool {
		false
	}

	fn requires_two_byte_form(&self, ev: &ExtensionValues) -> bool {
		written(ev).is_some_and(|bytes| bytes.len() > 16)
	}
}

/// A received stream's descriptors: the structure it last sent, and its
/// pictures' numbers counted on past 16 bits (the ids a transform reads)
#[derive(Default)]
pub struct Track {
	pub structure: Option<Arc<Structure>>,
	last: Option<i64>,
}

impl Track {
	/// a picture's id from its 16-bit number
	pub fn id(&mut self, number: u16) -> i64 {
		let id = match self.last {
			Some(last) => last + (number.wrapping_sub(last as u16) as i16) as i64,
			None => number as i64,
		};
		self.last = Some(id);
		id
	}
}
