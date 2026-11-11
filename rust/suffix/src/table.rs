//! The public suffix list as `build.rs` laid it out (the format is set out
//! there), and the lookup over it: tldts's, step for step
//! (`tldts/src/suffix-trie.ts`), because the answer has to be tldts's for
//! every host and not only for the ones where the two algorithms agree.
//! What that means where the list's own algorithm would differ:
//!
//! - at each label the exact edge is taken when there is one and the
//!   wildcard only otherwise, with no way back (a host whose label matches
//!   a deeper rule's inner label is not also tried against a wildcard);
//! - a wildcard matches an empty label too (`.ck` under `*.ck`);
//! - without the private section, a host ending in one of six common
//!   suffixes is answered before the table is looked at;
//! - tldts keeps a rule with a label that is not ASCII twice, as the list
//!   spells it and in punycode, and a host has to keep to one form: under
//!   `香港` only `個人` is a rule, under `xn--j6w193g` only `xn--gmqw5a`.
//!   The table holds the punycode form alone, so the walk remembers which
//!   form the host took (`Form`) and refuses the other from then on.
use core::cmp::Ordering;

include!(concat!(env!("OUT_DIR"), "/sizes.rs"));

static STARTS: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/starts"));
static FLAGS: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/flags"));
static CHILDREN: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/children"));
static TEXT: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/text"));

pub const ICANN: u8 = 1;
pub const PRIVATE: u8 = 2;

/// a label's last character by the number `build.rs` wrote it as
const SYMBOLS: &[u8; 40] = b"abcdefghijklmnopqrstuvwxyz0123456789-*_\0";
const WILDCARD: u8 = 37;

/// What the text does not say outright, worked out once: where each edge's
/// label starts (and the end of the last), and the node each edge leads to
pub struct Index {
	offsets: [u32; EDGES + 1],
	child: [u16; EDGES],
	ready: bool,
}

impl Index {
	const EMPTY: Index = Index {
		offsets: [0; EDGES + 1],
		child: [0; EDGES],
		ready: false,
	};

	fn fill(&mut self) {
		let mut edge = 0;
		let mut far = 0;
		for (at, &byte) in TEXT.iter().enumerate() {
			if byte >= 0x80 {
				continue;
			}
			// a label's last byte says where its edge leads
			self.child[edge] = match byte / 40 {
				0 => 0,
				1 => 1,
				_ => {
					far += 1;
					short(CHILDREN, far - 1) as u16
				}
			};
			edge += 1;
			self.offsets[edge] = at as u32 + 1;
		}
		self.ready = true;
	}
}

fn short(bytes: &[u8], at: usize) -> usize {
	u16::from_le_bytes([bytes[at * 2], bytes[at * 2 + 1]]) as usize
}

/// the index, made on first use (the artifact has one thread)
#[cfg(target_arch = "wasm32")]
fn index() -> &'static Index {
	struct Slot(core::cell::UnsafeCell<Index>);
	// wasm32-unknown-unknown has one thread: the host calls one export at a time
	unsafe impl Sync for Slot {}
	static SLOT: Slot = Slot(core::cell::UnsafeCell::new(Index::EMPTY));
	// SAFETY: single threaded, and written only before it is first handed out
	unsafe {
		let index = &mut *SLOT.0.get();
		if !index.ready {
			index.fill();
		}
		&*SLOT.0.get()
	}
}

#[cfg(not(target_arch = "wasm32"))]
fn index() -> &'static Index {
	static INDEX: std::sync::OnceLock<Index> = std::sync::OnceLock::new();
	INDEX.get_or_init(|| {
		let mut index = Index::EMPTY;
		index.fill();
		index
	})
}

/// which of tldts's two spellings of a rule the host's labels have taken
#[derive(Clone, Copy, PartialEq)]
enum Form {
	Either,
	Unicode,
	Punycode,
}

/// the stored label `kept` against `label`, as the build sorted them
fn order(label: &[u8], kept: &[u8]) -> Ordering {
	let last = kept.len() - 1;
	for (at, &byte) in label.iter().enumerate() {
		if at > last {
			return Ordering::Greater;
		}
		let stored = if at == last { SYMBOLS[(kept[at] % 40) as usize] } else { kept[at] & 0x7F };
		match byte.cmp(&stored) {
			Ordering::Equal => {}
			other => return other,
		}
	}
	label.len().cmp(&kept.len())
}

/// the edge of `node` labelled `label` (ASCII)
fn find(index: &Index, node: usize, label: &[u8]) -> Option<usize> {
	let (mut low, mut high) = (short(STARTS, node), short(STARTS, node + 1));
	while low < high {
		let middle = (low + high) / 2;
		let kept = &TEXT[index.offsets[middle] as usize..index.offsets[middle + 1] as usize];
		match order(label, kept) {
			Ordering::Equal => return Some(middle),
			Ordering::Less => high = middle,
			Ordering::Greater => low = middle + 1,
		}
	}
	None
}

/// the `*` edge of `node`, which sorts first
fn wildcard(index: &Index, node: usize) -> Option<usize> {
	let first = short(STARTS, node);
	let kept = &TEXT[index.offsets[first] as usize..];
	(first < short(STARTS, node + 1) && kept[0] < 0x80 && kept[0] % 40 == WILDCARD).then_some(first)
}

