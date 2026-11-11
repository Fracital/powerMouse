//! The markup scan: where a document's inline scripts and styles stand, and
//! whether it sets a base URL. `src/prewrite.ts` found them with three
//! regular expressions; this is the same three, read off byte by byte, so
//! the service worker's scan of a few megabytes of markup is one pass over
//! it. The answer is exactly what the expressions matched (JavaScript's
//! `matchAll`, leftmost and not overlapping), and the JavaScript side does
//! with each match what it did before: reads the attributes, tells a
//! classic script from a module, leaves out what does not run.
//!
//! ```text
//! /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
//! /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi
//! /<base\b[^>]*\shref\s*=/i
//! ```
//!
//! None has the `u` flag, so `i` folds ASCII letters only and `\b` knows
//! ASCII word characters only; `\s` is JavaScript's whole white space set.

/// one match: where the start tag's attributes stand (group 1) and where
/// the element's text stands (group 2), in bytes
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Element {
	pub attributes: (usize, usize),
	pub text: (usize, usize),
}

fn is_word(byte: u8) -> bool {
	byte.is_ascii_alphanumeric() || byte == b'_'
}

/// the length of the `\s` character at `at`, or 0: JavaScript's WhiteSpace
/// and LineTerminator (tab, LF, VT, FF, CR, space, U+00A0, U+1680,
/// U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF)
pub(crate) fn space_at(source: &[u8], at: usize) -> usize {
	match source.get(at) {
		Some(0x09..=0x0D | 0x20) => 1,
		Some(0xC2) if source.get(at + 1) == Some(&0xA0) => 2,
		Some(0xE1) if source.get(at + 1) == Some(&0x9A) && source.get(at + 2) == Some(&0x80) => 3,
		Some(0xE2) => match (source.get(at + 1), source.get(at + 2)) {
			(Some(0x80), Some(0x80..=0x8A | 0xA8 | 0xA9 | 0xAF)) => 3,
			(Some(0x81), Some(0x9F)) => 3,
			_ => 0,
		},
		Some(0xE3) if source.get(at + 1) == Some(&0x80) && source.get(at + 2) == Some(&0x80) => 3,
		Some(0xEF) if source.get(at + 1) == Some(&0xBB) && source.get(at + 2) == Some(&0xBF) => 3,
		_ => 0,
	}
}

pub(crate) fn skip_spaces(source: &[u8], mut at: usize) -> usize {
	loop {
		let length = space_at(source, at);
		if length == 0 {
			return at;
		}
		at += length;
	}
}

/// whether `name` (lower case ASCII) stands at `at`, ASCII case ignored
fn name_at(source: &[u8], at: usize, name: &[u8]) -> bool {
	source.len() >= at + name.len()
		&& source[at..at + name.len()]
			.iter()
			.zip(name)
			.all(|(&byte, &wanted)| byte.to_ascii_lowercase() == wanted)
}

fn position(source: &[u8], from: usize, byte: u8) -> Option<usize> {
	if from >= source.len() {
		return None;
	}
	source[from..]
		.iter()
		.position(|&other| other == byte)
		.map(|at| at + from)
}

/// The matches of `<name\b([^>]*)>([\s\S]*?)<\/name\s*>` in `source`
pub fn elements(source: &[u8], name: &[u8]) -> Vec<Element> {
	let mut found = Vec::new();
	let mut at = 0;
	while let Some(open) = position(source, at, b'<') {
		at = open + 1;
		if !name_at(source, open + 1, name) {
			continue;
		}
		let after = open + 1 + name.len();
		// \b: the name ends here
		if source.get(after).is_some_and(|&byte| is_word(byte)) {
			continue;
		}
		// no `>` after this start tag, so none after any later one either
		let Some(close) = position(source, after, b'>') else {
			break;
		};
		let text = close + 1;
		// the first end tag after the start tag; with none, no later start
		// tag has one either (its text starts no earlier)
		let mut search = text;
		let mut end = None;
		while let Some(tag) = position(source, search, b'<') {
			search = tag + 1;
			if source.get(tag + 1) != Some(&b'/') || !name_at(source, tag + 2, name) {
				continue;
			}
			let rest = skip_spaces(source, tag + 2 + name.len());
			if source.get(rest) == Some(&b'>') {
				end = Some((tag, rest + 1));
				break;
			}
		}
		let Some((tag, next)) = end else {
			break;
		};
		found.push(Element {
			attributes: (after, close),
			text: (text, tag),
		});
		at = next;
	}
	found
}

/// Whether `/<base\b[^>]*\shref\s*=/i` matches anywhere in `source`
pub fn has_base(source: &[u8]) -> bool {
	let mut at = 0;
	while let Some(open) = position(source, at, b'<') {
		at = open + 1;
		if !name_at(source, open + 1, b"base") {
			continue;
		}
		let after = open + 5;
		if source.get(after).is_some_and(|&byte| is_word(byte)) {
			continue;
		}
		// everything the rest matches is before the tag's `>`
		let end = position(source, after, b'>').unwrap_or(source.len());
		let mut space = after;
		while space < end {
			let length = space_at(source, space);
			if length == 0 {
				space += 1;
				continue;
			}
			if name_at(source, space + length, b"href") {
				let equals = skip_spaces(source, space + length + 4);
				if equals < end && source[equals] == b'=' {
					return true;
				}
			}
			space += length;
		}
	}
	false
}

#[cfg(test)]
mod tests {
	use super::*;

	fn texts<'a>(source: &'a str, name: &str) -> Vec<(&'a str, &'a str)> {
		elements(source.as_bytes(), name.as_bytes())
			.into_iter()
			.map(|element| {
				(
					&source[element.attributes.0..element.attributes.1],
					&source[element.text.0..element.text.1],
				)
			})
			.collect()
	}

	#[test]
	fn scripts_and_styles() {
		assert_eq!(
			texts(
				"<SCRIPT type=module>a</script ><scripts>no</scripts><script>b</SCRIPT\n>",
				"script"
			),
			vec![(" type=module", "a"), ("", "b")]
		);
		assert_eq!(
			texts("<style media=print>a{}</style x><style>b{}</style>", "style"),
			vec![(" media=print", "a{}</style x><style>b{}")]
		);
	}

	#[test]
	fn an_unclosed_element_ends_the_scan() {
		assert_eq!(texts("<script>a</script><script>b", "script"), vec![("", "a")]);
		assert_eq!(texts("<script a", "script"), vec![]);
	}

	#[test]
	fn base() {
		assert!(has_base(b"<p><BASE target=x HREF = '/'>"));
		assert!(has_base("<base\u{a0}href=x>".as_bytes()));
		assert!(!has_base(b"<base target=x><a href=y>"));
		assert!(!has_base(b"<basefont href=x>"));
		assert!(!has_base(b"<base xhref=x>"));
		assert!(has_base(b"<base-x href=x"));
	}
}
