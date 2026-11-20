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
	/// text the caller writes into the output where it stands
	/// ([`apply_filling`]): a text as long as the source, made from it,
	/// that would otherwise be made apart and then copied in
	Fill,
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
	/// `text` at `at`; of two insertions at one offset the lower `order`
	/// comes first, and a negative `order` stays outside a wrap that starts
	/// there (a preamble ahead of a statement the rewriter wraps)
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
			(true, false) => edge(a, b),
			(false, true) => edge(b, a).reverse(),
			(false, false) => b.span.end.cmp(&a.span.end),
		}
	})
}

/// where an insertion at a span's start goes relative to the span's edit
fn edge(insert: &Edit, spanned: &Edit) -> Ordering {
	match (&insert.kind, &spanned.kind) {
		// one that asked to stay outside: before the wrap
		(Kind::Insert { order, .. }, Kind::Wrap { .. }) if *order < 0 => Ordering::Less,
		// inside: after the wrap
		(_, Kind::Wrap { .. }) => Ordering::Greater,
		// outside: before the replace
		_ => Ordering::Less,
	}
}

/// The output of `source` with `edits` spliced in, or why it cannot be
pub fn apply(source: &str, edits: Vec<Edit>) -> Result<String, EditError> {
	apply_range(source, Span::new(0, source.len() as u32), edits)
}

/// [`apply`], with `fill` writing each [`Piece::Fill`] at the end of the
/// output where the piece stands, the output given room for `fill_len`
/// bytes more for each (it grows if `fill` writes more)
pub fn apply_filling(
	source: &str,
	edits: Vec<Edit>,
	fill_len: usize,
	fill: &mut dyn FnMut(&mut String),
) -> Result<String, EditError> {
	apply_with(source, Span::new(0, source.len() as u32), edits, fill_len, fill)
}

/// The output of the part `range` of `source` alone, with `edits` (all of
/// them inside it) spliced in: a part the rewriter writes somewhere else, or
/// twice, is rendered on its own and becomes the text of an edit
pub fn apply_range(source: &str, range: Span, edits: Vec<Edit>) -> Result<String, EditError> {
	apply_with(source, range, edits, 0, &mut |_| {})
}

fn apply_with(
	source: &str,
	range: Span,
	edits: Vec<Edit>,
	fill_len: usize,
	fill: &mut dyn FnMut(&mut String),
) -> Result<String, EditError> {
	let edits = checked(source, range, edits)?;
	let mut writer = Writer {
		out: String::with_capacity(output_len(range, &edits, fill_len)),
		fill,
	};
	emit(source, range, &edits, &mut writer);
	Ok(writer.out)
}

/// [`apply_filling`], and where each stretch of the output stands in the
/// source: the [`Positions`] of the output as it is without its fill,
/// which `fill` is handed too (to write them into it)
pub fn apply_mapped(
	source: &str,
	edits: Vec<Edit>,
	fill_len: &dyn Fn(&Positions) -> usize,
	utf16: &dyn Fn(u32) -> u32,
	fill: &mut dyn FnMut(&mut String, &Positions),
) -> Result<(String, Positions), EditError> {
	let range = Span::new(0, source.len() as u32);
	let edits = checked(source, range, edits)?;
	let mut mapper = Mapper {
		utf16,
		out: 0,
		anchor: 0,
		ended: 0,
		pending: None,
		positions: Positions::default(),
	};
	emit(source, range, &edits, &mut mapper);
	mapper.flush();
	let positions = mapper.positions;
	let mut write_fill = |out: &mut String| fill(out, &positions);
	let mut writer = Writer {
		out: String::with_capacity(output_len(range, &edits, fill_len(&positions))),
		fill: &mut write_fill,
	};
	emit(source, range, &edits, &mut writer);
	Ok((writer.out, positions))
}

