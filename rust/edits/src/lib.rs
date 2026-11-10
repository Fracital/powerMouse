//! Text edits at byte spans of a source, spliced into it in one pass. The
//! rewriters never print a syntax tree: every byte of the input that no edit
//! covers is in the output unchanged, in order (docs/rust-plan.md, section
//! 5), so comments, spelling and line structure survive, and a function's
//! position in the text is its position in the input.
//!
//! Three kinds of edit:
//!
//! - [`Edit::wrap`]: text before and after a span, whose inside is still
//!   edited (`$s$j.get2(` ... `, "k")` around an object expression that has
//!   rewrites of its own).
//! - [`Edit::replace`]: a span's bytes replaced. Nothing may edit inside a
//!   replaced span: the builder refuses the set.
//! - [`Edit::insert`]: text at a point, with an order that breaks ties
//!   between insertions at one offset (a function mark against a wrap's
//!   opening paren).
//!
//! Edits must nest properly: two spans either nest or are disjoint. An
//! improperly nested set is a bug in the visitor and is refused as a whole
//! (the caller falls back to the JavaScript rewriter for that script) rather
//! than spliced into something that is not the program the page wrote.

use std::cmp::Ordering;

/// A byte range of the source, `start..end`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
	pub start: u32,
	pub end: u32,
}

impl Span {
	pub const fn new(start: u32, end: u32) -> Self {
		Self { start, end }
	}
	pub const fn len(self) -> u32 {
		self.end - self.start
	}
}

/// A piece of edit text: fixed text, or a slice of the source
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Piece {
	/// text the rewriter wrote
	Text(String),
	/// the source between two offsets, as it is (a helper's argument that
	/// names the page's expression)
	Source(Span),
}

impl From<&str> for Piece {
	fn from(text: &str) -> Self {
		Piece::Text(text.to_owned())
	}
}

impl From<String> for Piece {
	fn from(text: String) -> Self {
		Piece::Text(text)
	}
}

