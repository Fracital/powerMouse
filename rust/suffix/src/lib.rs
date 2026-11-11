//! The public suffix lookup's wasm boundary (docs/rust-plan.md, phase 2):
//! what tldts's `getDomain` and `getPublicSuffix` answer for a string, from
//! a table of the public suffix list (`build.rs`, `table`) and tldts's own
//! steps before the lookup (`host`), behind the byte-buffer ABI of the
//! other modules (`rust/rwjs/src/abi.rs`, loaded by `src/wasm/module.ts`),
//! with no import.
//!
//! - `a(len) -> ptr`: bytes for the host to write, for the call that
//!   follows; `f(ptr, len)` gives them back (nothing to do).
//! - `c(ptr, len) -> status`: a configuration; the lookup has none.
//! - `r(ptr, len, flags) -> status`: answers for the text in the bytes and
//!   keeps the answer until the next call.
//! - `p()`, `n()`: the answer's pointer and length. `b()`: no scratch.
//!
//! The flags of `r`:
//!
//! - 1: the public suffix (`getPublicSuffix`); without it the registrable
//!   domain (`getDomain`);
//! - 2: with the list's private section (`allowPrivateDomains: true`);
//!   without it the ICANN section alone, tldts's default;
//! - 4: the text is a host the module found before, lower-cased by the
//!   caller (see below), not an input to find a host in;
//! - 8: with 4, tldts took that host for valid already;
//! - 16: nothing is looked up: the answer is the list's pin, its commit in
//!   the publicsuffix/list repository and that commit's date.
//!
//! The answer is empty for tldts's `null`. Otherwise it is where the
//! answer stands in the input, `start end` in UTF-16 code units (what the
//! caller slices its string by, so nothing is decoded back), and then
//! sometimes a digit, because tldts does two things with a string that
//! belong to the caller's side of the boundary:
//!
//! - `start end 1`: the slice, lower-cased (it is ASCII);
//! - `start end 2`, `start end 3`: the host stands there and has both an
//!   upper-case ASCII letter and a letter that is not ASCII, so its lower
//!   case is ECMAScript's to make: the caller lower-cases the slice and
//!   asks again with flag 4 (and 8 after a 3);
//! - `0 0 4`: a tab or a newline stands in the input: the caller drops
//!   every one (U+0009, U+000A, U+000D) and asks again.
//!
//! Status 0 is an answer; 3 is input that is not UTF-8; 6 is a flag this
//! build does not know. A panic is a trap, which the loader takes for a
//! dead instance. The artifact is `no_std` and allocates nothing, so it
//! carries no allocator and none of the standard library's panic machinery.
#![cfg_attr(target_arch = "wasm32", no_std)]
#![allow(clippy::missing_safety_doc)]

pub mod host;
pub mod table;

pub const SUFFIX: u32 = 1;
pub const PRIVATE: u32 = 2;
pub const HOST: u32 = 4;
pub const VALID: u32 = 8;
pub const PIN: u32 = 16;

const NOT_UTF8: i32 = 3;
const UNKNOWN: i32 = 6;

/// An answer: two numbers and a digit, or the pin. Nothing in the artifact
/// allocates: the input and its UTF-16 units stand where `a` put them, the
/// table's index in a static, the answer here.
pub struct Output {
	bytes: [u8; 64],
	len: usize,
}

impl Output {
	pub const EMPTY: Output = Output {
		bytes: [0; 64],
		len: 0,
	};

	pub fn as_bytes(&self) -> &[u8] {
		&self.bytes[..self.len]
	}

	fn push(&mut self, byte: u8) {
		if let Some(slot) = self.bytes.get_mut(self.len) {
			*slot = byte;
			self.len += 1;
		}
	}

	fn number(&mut self, mut value: usize) {
		let mut digits = [0u8; 20];
		let mut at = digits.len();
		loop {
			at -= 1;
			digits[at] = b'0' + (value % 10) as u8;
			value /= 10;
			if value == 0 {
				break;
			}
		}
		for &digit in &digits[at..] {
			self.push(digit);
		}
	}

	fn span(&mut self, start: usize, end: usize, then: u8) {
		self.number(start);
		self.push(b' ');
		self.number(end);
		if then != 0 {
			self.push(b' ');
			self.push(b'0' + then);
		}
	}
}

/// the UTF-16 code units `bytes` (UTF-8) are
fn units_of(bytes: &[u8]) -> usize {
	bytes
		.iter()
		.map(|&byte| ((byte & 0xC0) != 0x80) as usize + (byte >= 0xF0) as usize)
		.sum()
}