/// `edits` in the order they are written, once they are known to be in
/// bounds, on character boundaries and nested
fn checked(source: &str, range: Span, mut edits: Vec<Edit>) -> Result<Vec<Edit>, EditError> {
	let len = range.end;
	if range.end < range.start || range.end as usize > source.len() {
		return Err(EditError::OutOfBounds(range));
	}
	for edit in &edits {
		let span = edit.span;
		if span.end < span.start || span.end > len || span.start < range.start {
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
	Ok(edits)
}

/// the output's length, so it is allocated once: the part, less what the
/// replaces take out (nothing is inside one, check_nesting), plus every
/// piece written
fn output_len(range: Span, edits: &[Edit], fill_len: usize) -> usize {
	let pieces = |pieces: &[Piece]| -> usize {
		pieces
			.iter()
			.map(|piece| match piece {
				Piece::Text(text) => text.len(),
				Piece::Source(span) => span.len() as usize,
				Piece::Fill => fill_len,
			})
			.sum()
	};
	let mut size = range.len() as usize;
	for edit in edits {
		match &edit.kind {
			Kind::Wrap { before, after } => size += pieces(before) + pieces(after),
			// (the replaced spans are apart and inside the part, so what
			// they take out is never more than its length)
			Kind::Replace { text } => size = size - edit.span.len() as usize + pieces(text),
			Kind::Insert { text, .. } => size += pieces(text),
		}
	}
	size
}

/// what the output is made of, in order: the source's bytes copied, text
/// written, and the fills
trait Sink {
	/// what is written next is an edit's, which stands at `at` of the source
	fn at(&mut self, _at: u32) {}
	fn copy(&mut self, source: &str, start: u32, end: u32);
	fn text(&mut self, text: &str);
	fn fill(&mut self);
}

/// the sink that writes the output
struct Writer<'f> {
	out: String,
	fill: &'f mut dyn FnMut(&mut String),
}

impl Sink for Writer<'_> {
	fn copy(&mut self, source: &str, start: u32, end: u32) {
		self.out.push_str(&source[start as usize..end as usize]);
	}
	fn text(&mut self, text: &str) {
		self.out.push_str(text);
	}
	fn fill(&mut self) {
		(self.fill)(&mut self.out);
	}
}

/// The splice, in order, of the part `range` of `source` with `edits`
/// (sorted and nested, [`checked`]) into `sink`
fn emit(source: &str, range: Span, edits: &[Edit], sink: &mut dyn Sink) {
	let len = range.end;
	let mut cursor = range.start;
	// the wraps whose `after` is still to be written, innermost last
	let mut open: Vec<(u32, &[Piece])> = Vec::new();
	for edit in edits {
		let start = edit.span.start;
		// wraps that end where this edit starts are closed first, unless it
		// is an insertion there, which belongs inside them
		let insert = matches!(edit.kind, Kind::Insert { .. });
		close_through(source, sink, &mut cursor, &mut open, start, !insert);
		if start > cursor {
			sink.copy(source, cursor, start);
			cursor = start;
		}
		sink.at(start);
		match &edit.kind {
			Kind::Wrap { before, after } => {
				write(source, sink, before);
				open.push((edit.span.end, after));
			}
			Kind::Replace { text } => {
				write(source, sink, text);
				cursor = edit.span.end;
			}
			Kind::Insert { text, .. } => write(source, sink, text),
		}
	}
	close_through(source, sink, &mut cursor, &mut open, len, true);
	if len > cursor {
		sink.copy(source, cursor, len);
	}
}

/// close every open wrap that ends before `at`, and those ending at `at`
/// too when `inclusive` (not when the edit starting at `at` is an insertion,
/// which belongs inside a wrap that ends there)
fn close_through(
	source: &str,
	sink: &mut dyn Sink,
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
			sink.copy(source, *cursor, end);
			*cursor = end;
		}
		sink.at(end);
		write(source, sink, after);
		open.pop();
	}
}

fn write(source: &str, sink: &mut dyn Sink, pieces: &[Piece]) {
	for piece in pieces {
		match piece {
			Piece::Text(text) => sink.text(text),
			Piece::Source(span) => sink.copy(source, span.start, span.end),
			Piece::Fill => sink.fill(),
		}
	}
}

/// Where the output of [`apply_mapped`] stands in the source, the output
/// taken without its fill, in UTF-16 units: each stretch of it a copy of
/// the source's (a position in it stands where the copy came from) or text
/// written, which stands at one place of the source: where the edit that
/// writes it stands (its span's start, or its end for a wrap's closing
/// text), or where a copy of the source among its pieces ended
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Positions {
	/// the stretches, in order, as base64 VLQ numbers ([`push_vlq`]): for
	/// each its length, then its place in the source less where the stretch
	/// before ended (zigzag), shifted left once with 1 for text
	pub runs: String,
	/// where the fill is in the output without it, and where it stands in
	/// the source (None: there is none)
	pub fill: Option<(u32, u32)>,
}

/// A base64 VLQ digit: the source map alphabet, which holds no `*`, so a
/// map is carried in a block comment as it is
const VLQ: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// `value` as base64 VLQ digits, five bits each, least first, every digit
/// but the last with its sixth bit set
pub fn push_vlq(out: &mut String, mut value: u64) {
	loop {
		let digit = (value & 31) as usize;
		value >>= 5;
		if value == 0 {
			out.push(VLQ[digit] as char);
			return;
		}
		out.push(VLQ[digit | 32] as char);
	}
}