impl From<Span> for Piece {
	fn from(span: Span) -> Self {
		Piece::Source(span)
	}
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Kind {
	Wrap { before: Vec<Piece>, after: Vec<Piece> },
	Replace { text: Vec<Piece> },
	Insert { text: Vec<Piece>, order: i16 },
}

/// One edit of the source
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edit {
	span: Span,
	kind: Kind,
}

impl Edit {
	/// `before` ahead of the span and `after` behind it, the inside still edited
	pub fn wrap(span: Span, before: Vec<Piece>, after: Vec<Piece>) -> Self {
		Self {
			span,
			kind: Kind::Wrap { before, after },
		}
	}
	/// the span's bytes become `text`; nothing may edit inside it
	pub fn replace(span: Span, text: Vec<Piece>) -> Self {
		Self {
			span,
			kind: Kind::Replace { text },
		}
	}
	/// `text` at `at`; of two insertions at one offset the lower `order` comes first
	pub fn insert(at: u32, text: Vec<Piece>, order: i16) -> Self {
		Self {
			span: Span::new(at, at),
			kind: Kind::Insert { text, order },
		}
	}
	pub fn span(&self) -> Span {
		self.span
	}
}

/// Why a set of edits cannot be spliced
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditError {
	/// a span past the end of the source, or ending before it starts
	OutOfBounds(Span),
	/// two spans that overlap without nesting
	Crossing(Span, Span),
	/// an edit inside a replaced span
	InsideReplace(Span, Span),
	/// a span boundary that is not a character boundary of the source
	NotCharBoundary(u32),
}

/// The order edits are applied in: by start, outer before inner, then by
/// insertion order. An insertion at the start of a span belongs to what is
/// inside the span: inside a wrap (after its `before`, the content is still
/// there), before a replace (outside it, the content is gone). At the end
/// of a span the same way: before a wrap's `after`, after a replace.
fn order(a: &Edit, b: &Edit) -> Ordering {
	a.span.start.cmp(&b.span.start).then_with(|| {
		let insert_a = matches!(a.kind, Kind::Insert { .. });
		let insert_b = matches!(b.kind, Kind::Insert { .. });
		match (insert_a, insert_b) {
			(true, true) => {
				let (Kind::Insert { order: x, .. }, Kind::Insert { order: y, .. }) =
					(&a.kind, &b.kind)
				else {
					unreachable!()
				};
				x.cmp(y)
			}
			// the insert against a span starting here
			(true, false) => edge(b),
			(false, true) => edge(a).reverse(),
			(false, false) => b.span.end.cmp(&a.span.end),
		}
	})
}

/// where an insertion at a span's start goes relative to the span's edit
fn edge(spanned: &Edit) -> Ordering {
	match spanned.kind {
		// inside: after the wrap
		Kind::Wrap { .. } => Ordering::Greater,
		// outside: before the replace
		_ => Ordering::Less,
	}
}

/// The output of `source` with `edits` spliced in, or why it cannot be
pub fn apply(source: &str, mut edits: Vec<Edit>) -> Result<String, EditError> {
	let len = source.len() as u32;
	for edit in &edits {
		let span = edit.span;
		if span.end < span.start || span.end > len {
			return Err(EditError::OutOfBounds(span));
		}
		for at in [span.start, span.end] {
			if !source.is_char_boundary(at as usize) {
				return Err(EditError::NotCharBoundary(at));
			}
		}
	}
	edits.sort_by(order);
	check_nesting(&edits)?;

	// the output grows by what the edits add; a rewrite rarely doubles
	let mut out = String::with_capacity(source.len() + source.len() / 2 + 64);
	let mut cursor = 0u32;
	// the wraps whose `after` is still to be written, innermost last
	let mut open: Vec<(u32, &[Piece])> = Vec::new();

	let mut i = 0;
	while i < edits.len() {
		let edit = &edits[i];
		let start = edit.span.start;
		// wraps that end where this edit starts are closed first, unless it
		// is an insertion there, which belongs inside them
		let insert = matches!(edit.kind, Kind::Insert { .. });
		close_through(source, &mut out, &mut cursor, &mut open, start, !insert);
		if start > cursor {
			out.push_str(&source[cursor as usize..start as usize]);
			cursor = start;
		}
		match &edit.kind {
			Kind::Wrap { before, after } => {
				write(source, &mut out, before);
				open.push((edit.span.end, after));
			}
			Kind::Replace { text } => {
				write(source, &mut out, text);
				cursor = edit.span.end;
			}
			Kind::Insert { text, .. } => {
				write(source, &mut out, text);
			}
		}
		i += 1;
	}
	close_through(source, &mut out, &mut cursor, &mut open, len, true);
	if len > cursor {
		out.push_str(&source[cursor as usize..]);
	}
	Ok(out)
}

/// close every open wrap that ends before `at`, and those ending at `at`
/// too when `inclusive` (not when the edit starting at `at` is an insertion,
/// which belongs inside a wrap that ends there)
fn close_through(
	source: &str,
	out: &mut String,
	cursor: &mut u32,
	open: &mut Vec<(u32, &[Piece])>,
	at: u32,
	inclusive: bool,
) {
	while let Some(&(end, after)) = open.last() {
		if end > at || (end == at && !inclusive) {
			break;
		}
		if end > *cursor {
			out.push_str(&source[*cursor as usize..end as usize]);
			*cursor = end;
		}
		write(source, out, after);
		open.pop();
	}
}

fn write(source: &str, out: &mut String, pieces: &[Piece]) {
	for piece in pieces {
		match piece {
			Piece::Text(text) => out.push_str(text),
			Piece::Source(span) => {
				out.push_str(&source[span.start as usize..span.end as usize]);
			}
		}
	}
}

/// every pair of spans nests or is disjoint, and nothing is inside a replace
fn check_nesting(edits: &[Edit]) -> Result<(), EditError> {
	// the enclosing spans, innermost last, with whether each is a replace
	let mut stack: Vec<(Span, bool)> = Vec::new();
	for edit in edits {
		let span = edit.span;
		while let Some(&(outer, _)) = stack.last() {
			if outer.end <= span.start && !(outer.end == span.start && span.len() == 0 && outer.len() > 0) {
				stack.pop();
			} else {
				break;
			}
		}
		if let Some(&(outer, replaced)) = stack.last() {
			let inside = span.start >= outer.start && span.end <= outer.end;
			if !inside {
				return Err(EditError::Crossing(outer, span));
			}
			// an insertion at a replaced span's edge is outside it; anything
			// with bytes inside is not
			let at_edge = span.len() == 0 && (span.start == outer.start || span.start == outer.end);
			if replaced && !at_edge {
				return Err(EditError::InsideReplace(outer, span));
			}
		}
		let replaced = matches!(edit.kind, Kind::Replace { .. });
		if span.len() > 0 || !matches!(edit.kind, Kind::Insert { .. }) {
			stack.push((span, replaced));
		}
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	fn t(s: &str) -> Vec<Piece> {
		vec![Piece::from(s)]
	}

	#[test]
	fn untouched_source_is_identical() {
		let src = "const x = 1;\n// comment\n";
		assert_eq!(apply(src, vec![]).unwrap(), src);
	}

	#[test]
	fn wrap_and_replace() {
		let src = "a.b(c)";
		let edits = vec![
			Edit::wrap(Span::new(0, 6), t("W("), t(")")),
			Edit::replace(Span::new(1, 3), t("['b']")),
		];
		assert_eq!(apply(src, edits).unwrap(), "W(a['b'](c))");
	}

	#[test]
	fn nested_wraps_and_inner_edits() {
		let src = "location.href";
		let edits = vec![
			Edit::wrap(Span::new(0, 13), t("G2("), t(", \"href\")")),
			Edit::replace(Span::new(8, 13), t("")),
			Edit::wrap(Span::new(0, 8), t("G("), t(", \"location\")")),
		];
		assert_eq!(
			apply(src, edits).unwrap(),
			"G2(G(location, \"location\"), \"href\")"
		);
	}

	#[test]
	fn inserts_order_at_one_offset() {
		let src = "function f() {}";
		let edits = vec![
			Edit::insert(10, t("/*mark*/"), 0),
			Edit::insert(10, t("/*second*/"), 1),
		];
		assert_eq!(apply(src, edits).unwrap(), "function f/*mark*//*second*/() {}");
	}

	#[test]
	fn insert_at_wrap_start_goes_inside() {
		let src = "x";
		let edits = vec![
			Edit::wrap(Span::new(0, 1), t("("), t(")")),
			Edit::insert(0, t("+"), 0),
		];
		assert_eq!(apply(src, edits).unwrap(), "(+x)");
	}

	#[test]
	fn insert_at_wrap_end_goes_inside() {
		let src = "xy";
		let edits = vec![
			Edit::wrap(Span::new(0, 1), t("("), t(")")),
			Edit::insert(1, t("!"), 0),
		];
		assert_eq!(apply(src, edits).unwrap(), "(x!)y");
	}

	#[test]
	fn source_pieces_copy_the_input() {
		let src = "o[k]";
		let edits = vec![Edit::wrap(
			Span::new(0, 4),
			t("get2("),
			vec![Piece::from(", "), Piece::from(Span::new(0, 4)), Piece::from(")")],
		)];
		assert_eq!(apply(src, edits).unwrap(), "get2(o[k], o[k])");
	}

	#[test]
	fn crossing_spans_are_refused() {
		let src = "abcdef";
		let edits = vec![
			Edit::wrap(Span::new(0, 4), t("("), t(")")),
			Edit::wrap(Span::new(2, 6), t("["), t("]")),
		];
		assert!(matches!(apply(src, edits), Err(EditError::Crossing(..))));
	}

	#[test]
	fn edits_inside_a_replace_are_refused() {
		let src = "abcdef";
		let edits = vec![
			Edit::replace(Span::new(0, 4), t("X")),
			Edit::insert(2, t("!"), 0),
		];
		assert!(matches!(apply(src, edits), Err(EditError::InsideReplace(..))));
	}

	#[test]
	fn inserts_at_a_replace_edge_are_outside_it() {
		let src = "abcdef";
		let edits = vec![
			Edit::replace(Span::new(2, 4), t("X")),
			Edit::insert(2, t("<"), 0),
			Edit::insert(4, t(">"), 0),
		];
		assert_eq!(apply(src, edits).unwrap(), "ab<X>ef");
	}

	#[test]
	fn out_of_bounds_and_char_boundaries() {
		assert!(matches!(
			apply("ab", vec![Edit::insert(3, t("x"), 0)]),
			Err(EditError::OutOfBounds(_))
		));
		// a two-byte character: offset 1 is inside it
		assert!(matches!(
			apply("é", vec![Edit::insert(1, t("x"), 0)]),
			Err(EditError::NotCharBoundary(1))
		));
		assert_eq!(apply("é", vec![Edit::insert(2, t("x"), 0)]).unwrap(), "éx");
	}

	#[test]
	fn adjacent_spans_are_disjoint() {
		let src = "ab";
		let edits = vec![
			Edit::wrap(Span::new(0, 1), t("("), t(")")),
			Edit::wrap(Span::new(1, 2), t("["), t("]")),
		];
		assert_eq!(apply(src, edits).unwrap(), "(a)[b]");
	}
}
