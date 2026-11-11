//! The rewrite: a stylesheet, a declaration list or a single value with
//! every URL in it routed, byte for byte what `modifyCSS` and
//! `rewriteCSSValueURLs` (`src/rewriteCSS.ts`, `src/cssURLs.ts`) give.
//!
//! The lazy scan (css.rs) finds the raw pieces that could hold a URL; each
//! is then parsed in full where it stands (full.rs), as `deep` does, and its
//! leaves are routed as `route` routes them: a `Url` and a `String` through
//! css-tree's own decoding and encoding of them (`utils/url.js`,
//! `utils/string.js`), text no parse shaped through the URL expression of
//! `rewriteCSSValueURLs`. The replacements are spliced into the sheet's own
//! bytes at the end (`Edits`), an overlapping one dropped, as there.
//!
//! What a URL routes to is the host's to say (the base URL, the codec, the
//! config live there): `Route` is asked with a kind and the URL's text and
//! answers the routed URL, or that it does not route (not a URL, or already
//! routed), and the piece is then left as written.

use crate::css::*;
use crate::full::Context;
use crate::markup::{skip_spaces, space_at};

/// a url() the regex found, or a string in image-set() or src(): routed as
/// binary, and a failure says nothing
pub const QUIET: u32 = 1;
/// a `Url` node: routed as binary
pub const BINARY: u32 = 2;
/// a `Url` node of an @import: routed as a stylesheet
pub const STYLE: u32 = 3;
/// the string of an @import: routed as a stylesheet, unless it is one already
pub const IMPORT: u32 = 4;

/// The host's routing of `text` under `kind`, written to the buffer: true
/// when it routed, false to leave the piece as written
pub type Route<'r> = dyn FnMut(u32, &[u8], &mut Vec<u8>) -> Result<bool, Fail> + 'r;

/// `text.slice(start, end)`
fn slice(text: &[u8], start: usize, end: usize) -> &[u8] {
	let end = end.min(text.len());
	if start >= end { &[] } else { &text[start..end] }
}

/// `Edits` of src/rewriteCSS.ts: the replacements of a walk, in the order
/// they were made
struct Edits<'a> {
	text: &'a [u8],
	output: Vec<u8>,
	at: usize,
	edited: bool,
}

impl Edits<'_> {
	/// `text` from `start` to `end` becomes `replacement`; one that
	/// overlaps the last is dropped
	fn replace(&mut self, start: usize, end: usize, replacement: &[u8]) {
		if start < self.at {
			return;
		}
		if !self.edited {
			self.output.reserve(self.text.len() + self.text.len() / 8);
			self.edited = true;
		}
		self.output.extend_from_slice(slice(self.text, self.at, start));
		self.output.extend_from_slice(replacement);
		self.at = end;
	}
	/// the text with its replacements, or None when there were none
	fn result(mut self) -> Option<Vec<u8>> {
		if !self.edited {
			return None;
		}
		self.output
			.extend_from_slice(slice(self.text, self.at, self.text.len()));
		Some(self.output)
	}
}

// css-tree's decoding and encoding (lib/utils/string.js, lib/utils/url.js,
// lib/tokenizer/utils.js)

fn consume_escaped(source: &[u8], mut offset: usize) -> usize {
	let code = |at: usize| source.get(at).map_or(0, |&byte| byte as u32);
	offset += 2;
	if is_hex_digit(code(offset - 1)) {
		let max = source.len().min(offset + 5);
		while offset < max && is_hex_digit(code(offset)) {
			offset += 1;
		}
		let next = code(offset);
		if is_white_space(next) {
			offset += if next == 13 && code(offset + 1) == 10 { 2 } else { 1 };
		}
	}
	offset
}

/// `decodeEscaped`: one character that is no hex digit stands for itself
/// (its first byte here: the rest of it follows as text), hex digits for
/// their code point
fn decode_escaped(escaped: &[u8], decoded: &mut Vec<u8>) {
	if escaped.len() == 1 && !is_hex_digit(escaped[0] as u32) {
		decoded.push(escaped[0]);
		return;
	}
	let mut code: u32 = 0;
	for &byte in escaped {
		match (byte as char).to_digit(16) {
			Some(digit) => code = code * 16 + digit,
			None => break,
		}
	}
	let character = match code {
		0 => '\u{FFFD}',
		_ => char::from_u32(code).unwrap_or('\u{FFFD}'),
	};
	let mut bytes = [0u8; 4];
	decoded.extend_from_slice(character.encode_utf8(&mut bytes).as_bytes());
}