/// how many of `bytes` (UTF-8) the first `units` UTF-16 code units are
fn bytes_of(bytes: &[u8], units: usize) -> usize {
	let mut seen = 0;
	for (at, &byte) in bytes.iter().enumerate() {
		if byte & 0xC0 != 0x80 {
			if seen >= units {
				return at;
			}
			seen += 1 + (byte >= 0xF0) as usize;
		}
	}
	bytes.len()
}

/// The answer for `input` under `flags` written to `output` (left empty for
/// tldts's null), and the status: tldts-core's `parseImpl` as STomp calls
/// it. `input` is lower-cased where tldts lower-cases; `units` is room for
/// as many UTF-16 code units as `input` has bytes.
pub fn answer_into(output: &mut Output, input: &mut [u8], units: &mut [u16], flags: u32) -> i32 {
	output.len = 0;
	if flags >= 2 * PIN {
		return UNKNOWN;
	}
	if flags & PIN != 0 {
		for &byte in env!("PSL_PIN").as_bytes() {
			output.push(byte);
		}
		return 0;
	}
	let Ok(text) = core::str::from_utf8(input) else {
		return NOT_UTF8;
	};
	let mut count = 0;
	for (slot, unit) in units.iter_mut().zip(text.encode_utf16()) {
		*slot = unit;
		count += 1;
	}
	let units = &mut units[..count];

	// where the host stands, whether tldts lower-cases it, and whether it
	// still has to be looked at for validity
	let (start, end, lower, validated) = if flags & HOST != 0 {
		(0, units.len(), false, flags & VALID != 0)
	} else {
		let whole = host::is_valid(units);
		match host::extract(units, whole) {
			host::Extract::None => return 0,
			host::Extract::Strip => {
				output.span(0, 0, 4);
				return 0;
			}
			host::Extract::Host(found) => (
				found.start,
				found.end,
				found.lower,
				// the input was valid and is the host as it stands
				found.validated || (whole && found.start == 0 && found.end == units.len()),
			),
		}
	};
	let name = &mut units[start..end];
	if lower {
		if name.iter().any(|&unit| unit > 127) {
			output.span(start, end, if validated { 3 } else { 2 });
			return 0;
		}
		for unit in name.iter_mut() {
			if (65..=90).contains(unit) {
				*unit += 32;
			}
		}
	}
	if name.is_empty() || host::is_ip(name) || (!validated && !host::is_valid(name)) {
		return 0;
	}

	// the same host as bytes, for the table
	let from = bytes_of(input, start);
	let to = from + bytes_of(&input[from..], end - start);
	let bytes = &mut input[from..to];
	if lower {
		bytes.make_ascii_lowercase();
	}
	let suffix = units_of(&bytes[..table::suffix(bytes, flags & PRIVATE != 0)]);
	let from = if flags & SUFFIX != 0 {
		suffix
	} else {
		// tldts-core domain.ts: no domain when the host is its suffix
		// (leading dots aside), else the suffix and one label more
		let dots = name.iter().take_while(|&&unit| unit == 46).count();
		if suffix == dots {
			return 0;
		}
		// the last dot at or before the unit two before the suffix; an
		// index below zero searches from zero, as lastIndexOf does
		let last = suffix.saturating_sub(2).min(name.len() - 1);
		(0..=last).rev().find(|&at| name[at] == 46).map_or(0, |dot| dot + 1)
	};
	output.span(start + from, end, lower as u8);
	0
}

/// The answer for `input` under `flags`, or the status that refuses it
#[cfg(not(target_arch = "wasm32"))]
pub fn answer(input: &[u8], flags: u32) -> Result<Vec<u8>, i32> {
	let mut output = Output::EMPTY;
	let mut units = vec![0u16; input.len()];
	match answer_into(&mut output, &mut input.to_vec(), &mut units, flags) {
		0 => Ok(output.as_bytes().to_vec()),
		status => Err(status),
	}
}

/// The exports. Memory is the module's own to lay out: the host's bytes go
/// at the heap's base, the same place for every call (nothing of a call
/// outlives it but the answer), and their UTF-16 units right after them.
#[cfg(target_arch = "wasm32")]
mod abi {
	use super::{Output, answer_into};
	use core::arch::wasm32::{memory_grow, memory_size, unreachable};
	use core::cell::UnsafeCell;

	unsafe extern "C" {
		static __heap_base: u8;
	}

	const PAGE: usize = 65536;