/// a signed number as an unsigned one, small either way: 2n, or -2n - 1
fn zigzag(value: i64) -> u64 {
	((value << 1) ^ (value >> 63)) as u64
}

/// one stretch of the output: where it starts in the source (its anchor,
/// for text), its length, and whether it is text
#[derive(Clone, Copy)]
struct Run {
	src: u32,
	len: u32,
	text: bool,
}

/// the sink that maps the output ([`Positions`])
struct Mapper<'u> {
	utf16: &'u dyn Fn(u32) -> u32,
	/// the output's length so far, in UTF-16 units
	out: u32,
	/// where the last copy ended in the source (text after it stands there)
	anchor: u32,
	/// where the last stretch encoded ended in the source
	ended: u32,
	/// the stretch being made, which the next may go on
	pending: Option<Run>,
	positions: Positions,
}

impl Mapper<'_> {
	fn run(&mut self, run: Run) {
		if let Some(pending) = &mut self.pending {
			// a copy that goes on where the last ended, or text at the same
			// place
			let goes_on = pending.text == run.text
				&& if run.text { pending.src == run.src } else { pending.src + pending.len == run.src };
			if goes_on {
				pending.len += run.len;
				return;
			}
		}
		self.flush();
		self.pending = Some(run);
	}
	fn flush(&mut self) {
		let Some(run) = self.pending.take() else {
			return;
		};
		let runs = &mut self.positions.runs;
		push_vlq(runs, u64::from(run.len));
		push_vlq(runs, zigzag(i64::from(run.src) - i64::from(self.ended)) << 1 | u64::from(run.text));
		self.ended = if run.text { run.src } else { run.src + run.len };
	}
}