/// the loop `decode` of string.js and of url.js share: `str` from `start`
/// to `end`, inclusive, its escapes resolved
fn decode_range(str: &[u8], start: usize, end: isize) -> Vec<u8> {
	let len = str.len() as isize;
	let mut decoded = Vec::with_capacity(str.len());
	let mut i = start as isize;
	while i <= end {
		let code = str[i as usize];
		if code == b'\\' {
			if i == end {
				// the last character is a backslash: what stands after it,
				// if anything, is the whole value
				if i != len - 1 {
					decoded = str[i as usize + 1..].to_vec();
				}
				break;
			}
			i += 1;
			let code = str[i as usize] as u32;
			if is_valid_escape(0x5C, code) {
				let escape_start = i as usize - 1;
				let escape_end = consume_escaped(str, escape_start);
				i = escape_end as isize - 1;
				decode_escaped(slice(str, escape_start + 1, escape_end), &mut decoded);
			} else if code == 0x0D && str.get(i as usize + 1) == Some(&0x0A) {
				i += 1;
			}
		} else {
			decoded.push(code);
		}
		i += 1;
	}
	decoded
}

/// string.js `decode`: the value of a string token
pub fn string_decode(str: &[u8]) -> Vec<u8> {
	let len = str.len() as isize;
	let first = str.first().copied();
	let quoted = first == Some(b'"') || first == Some(b'\'');
	let end = if quoted && len > 1 && str.last().copied() == first {
		len - 2
	} else {
		len - 1
	};
	decode_range(str, quoted as usize, end)
}

/// url.js `decode`: the value of a url token
pub fn url_decode(str: &[u8]) -> Vec<u8> {
	let len = str.len() as isize;
	let mut start: isize = 4;
	let mut end = if str.last() == Some(&b')') { len - 2 } else { len - 1 };
	while start < end && is_white_space(str[start as usize] as u32) {
		start += 1;
	}
	while start < end && is_white_space(str[end as usize] as u32) {
		end -= 1;
	}
	decode_range(str, start as usize, end)
}

/// url.js `encode`: a value as a url token
pub fn url_encode(value: &[u8], encoded: &mut Vec<u8>) {
	encoded.extend_from_slice(b"url(");
	let mut space_before_hex = false;
	for &code in value {
		if code == 0 {
			encoded.extend_from_slice("\u{FFFD}".as_bytes());
			continue;
		}
		if code <= 0x1F || code == 0x7F {
			encoded.push(b'\\');
			if code >= 16 {
				encoded.push(b"0123456789abcdef"[(code >> 4) as usize]);
			}
			encoded.push(b"0123456789abcdef"[(code & 15) as usize]);
			space_before_hex = true;
			continue;
		}
		if matches!(code, b' ' | b'\\' | b'"' | b'\'' | b'(' | b')') {
			encoded.push(b'\\');
		} else if space_before_hex && is_hex_digit(code as u32) {
			encoded.push(b' ');
		}
		encoded.push(code);
		space_before_hex = false;
	}
	encoded.push(b')');
}

/// `JSON.stringify` of a string
pub fn json_string(value: &[u8], output: &mut Vec<u8>) {
	output.push(b'"');
	for &code in value {
		match code {
			b'"' => output.extend_from_slice(b"\\\""),
			b'\\' => output.extend_from_slice(b"\\\\"),
			0x08 => output.extend_from_slice(b"\\b"),
			0x0C => output.extend_from_slice(b"\\f"),
			0x0A => output.extend_from_slice(b"\\n"),
			0x0D => output.extend_from_slice(b"\\r"),
			0x09 => output.extend_from_slice(b"\\t"),
			0..=0x1F => {
				output.extend_from_slice(b"\\u00");
				output.push(b"0123456789abcdef"[(code >> 4) as usize]);
				output.push(b"0123456789abcdef"[(code & 15) as usize]);
			}
			_ => output.push(code),
		}
	}
	output.push(b'"');
}