/// RFC 3492: `label` (UTF-8, not ASCII) as `xn--` and its punycode, into
/// `out`; None when it does not fit, and then it is no rule's label
fn to_ascii(label: &[u8], out: &mut [u8; 64]) -> Option<usize> {
	const BASE: u32 = 36;
	const TMIN: u32 = 1;
	const TMAX: u32 = 26;
	fn digit(value: u32) -> u8 {
		if value < 26 { b'a' + value as u8 } else { b'0' + (value - 26) as u8 }
	}
	fn adapt(mut delta: u32, points: u32, first: bool) -> u32 {
		delta /= if first { 700 } else { 2 };
		delta += delta / points;
		let mut k = 0;
		while delta > ((BASE - TMIN) * TMAX) / 2 {
			delta /= BASE - TMIN;
			k += BASE;
		}
		k + (BASE - TMIN + 1) * delta / (delta + 38)
	}
	let label = core::str::from_utf8(label).ok()?;
	let mut len = 0;
	let mut push = |byte: u8| -> Option<()> {
		*out.get_mut(len)? = byte;
		len += 1;
		Some(())
	};
	for &byte in b"xn--" {
		push(byte)?;
	}
	let mut basic = 0u32;
	let mut total = 0u32;
	for point in label.chars() {
		total += 1;
		if point.is_ascii() {
			push(point as u8)?;
			basic += 1;
		}
	}
	if basic > 0 {
		push(b'-')?;
	}
	let mut handled = basic;
	let (mut n, mut delta, mut bias) = (128u32, 0u32, 72u32);
	while handled < total {
		let next = label.chars().map(|point| point as u32).filter(|&point| point >= n).min()?;
		delta = delta.checked_add((next - n).checked_mul(handled + 1)?)?;
		n = next;
		for point in label.chars().map(|point| point as u32) {
			if point < n {
				delta = delta.checked_add(1)?;
			}
			if point == n {
				let mut q = delta;
				let mut k = BASE;
				loop {
					let t = if k <= bias {
						TMIN
					} else if k >= bias + TMAX {
						TMAX
					} else {
						k - bias
					};
					if q < t {
						break;
					}
					push(digit(t + (q - t) % (BASE - t)))?;
					q = (q - t) / (BASE - t);
					k += BASE;
				}
				push(digit(q))?;
				bias = adapt(delta, handled + 1, handled == basic);
				delta = 0;
				handled += 1;
			}
		}
		delta += 1;
		n += 1;
	}
	Some(len)
}

/// The edge of `node` that `label` takes as tldts's trie has it: the label
/// itself, or the punycode of one that is not ASCII, in the form the host
/// has kept to so far
fn exact(index: &Index, node: usize, label: &[u8], form: &mut Form) -> Option<usize> {
	if label.is_ascii() {
		let edge = find(index, node, label)?;
		if label.starts_with(b"xn--") {
			if *form == Form::Unicode {
				return None;
			}
			*form = Form::Punycode;
		}
		return Some(edge);
	}
	if *form == Form::Punycode {
		return None;
	}
	let mut ascii = [0u8; 64];
	let len = to_ascii(label, &mut ascii)?;
	let edge = find(index, node, &ascii[..len])?;
	*form = Form::Unicode;
	Some(edge)
}

/// `host`'s labels walked from the right under `root`: the bounds of the
/// label that reached the deepest rule of the sections in `mask`
fn walk(index: &Index, host: &[u8], root: usize, mask: u8) -> Option<(usize, usize)> {
	let mut node = root;
	let mut end = host.len();
	let mut form = Form::Either;
	let mut matched = None;
	for at in (0..host.len()).rev() {
		if host[at] != b'.' {
			continue;
		}
		let start = at + 1;
		let Some(edge) =
			exact(index, node, &host[start..end], &mut form).or_else(|| wildcard(index, node))
		else {
			return matched;
		};
		node = index.child[edge] as usize;
		if FLAGS[node] & mask != 0 {
			matched = Some((start, end));
		}
		end = at;
	}
	if let Some(edge) = exact(index, node, &host[..end], &mut form).or_else(|| wildcard(index, node))
	{
		node = index.child[edge] as usize;
		if FLAGS[node] & mask != 0 {
			matched = Some((0, end));
		}
	}
	matched
}

/// Where `host`'s public suffix starts (it runs to the host's end; it is
/// empty when the host ends with a dot nothing matched before); with the
/// private section or the ICANN section alone
pub fn suffix(host: &[u8], private: bool) -> usize {
	if !private && host.len() > 3 {
		let tail = &host[host.len() - 4..];
		if [&b".com"[..], b".org", b".edu", b".gov", b".net"].contains(&tail) {
			return host.len() - 3;
		}
		if &tail[1..] == b".de" {
			return host.len() - 2;
		}
	}
	let index = index();
	let mask = if private { ICANN | PRIVATE } else { ICANN };
	// an exception rule wins, and its own first label is not of the suffix
	if let Some((_, end)) = walk(index, host, EXCEPTIONS, mask) {
		return (end + 1).min(host.len());
	}
	if let Some((start, _)) = walk(index, host, RULES, mask) {
		return start;
	}
	// no rule: the last label is the suffix
	host.iter().rposition(|&byte| byte == b'.').map_or(0, |dot| dot + 1)
}

/// nodes, edges, and the bytes the table takes in the artifact
pub fn shape() -> (usize, usize, usize) {
	(
		FLAGS.len(),
		EDGES,
		STARTS.len() + FLAGS.len() + CHILDREN.len() + TEXT.len(),
	)
}