impl Sink for Mapper<'_> {
	fn at(&mut self, at: u32) {
		self.anchor = (self.utf16)(at);
	}
	fn copy(&mut self, _: &str, start: u32, end: u32) {
		if start == end {
			return;
		}
		let (start, end) = ((self.utf16)(start), (self.utf16)(end));
		self.run(Run {
			src: start,
			len: end - start,
			text: false,
		});
		self.out += end - start;
		self.anchor = end;
	}
	fn text(&mut self, text: &str) {
		let len = (if text.is_ascii() { text.len() } else { text.encode_utf16().count() }) as u32;
		if len == 0 {
			return;
		}
		self.run(Run {
			src: self.anchor,
			len,
			text: true,
		});
		self.out += len;
	}
	fn fill(&mut self) {
		self.flush();
		self.positions.fill = Some((self.out, self.anchor));
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
	fn a_negative_insert_stays_outside_a_wrap() {
		let src = "x";
		let edits = vec![
			Edit::wrap(Span::new(0, 1), t("("), t(")")),
			Edit::insert(0, t("pre;"), -1),
		];
		assert_eq!(apply(src, edits).unwrap(), "pre;(x)");
	}

	#[test]
	fn a_range_is_rendered_alone() {
		let src = "f(a, b)";
		let edits = vec![
			Edit::wrap(Span::new(2, 3), t("<"), t(">")),
			Edit::replace(Span::new(5, 6), t("B")),
		];
		assert_eq!(apply_range(src, Span::new(2, 6), edits).unwrap(), "<a>, B");
		assert!(matches!(
			apply_range(src, Span::new(2, 6), vec![Edit::insert(1, t("x"), 0)]),
			Err(EditError::OutOfBounds(_))
		));
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

	#[test]
	fn fills_are_written_where_they_stand() {
		let src = "'use strict'; a.b";
		let fill = |out: &mut String| out.push_str("<held>");
		let edits = vec![
			Edit::wrap(Span::new(0, 12), Vec::new(), vec![Piece::from(";"), Piece::Fill]),
			Edit::wrap(Span::new(14, 17), t("W("), t(")")),
		];
		let out = apply_filling(src, edits, 6, &mut { fill }).unwrap();
		assert_eq!(out, "'use strict';<held>; W(a.b)");
		assert_eq!(out.capacity(), out.len());
		let edits = vec![Edit::insert(0, vec![Piece::Fill, Piece::from("\n")], -1)];
		let mut longer = |out: &mut String| out.push_str(&"x".repeat(100));
		assert_eq!(apply_filling("a", edits, 4, &mut longer).unwrap(), format!("{}\na", "x".repeat(100)));
	}

	/// the runs of a map read back: (out start, src start, len, text)
	pub(crate) fn read_runs(runs: &str) -> Vec<(u32, u32, u32, bool)> {
		let mut digits = runs.bytes().map(|b| VLQ.iter().position(|d| *d == b).unwrap() as u64);
		let mut next = || -> Option<u64> {
			let mut value = 0;
			let mut shift = 0;
			loop {
				let digit = digits.next()?;
				value |= (digit & 31) << shift;
				shift += 5;
				if digit & 32 == 0 {
					return Some(value);
				}
			}
		};
		let mut read = Vec::new();
		let (mut out, mut ended) = (0u32, 0i64);
		while let Some(len) = next() {
			let packed = next().unwrap();
			let text = packed & 1 == 1;
			let delta = packed >> 1;
			let delta = (delta >> 1) as i64 ^ -((delta & 1) as i64);
			let src = (ended + delta) as u32;
			read.push((out, src, len as u32, text));
			out += len as u32;
			ended = if text { i64::from(src) } else { i64::from(src) + len as i64 };
		}
		read
	}

	#[test]
	fn the_map_says_where_each_stretch_came_from() {
		// a mark, a wrap around an edited member, a replace that copies a
		// part of the source, and a statement replaced around a part of it
		let src = "function f(a) { return a.b[c] }\nx = y;";
		let edits = vec![
			Edit::insert(10, t("/*k.0.20*/"), 0),
			Edit::wrap(Span::new(23, 29), t("$g("), t(")")),
			Edit::replace(Span::new(24, 29), vec![Piece::from("["), Piece::Source(Span::new(27, 28)), Piece::from("]")]),
			Edit::replace(Span::new(32, 37), vec![Piece::from("$s(x,"), Piece::Source(Span::new(36, 37)), Piece::from(")")]),
		];
		let (out, positions) = apply_mapped(src, edits, &|_| 0, &|b| b, &mut |_, _| {}).unwrap();
		assert_eq!(out, "function f/*k.0.20*/(a) { return $g(a[c]) }\n$s(x,y);");
		assert_eq!(positions.fill, None);
		let runs = read_runs(&positions.runs);
		let mut covered = 0;
		for (out_at, src_at, len, text) in &runs {
			assert_eq!(*out_at, covered);
			covered += len;
			if !text {
				assert_eq!(out[*out_at as usize..(out_at + len) as usize], src[*src_at as usize..(src_at + len) as usize]);
			}
		}
		assert_eq!(covered as usize, out.len());
		// each text stands where its edit does: the mark after the name,
		// `$g(` at the member, `[` where `.b[c]` starts, `]` after the `c`
		// it copied, `)` at the member's end, `$s(x,` at the statement,
		// `)` after the `y` it copied
		let texts: Vec<(&str, u32)> =
			runs.iter().filter(|r| r.3).map(|r| (&out[r.0 as usize..(r.0 + r.2) as usize], r.1)).collect();
		assert_eq!(texts, vec![("/*k.0.20*/", 10), ("$g(", 23), ("[", 24), ("]", 28), (")", 29), ("$s(x,", 32), (")", 37)]);
		// the same output as apply's
		let edits = vec![Edit::insert(10, t("/*k.0.20*/"), 0)];
		assert_eq!(apply_mapped(src, edits.clone(), &|_| 0, &|b| b, &mut |_, _| {}).unwrap().0, apply(src, edits).unwrap());
	}

	#[test]
	fn the_map_counts_utf16_and_leaves_the_fill_out() {
		// two-byte and four-byte characters in a directive, a fill after it
		let src = "'\u{fc}\u{1F600}'; a.b";
		let at = |c: u32| src[..c as usize].encode_utf16().count() as u32;
		let a = src.find("a.b").unwrap() as u32;
		let edits = vec![
			Edit::wrap(Span::new(0, a - 2), Vec::new(), vec![Piece::from(";"), Piece::Fill]),
			Edit::wrap(Span::new(a, a + 3), t("W("), t(")")),
		];
		let mut handed = None;
		let (out, positions) = apply_mapped(src, edits, &|_| 3, &at, &mut |out, p| {
			out.push_str("<f>");
			handed = Some(p.clone());
		})
		.unwrap();
		assert_eq!(out, "'\u{fc}\u{1F600}';<f>; W(a.b)");
		assert_eq!(handed.as_ref(), Some(&positions));
		// the fill after the directive and its `;`, in UTF-16 units
		assert_eq!(positions.fill, Some((6, 5)));
		let runs = read_runs(&positions.runs);
		assert_eq!(runs, vec![(0, 0, 5, false), (5, 5, 1, true), (6, 5, 2, false), (8, 7, 2, true), (10, 7, 3, false), (13, 10, 1, true)]);
	}
}