/// `decodeURIComponent`, or None where it throws
pub fn decode_uri_component(text: &[u8]) -> Option<Vec<u8>> {
	let hex = |at: usize| -> Option<u8> {
		let high = (*text.get(at)? as char).to_digit(16)?;
		let low = (*text.get(at + 1)? as char).to_digit(16)?;
		Some((high * 16 + low) as u8)
	};
	let mut decoded = Vec::with_capacity(text.len());
	let mut at = 0;
	while at < text.len() {
		if text[at] != b'%' {
			decoded.push(text[at]);
			at += 1;
			continue;
		}
		let first = hex(at + 1)?;
		at += 3;
		if first < 0x80 {
			decoded.push(first);
			continue;
		}
		let length = first.leading_ones() as usize;
		if length == 1 || length > 4 {
			return None;
		}
		let mut octets = [first, 0, 0, 0];
		for octet in octets.iter_mut().take(length).skip(1) {
			if text.get(at) != Some(&b'%') {
				return None;
			}
			let next = hex(at + 1)?;
			if next & 0xC0 != 0x80 {
				return None;
			}
			*octet = next;
			at += 3;
		}
		std::str::from_utf8(&octets[..length]).ok()?;
		decoded.extend_from_slice(&octets[..length]);
	}
	Some(decoded)
}

// src/cssURLs.ts

/// where the last character that is no `\s` ends in `text[from..to]`, or
/// `from`: the start of the white space that runs up to `to`
fn trailing_spaces(text: &[u8], from: usize, to: usize) -> usize {
	let mut tail = from;
	let mut at = from;
	while at < to {
		let length = space_at(text, at);
		if length > 0 && at + length <= to {
			at += length;
		} else {
			at += 1;
			tail = at;
		}
	}
	tail
}

/// `/^url\(\s*(['"]?)(.*?)\1\s*\)$/s` on `token`: where group 2 stands
fn whole_url(token: &[u8]) -> Option<(usize, usize)> {
	if !token.starts_with(b"url(") || token.last() != Some(&b')') {
		return None;
	}
	let close = token.len() - 1;
	let start = skip_spaces(token, 4);
	if start < close && (token[start] == b'"' || token[start] == b'\'') {
		// quoted: the same quote is the last thing before the parenthesis
		let tail = trailing_spaces(token, start + 1, close);
		if tail > start + 1 && token[tail - 1] == token[start] {
			return Some((start + 1, tail - 1));
		}
	}
	Some((start, trailing_spaces(token, start, close)))
}

/// `originalOf`: the page's token and where its URL stands in it, from a
/// value that is routed already (it keeps the token after `#`)
fn original_of(target: &[u8]) -> Option<(Vec<u8>, (usize, usize))> {
	let hash = find(target, 0, b"#url(")?;
	let kept = &target[hash + 1..];
	let token = decode_uri_component(kept).unwrap_or_else(|| kept.to_vec());
	let url = whole_url(&token)?;
	Some((token, url))
}

/// `preserveValue`: `url` to its `#`, then `#` and the page's token
fn preserve_value(url: &[u8], value: &[u8], output: &mut Vec<u8>) {
	let end = url.iter().position(|&byte| byte == b'#').unwrap_or(url.len());
	output.extend_from_slice(&url[..end]);
	output.push(b'#');
	output.extend_from_slice(value);
}

/// the length of the line terminator at `at`, which `.` does not match
fn line_terminator(text: &[u8], at: usize) -> bool {
	match text.get(at) {
		Some(b'\n' | b'\r') => true,
		Some(0xE2) => text.get(at + 1) == Some(&0x80) && matches!(text.get(at + 2), Some(0xA8 | 0xA9)),
		_ => false,
	}
}