	struct Slot(UnsafeCell<Output>);
	// wasm32-unknown-unknown has one thread: the host calls one export at a time
	unsafe impl Sync for Slot {}

	static OUTPUT: Slot = Slot(UnsafeCell::new(Output::EMPTY));

	fn output() -> &'static mut Output {
		// SAFETY: single threaded, and no reference outlives the export call
		unsafe { &mut *OUTPUT.0.get() }
	}

	/// memory reaches `len` bytes at `at` and two more for each as UTF-16
	/// units, or the call traps: an instance that cannot hold its input is
	/// one the loader replaces
	fn room(at: usize, len: usize) {
		let reached = len
			.checked_mul(3)
			.and_then(|bytes| bytes.checked_add(at + 2))
			.is_some_and(|end| {
				let have = memory_size(0) * PAGE;
				end <= have || memory_grow(0, (end - have).div_ceil(PAGE)) != usize::MAX
			});
		if !reached {
			unreachable();
		}
	}

	/// `len` bytes the host writes, for the `c` or `r` that follows
	#[unsafe(no_mangle)]
	pub unsafe extern "C" fn a(len: usize) -> *mut u8 {
		let base = (&raw const __heap_base as usize + 7) & !7;
		room(base, len);
		base as *mut u8
	}

	#[unsafe(no_mangle)]
	pub unsafe extern "C" fn f(_ptr: *mut u8, _len: usize) {}

	#[unsafe(no_mangle)]
	pub unsafe extern "C" fn c(_ptr: *mut u8, _len: usize) -> i32 {
		0
	}

	#[unsafe(no_mangle)]
	pub unsafe extern "C" fn r(ptr: *mut u8, len: usize, flags: u32) -> i32 {
		if len == 0 {
			return answer_into(output(), &mut [], &mut [], flags);
		}
		room(ptr as usize, len);
		// SAFETY: `room` made the memory; the host wrote `len` bytes at
		// `ptr` and reads nothing of it again
		let (input, units) = unsafe {
			(
				core::slice::from_raw_parts_mut(ptr, len),
				core::slice::from_raw_parts_mut(((ptr as usize + len + 1) & !1) as *mut u16, len),
			)
		};
		answer_into(output(), input, units, flags)
	}

	#[unsafe(no_mangle)]
	pub unsafe extern "C" fn p() -> *const u8 {
		output().as_bytes().as_ptr()
	}

	#[unsafe(no_mangle)]
	pub unsafe extern "C" fn n() -> usize {
		output().as_bytes().len()
	}

	#[unsafe(no_mangle)]
	pub unsafe extern "C" fn b() -> *mut u8 {
		core::ptr::null_mut()
	}

	/// a panic is a trap, which the loader takes for a dead instance
	#[panic_handler]
	fn panic(_: &core::panic::PanicInfo) -> ! {
		unreachable()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	const LIST: &str = include_str!("public_suffix_list.dat");
	const VECTORS: &str = include_str!("../tests/test_psl.txt");

	/// the answer as the host reads it: the slice of `input`, lower-cased
	/// when the answer says so; None for tldts's null
	fn ask(input: &str, flags: u32) -> Option<String> {
		let answered = String::from_utf8(answer(input.as_bytes(), flags).unwrap()).unwrap();
		if answered.is_empty() {
			return None;
		}
		let parts: Vec<usize> = answered.split(' ').map(|part| part.parse().unwrap()).collect();
		let units: Vec<u16> = input.encode_utf16().collect();
		let slice = String::from_utf16(&units[parts[0]..parts[1]]).unwrap();
		match parts.get(2) {
			None => Some(slice),
			Some(1) => Some(slice.to_ascii_lowercase()),
			// what the host does next, with Rust's lower case for ECMAScript's
			Some(code @ (2 | 3)) => ask(&slice.to_lowercase(), flags | HOST | if *code == 3 { VALID } else { 0 }),
			Some(4) => ask(&input.replace(['\t', '\n', '\r'], ""), flags),
			Some(other) => panic!("an answer of {other}"),
		}
	}

	fn domain(input: &str) -> Option<String> {
		ask(input, PRIVATE)
	}

	fn suffix(input: &str) -> Option<String> {
		ask(input, SUFFIX | PRIVATE)
	}

	#[test]
	fn the_answer_is_where_it_stands() {
		assert_eq!(answer(b"www.example.co.uk", 0).unwrap(), b"4 17");
		assert_eq!(answer(b"www.example.co.uk", SUFFIX).unwrap(), b"12 17");
		assert_eq!(answer(b"https://user@WWW.Example.COM:8080/p", 0).unwrap(), b"17 28 1");
		// offsets are UTF-16 code units: the emoji is two
		assert_eq!(answer("a.\u{1F600}.example.com".as_bytes(), 0).unwrap(), b"5 16");
		// a dot alone has an empty suffix, which is not null
		assert_eq!(answer(b".", SUFFIX).unwrap(), b"1 1");
		assert_eq!(answer(b".", 0).unwrap(), b"");
	}

	#[test]
	fn the_sections() {
		assert_eq!(ask("a.b.github.io", PRIVATE).as_deref(), Some("b.github.io"));
		assert_eq!(ask("a.b.github.io", 0).as_deref(), Some("github.io"));
		assert_eq!(ask("a.b.github.io", SUFFIX | PRIVATE).as_deref(), Some("github.io"));
		assert_eq!(ask("a.b.github.io", SUFFIX).as_deref(), Some("io"));
		// the six suffixes tldts answers before its table, ICANN only
		assert_eq!(ask("a.blogspot.com", SUFFIX).as_deref(), Some("com"));
		assert_eq!(ask("a.blogspot.com", SUFFIX | PRIVATE).as_deref(), Some("blogspot.com"));
		assert_eq!(ask("x.de", SUFFIX).as_deref(), Some("de"));
	}

	#[test]
	fn wildcards_and_exceptions() {
		assert_eq!(suffix("a.b.ck").as_deref(), Some("b.ck"));
		assert_eq!(domain("a.b.ck").as_deref(), Some("a.b.ck"));
		assert_eq!(suffix("www.ck").as_deref(), Some("ck"));
		assert_eq!(domain("a.www.ck").as_deref(), Some("www.ck"));
		assert_eq!(domain("b.ck"), None);
		assert_eq!(suffix("city.kawasaki.jp").as_deref(), Some("kawasaki.jp"));
		assert_eq!(suffix("x.kawasaki.jp").as_deref(), Some("x.kawasaki.jp"));
		// tldts's own: a wildcard takes an empty label
		assert_eq!(suffix(".ck").as_deref(), Some(".ck"));
		assert_eq!(domain(".ck").as_deref(), Some("ck"));
	}

	#[test]
	fn a_host_keeps_to_one_spelling_of_a_rule() {
		// the rule 個人.香港, which tldts keeps as written and in punycode
		assert_eq!(suffix("a.個人.香港").as_deref(), Some("個人.香港"));
		assert_eq!(suffix("a.xn--gmqw5a.xn--j6w193g").as_deref(), Some("xn--gmqw5a.xn--j6w193g"));
		// and a host that mixes the two reaches only the rule 香港
		assert_eq!(suffix("a.xn--gmqw5a.香港").as_deref(), Some("香港"));
		assert_eq!(suffix("a.個人.xn--j6w193g").as_deref(), Some("xn--j6w193g"));
		// an ASCII label under either spelling
		assert_eq!(suffix("a.公司.cn").as_deref(), Some("公司.cn"));
		assert_eq!(suffix("a.xn--55qx5d.cn").as_deref(), Some("xn--55qx5d.cn"));
	}

	#[test]
	fn hosts_with_no_answer() {
		for input in ["1.2.3.4", "[::1]", "::1", "2a01:e35::1", "http://[2001:db8::1]:80/"] {
			assert_eq!(suffix(input), None, "{input}");
			assert_eq!(domain(input), None, "{input}");
		}
		for input in ["", " ", "a..b", "-a.com", "a-.com", "a b.com", "data:text/html,a.com", "mailto:x"] {
			assert_eq!(suffix(input), None, "{input:?}");
		}
		assert_eq!(suffix("localhost").as_deref(), Some("localhost"));
		assert_eq!(domain("localhost"), None);
		assert_eq!(suffix("a.unlisted-tld").as_deref(), Some("unlisted-tld"));
		assert_eq!(domain("b.a.unlisted-tld").as_deref(), Some("a.unlisted-tld"));
		// a label of 63 units is a host, of 64 not: units, not bytes
		let label = "\u{e9}".repeat(63);
		assert_eq!(domain(&format!("{label}.com")), Some(format!("{label}.com")));
		assert_eq!(domain(&format!("{label}e.com")), None);
	}

	#[test]
	fn what_the_caller_finishes() {
		assert_eq!(answer("\u{c4}.Example.com".as_bytes(), 0).unwrap(), b"0 13 3");
		assert_eq!(answer("x@\u{c4}.Example.com".as_bytes(), 0).unwrap(), b"2 15 2");
		assert_eq!(answer("\u{e4}.example.com".as_bytes(), HOST | VALID).unwrap(), b"2 13");
		assert_eq!(domain("\u{c4}.Example.com").as_deref(), Some("example.com"));
		assert_eq!(answer(b"exa\tmple.com", 0).unwrap(), b"0 0 4");
		assert_eq!(domain("exa\tmple.c\nom").as_deref(), Some("example.com"));
		// between brackets tldts always lower-cases
		assert_eq!(domain("[Example.com]").as_deref(), Some("example.com"));
	}

	#[test]
	fn the_pin_and_the_refusals() {
		let pin = String::from_utf8(answer(b"", PIN).unwrap()).unwrap();
		let (commit, date) = pin.split_once(' ').unwrap();
		assert!(commit.len() == 40 && commit.bytes().all(|byte| byte.is_ascii_hexdigit()));
		assert!(date.len() == 10 && date.as_bytes()[4] == b'-');
		assert_eq!(answer(b"a.com", 32), Err(UNKNOWN));
		assert_eq!(answer(&[0xff], 0), Err(NOT_UTF8));
	}

	/// every rule of the list, as the list spells it: `(rule, private)`
	fn rules() -> Vec<(&'static str, bool)> {
		let mut private = false;
		let mut out = Vec::new();
		for line in LIST.lines() {
			let line = line.trim();
			if line.contains("===BEGIN PRIVATE DOMAINS===") {
				private = true;
			}
			if line.is_empty() || line.starts_with("//") {
				continue;
			}
			out.push((line.split_whitespace().next().unwrap(), private));
		}
		out
	}

	#[test]
	fn every_rule_of_the_list_is_in_the_table() {
		let rules = rules();
		assert!(rules.len() > 9000, "{} rules", rules.len());
		// a label no rule has
		let probe = "q7q7q7";
		for &(rule, private) in &rules {
			if let Some(rest) = rule.strip_prefix('!') {
				// an exception: the suffix is the rule less its first label
				let parent = rest.split_once('.').unwrap().1;
				assert_eq!(suffix(rest).as_deref(), Some(parent), "{rule}");
				assert_eq!(domain(&format!("{probe}.{rest}")).as_deref(), Some(rest), "{rule}");
				continue;
			}
			let host = rule.replace('*', probe);
			assert_eq!(suffix(&host).as_deref(), Some(host.as_str()), "{rule}");
			assert_eq!(domain(&host), None, "{rule}");
			let under = format!("{probe}.{host}");
			if rules.iter().any(|&(other, _)| other.strip_prefix("*.") == Some(rule)) {
				// the rule has a wildcard under it, which takes the label
				assert_eq!(suffix(&format!("a.{under}")).as_deref(), Some(under.as_str()), "{rule}");
				continue;
			}
			assert_eq!(suffix(&format!("a.{under}")).as_deref(), Some(host.as_str()), "{rule}");
			assert_eq!(domain(&format!("a.{under}")).as_deref(), Some(under.as_str()), "{rule}");
			// a private rule is no rule without the private section
			if private {
				assert_ne!(ask(&host, SUFFIX).as_deref(), Some(host.as_str()), "{rule}");
			} else {
				assert_eq!(ask(&host, SUFFIX).as_deref(), Some(host.as_str()), "{rule}");
			}
		}
		let (nodes, edges, bytes) = table::shape();
		assert!(nodes < edges && edges > 9000);
		// far smaller than the list it is made from
		assert!(bytes * 4 < LIST.len(), "{bytes} bytes");
	}

	#[test]
	fn the_lists_own_test_vectors() {
		let mut checked = 0;
		for line in VECTORS.lines() {
			let Some(arguments) = line.strip_prefix("checkPublicSuffix(") else {
				continue;
			};
			let (input, expected) = arguments.strip_suffix(");").unwrap().split_once(", ").unwrap();
			if input == "null" {
				continue;
			}
			let input = input.trim_matches('\'');
			let expected = (expected != "null").then(|| expected.trim_matches('\''));
			let answered = domain(input);
			// tldts takes a host with a leading dot as the host without
			// it, where the list's vectors want no answer: the one place
			// tldts and the vectors part, and the module is tldts
			if input.starts_with('.') && expected.is_none() {
				assert_eq!(answered, domain(&input[1..]), "{input}");
			} else {
				assert_eq!(answered.as_deref(), expected, "{input}");
			}
			checked += 1;
		}
		assert!(checked > 70, "{checked} vectors");
	}
}