/// `/url\(\s*(['"]?)(.*?)\1\s*\)/` tried at the `url(` at `found`: where
/// group 2 stands and where the match ends. The expression backtracks in a
/// fixed order: all the white space, then a quote when one is there (group
/// 2 as short as it can be, the same quote after it), then no quote; fewer
/// white space cannot match where those did not.
fn url_at(text: &[u8], found: usize) -> Option<(usize, usize, usize)> {
	let start = skip_spaces(text, found + 4);
	if let Some(&quote) = text.get(start)
		&& (quote == b'"' || quote == b'\'')
	{
		let mut end = start + 1;
		while end < text.len() {
			if text[end] == quote {
				let close = skip_spaces(text, end + 1);
				if text.get(close) == Some(&b')') {
					return Some((start + 1, end, close + 1));
				}
			} else if line_terminator(text, end) {
				break;
			}
			end += 1;
		}
	}
	let mut end = start;
	loop {
		let close = skip_spaces(text, end);
		if text.get(close) == Some(&b')') {
			return Some((start, end, close + 1));
		}
		if close > end {
			// white space that no parenthesis follows: group 2 runs over it,
			// unless a line ends in it
			if (end..close).any(|at| line_terminator(text, at)) {
				return None;
			}
			end = close;
			continue;
		}
		if end >= text.len() {
			return None;
		}
		end += 1;
	}
}

/// `rewriteCSSValueURLs`: every url() of a raw value routed as binary, the
/// page's token kept after `#`. Appends to `output`.
pub fn rewrite_urls(value: &[u8], route: &mut Route, output: &mut Vec<u8>) -> Parsed {
	let mut copied = 0;
	let mut at = 0;
	let mut answer = Vec::new();
	let mut preserved = Vec::new();
	while let Some(found) = find(value, at, b"url(") {
		let Some((target_start, target_end, end)) = url_at(value, found) else {
			at = found + 1;
			continue;
		};
		let target = &value[target_start..target_end];
		let routed = original_of(target);
		let original = match &routed {
			Some((token, url)) => &token[url.0..url.1],
			None => target,
		};
		output.extend_from_slice(&value[copied..found]);
		if route(QUIET, original, &mut answer)? {
			// routed already: the page's token as it was kept
			let kept = match &routed {
				Some((token, _)) => token.as_slice(),
				None => &value[found..end],
			};
			preserved.clear();
			preserve_value(&answer, kept, &mut preserved);
			output.extend_from_slice(b"url(");
			json_string(&preserved, output);
			output.push(b')');
		} else {
			output.extend_from_slice(&value[found..end]);
		}
		copied = end;
		at = end;
	}
	output.extend_from_slice(&value[copied..]);
	Ok(())
}

/// A single value (`rewriteCSSValueURLs`), or None when it comes back as
/// it was
pub fn rewrite_value(value: &[u8], route: &mut Route) -> Result<Option<Vec<u8>>, Fail> {
	if find(value, 0, b"url(").is_none() {
		return Ok(None);
	}
	let mut output = Vec::with_capacity(value.len() + value.len() / 8);
	rewrite_urls(value, route, &mut output)?;
	Ok(if output == value { None } else { Some(output) })
}

/// the walk of one sheet: its edits and what routes its URLs
struct Walk<'a, 'r, 's> {
	source: &'a [u8],
	edits: Edits<'a>,
	route: &'r mut Route<'s>,
	answer: Vec<u8>,
	generated: Vec<u8>,
	preserved: Vec<u8>,
}

impl Walk<'_, '_, '_> {
	/// a `Raw` node from `start` to `end`: its url()s by the regex
	fn raw(&mut self, start: usize, end: usize, value: &[u8]) -> Parsed {
		if find(value, 0, b"url(").is_none() {
			return Ok(());
		}
		self.generated.clear();
		rewrite_urls(value, self.route, &mut self.generated)?;
		if self.generated != value {
			self.edits.replace(start, end, &self.generated);
		}
		Ok(())
	}
	/// `generate({ type: 'Url', value: preserveValue(answer, kept) })` in
	/// place of the node from `start` to `end`
	fn url(&mut self, start: usize, end: usize, kept: &[u8]) {
		self.preserved.clear();
		preserve_value(&self.answer, kept, &mut self.preserved);
		self.generated.clear();
		url_encode(&self.preserved, &mut self.generated);
		self.edits.replace(start, end, &self.generated);
	}
	/// `deep`: the piece from `start` to `end` parsed in `context` where it
	/// stands, and its leaves routed as the walk routes them
	fn deep(
		&mut self,
		start: usize,
		end: usize,
		context: Context,
		buffers: Buffers,
	) -> Result<Buffers, Fail> {
		let text = slice(self.source, start, end);
		let atrule = match context {
			Context::AtrulePrelude(name) => Some(name),
			_ => None,
		};
		let mut parser = Parser::recycled(text, buffers)?;
		match parser.parse_context(context) {
			Err(Fail::Decline) => return Err(Fail::Decline),
			Err(Fail::Syntax) => {
				// css-tree threw: the piece stays raw, as it would have
				self.raw(start, end, text)?;
				return Ok(parser.buffers());
			}
			Ok(()) => {}
		}
		for index in 0..parser.leaves.len() {
			let leaf = parser.leaves[index];
			let (from, to) = (start + leaf.start, start + leaf.end);
			if leaf.kind == RAW_LEAF {
				self.raw(from, to, parser.text(leaf.value))?;
				continue;
			}
			let token = &text[leaf.value.0..leaf.value.1];
			if leaf.kind == STRING_LEAF {
				let function = if leaf.function == NO_FUNCTION {
					&[][..]
				} else {
					parser.text(leaf.function)
				};
				if function.eq_ignore_ascii_case(b"image-set")
					|| function.eq_ignore_ascii_case(b"-webkit-image-set")
					|| function.eq_ignore_ascii_case(b"src")
				{
					// a string inside image-set() or src() is a URL: routed
					// as a url() token
					let value = string_decode(token);
					if (self.route)(QUIET, &value, &mut self.answer)? {
						let mut kept = Vec::with_capacity(value.len() + 8);
						kept.extend_from_slice(b"url(");
						json_string(&value, &mut kept);
						kept.push(b')');
						self.url(from, to, &kept);
					}
				} else if atrule == Some(b"import") {
					let value = string_decode(token);
					if (self.route)(IMPORT, &value, &mut self.answer)? {
						self.generated.clear();
						json_string(&self.answer, &mut self.generated);
						self.edits.replace(from, to, &self.generated);
					}
				}
				continue;
			}
			let value = if leaf.kind == URL_TOKEN_LEAF {
				url_decode(token)
			} else {
				string_decode(token)
			};
			let routed = original_of(&value);
			let original = match &routed {
				Some((token, url)) => &token[url.0..url.1],
				None => value.as_slice(),
			};
			let kind = if atrule == Some(b"import") { STYLE } else { BINARY };
			if (self.route)(kind, original, &mut self.answer)? {
				match &routed {
					Some((token, _)) => self.url(from, to, token),
					None => self.url(from, to, slice(self.source, from, to)),
				}
			}
		}
		Ok(parser.buffers())
	}
}

/// A stylesheet (`declaration_list` false) or a declaration list (an
/// element's `style`) rewritten, or None when it comes back as it was
pub fn rewrite(
	source: &[u8],
	declaration_list: bool,
	route: &mut Route,
) -> Result<Option<Vec<u8>>, Fail> {
	let pieces = scan(source, declaration_list)?;
	let mut walk = Walk {
		source,
		edits: Edits {
			text: source,
			output: Vec::new(),
			at: 0,
			edited: false,
		},
		route,
		answer: Vec::new(),
		generated: Vec::new(),
		preserved: Vec::new(),
	};
	let mut buffers = Buffers::default();
	for piece in pieces {
		let (start, end) = (piece.start, piece.end);
		buffers = match piece.kind {
			VALUE => walk.deep(start, end, Context::Value, buffers)?,
			SELECTOR => walk.deep(start, end, Context::SelectorList, buffers)?,
			PRELUDE => {
				let name = slice(source, piece.name.0, piece.name.1);
				walk.deep(start, end, Context::AtrulePrelude(name), buffers)?
			}
			_ => {
				walk.raw(start, end, slice(source, start, end))?;
				buffers
			}
		};
	}
	Ok(walk.edits.result())
}

#[cfg(test)]
mod tests {
	use super::*;

	/// a host that routes `text` to `/<kind>/<text>`, and nothing that
	/// starts with `!`
	fn route(kind: u32, text: &[u8], answer: &mut Vec<u8>) -> Result<bool, Fail> {
		if text.starts_with(b"!") {
			return Ok(false);
		}
		answer.clear();
		answer.extend_from_slice(format!("/{kind}/").as_bytes());
		answer.extend_from_slice(text);
		Ok(true)
	}
	fn sheet(source: &str) -> String {
		match rewrite(source.as_bytes(), false, &mut route).unwrap() {
			Some(output) => String::from_utf8(output).unwrap(),
			None => source.to_string(),
		}
	}
	fn value(source: &str) -> String {
		match rewrite_value(source.as_bytes(), &mut route).unwrap() {
			Some(output) => String::from_utf8(output).unwrap(),
			None => source.to_string(),
		}
	}

	#[test]
	fn url_tokens_and_functions() {
		assert_eq!(
			sheet("a { b: url(c.png) no-repeat, url( 'd e' ) }"),
			"a { b: url(/2/c.png#url\\(c.png\\)) no-repeat, url(/2/d\\ e#url\\(\\ \\'d\\ e\\'\\ \\)) }"
		);
		assert_eq!(sheet("a { b: url(!c) }"), "a { b: url(!c) }");
		assert_eq!(sheet("a { b: c }"), "a { b: c }");
	}

	#[test]
	fn imports_strings_and_image_sets() {
		assert_eq!(
			sheet("@import 'a.css';@import url(b.css) screen;"),
			"@import \"/4/a.css\";@import url(/3/b.css#url\\(b.css\\)) screen;"
		);
		assert_eq!(
			sheet("a{b:image-set(\"c\" 1x)}"),
			"a{b:image-set(url(/1/c#url\\(\\\"c\\\"\\)) 1x)}"
		);
		// the name is compared as the sheet wrote it
		assert_eq!(sheet("@IMPORT 'a.css';"), "@IMPORT 'a.css';");
	}

	#[test]
	fn raw_text_is_routed_by_the_expression() {
		assert_eq!(
			sheet("a { --b: url(c); d: url(e) ! f }"),
			"a { --b: url(\"/1/c#url(c)\"); d: url(/2/e#url\\(e\\)) ! f }"
		);
		assert_eq!(value("url( 'a b' ) url(c\n) url(d"), "url(\"/1/a b#url( 'a b' )\") url(\"/1/c#url(c\\n)\") url(d");
		assert_eq!(value("url('a\nb')"), "url('a\nb')");
		assert_eq!(value("url(\"a' ) x"), "url(\"/1/\\\"a'#url(\\\"a' )\") x");
	}

	#[test]
	fn a_value_routed_already_keeps_the_page_token() {
		assert_eq!(
			value("url(\"/1/old#url(%22a%20b%22)\")"),
			"url(\"/1/a b#url(\\\"a b\\\")\")"
		);
		assert_eq!(
			sheet("a{b:url(/2/old#url\\(c\\))}"),
			"a{b:url(/2/c#url\\(c\\))}"
		);
	}

	#[test]
	fn escapes_decode_and_encode_as_css_tree_does() {
		assert_eq!(string_decode(b"\"a\\62 c\\\nd\""), b"abcd".to_vec());
		// a string cut after a backslash: what follows it is the value
		assert_eq!(string_decode(b"\"a\\\""), b"\"".to_vec());
		assert_eq!(url_decode(b"url( a\\29 b )"), b"a)b".to_vec());
		let mut encoded = Vec::new();
		url_encode(b"a b\x01c\x01z(\0)", &mut encoded);
		assert_eq!(encoded, "url(a\\ b\\1 c\\1z\\(\u{FFFD}\\))".as_bytes());
		assert_eq!(decode_uri_component(b"%e2%82%ac%41"), Some("\u{20AC}A".as_bytes().to_vec()));
		assert_eq!(decode_uri_component(b"%c0%80"), None);
		assert_eq!(decode_uri_component(b"%4"), None);
	}

	#[test]
	fn an_overlapping_edit_is_dropped() {
		let mut edits = Edits {
			text: b"0123456789",
			output: Vec::new(),
			at: 0,
			edited: false,
		};
		edits.replace(2, 5, b"a");
		edits.replace(4, 6, b"b");
		edits.replace(7, 8, b"c");
		assert_eq!(edits.result(), Some(b"01a56c89".to_vec()));
	}
}
