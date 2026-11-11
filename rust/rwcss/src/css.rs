//! The stylesheet scan: which pieces of a stylesheet (or of a declaration
//! list) the CSS rewriter has to look into, found without building a tree.
//!
//! `src/rewriteCSS.ts` parses a sheet lazily with css-tree (values, at-rule
//! preludes and selectors left as raw text), walks the tree, and parses in
//! full only the raw pieces that could hold a URL. That first parse and walk
//! is nearly all of its time on a large sheet, and it is what this module
//! replaces: it answers the same pieces, in the same order, and the
//! JavaScript side does with each exactly what it did before. So the output
//! is the JavaScript rewriter's byte for byte as long as the pieces are the
//! same, which is all this module has to get right.
//!
//! To get it right it is a port, not a reimplementation: css-tree 3.2.1's
//! tokenizer (`lib/tokenizer/index.js`), its token stream with the balance
//! table (`TokenStream.js`) and the lazy halves of its node parsers
//! (`lib/syntax/node/{StyleSheet,Atrule,Rule,Block,Declaration,
//! DeclarationList,Raw}.js`), quirk for quirk, with the JavaScript names
//! kept so the two can be read side by side. Where a sheet is past what
//! this port covers (see `Fail::Decline`), it declines and the JavaScript
//! rewriter does the sheet.
//!
//! Offsets are bytes of UTF-8 here and UTF-16 units there. Every token
//! boundary falls between characters in both (a byte of 0x80 or more is a
//! name character exactly as a UTF-16 unit of 0x80 or more is), so the
//! pieces are converted once, at the end.

pub const EOF: u8 = 0;
pub const IDENT: u8 = 1;
pub const FUNCTION: u8 = 2;
pub const AT_KEYWORD: u8 = 3;
pub const HASH: u8 = 4;
pub const STRING: u8 = 5;
pub const BAD_STRING: u8 = 6;
pub const URL: u8 = 7;
pub const BAD_URL: u8 = 8;
pub const DELIM: u8 = 9;
pub const NUMBER: u8 = 10;
pub const PERCENTAGE: u8 = 11;
pub const DIMENSION: u8 = 12;
pub const WHITESPACE: u8 = 13;
pub const CDO: u8 = 14;
pub const CDC: u8 = 15;
pub const COLON: u8 = 16;
pub const SEMICOLON: u8 = 17;
pub const COMMA: u8 = 18;
pub const LEFT_SQUARE: u8 = 19;
pub const RIGHT_SQUARE: u8 = 20;
pub const LEFT_PAREN: u8 = 21;
pub const RIGHT_PAREN: u8 = 22;
pub const LEFT_CURLY: u8 = 23;
pub const RIGHT_CURLY: u8 = 24;
pub const COMMENT: u8 = 25;

/// Blocks nested deeper than this fail as css-tree's fail when its stack
/// runs out (a RangeError, at some 1,500 blocks in V8, give or take what
/// was on the stack): the nearest `parseWithFallback` takes the rule or
/// at-rule as raw text, whose url()s the expression routes. The port
/// recurses on the stack the host gave the call (V8 stops it at 2,300 to
/// 5,000 blocks, by what tier compiled it and what called it), so it stops
/// well short of that and at a depth that is always the same.
const MAX_DEPTH: u32 = 1024;

/// `source.charCodeAt(offset)` past the end: NaN, equal to nothing
const NAN: u32 = u32::MAX;

pub(crate) const fn is_digit(code: u32) -> bool {
	code >= 0x30 && code <= 0x39
}
pub(crate) const fn is_hex_digit(code: u32) -> bool {
	is_digit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66)
}
const fn is_uppercase(code: u32) -> bool {
	code >= 0x41 && code <= 0x5A
}
const fn is_letter(code: u32) -> bool {
	is_uppercase(code) || (code >= 0x61 && code <= 0x7A)
}
/// a byte of a multi-byte character stands for its UTF-16 units, all of
/// which are 0x80 or more
const fn is_name_start(code: u32) -> bool {
	code != NAN && (is_letter(code) || code >= 0x80 || code == 0x5F)
}
const fn is_name(code: u32) -> bool {
	is_name_start(code) || is_digit(code) || code == 0x2D
}
fn is_non_printable(code: u32) -> bool {
	code <= 0x08 || code == 0x0B || (0x0E..=0x1F).contains(&code) || code == 0x7F
}
pub(crate) const fn is_newline(code: u32) -> bool {
	code == 0x0A || code == 0x0D || code == 0x0C
}
pub(crate) const fn is_white_space(code: u32) -> bool {
	is_newline(code) || code == 0x20 || code == 0x09
}
pub(crate) fn is_valid_escape(first: u32, second: u32) -> bool {
	first == 0x5C && !is_newline(second) && second != 0
}
fn is_identifier_start(first: u32, second: u32, third: u32) -> bool {
	if first == 0x2D {
		return is_name_start(second) || second == 0x2D || is_valid_escape(second, third);
	}
	if is_name_start(first) {
		return true;
	}
	if first == 0x5C {
		return is_valid_escape(first, second);
	}
	false
}
fn is_number_start(first: u32, second: u32, third: u32) -> bool {
	if first == 0x2B || first == 0x2D {
		if is_digit(second) {
			return true;
		}
		return second == 0x2E && is_digit(third);
	}
	if first == 0x2E {
		return is_digit(second);
	}
	is_digit(first)
}

/// what a byte is to the tokenizer's loops, looked up instead of compared
const SPACE: u8 = 1;
const DIGIT: u8 = 2;
const NAME_START: u8 = 4;
const NAME: u8 = 8;
static CLASS: [u8; 256] = {
	let mut class = [0u8; 256];
	let mut byte = 0;
	while byte < 256 {
		let code = byte as u32;
		let mut bits = 0;
		if is_white_space(code) {
			bits |= SPACE;
		}
		if is_digit(code) {
			bits |= DIGIT;
		}
		if is_name_start(code) {
			bits |= NAME_START;
		}
		if is_name(code) {
			bits |= NAME;
		}
		class[byte] = bits;
		byte += 1;
	}
	class
};
fn class(byte: u8) -> u8 {
	CLASS[byte as usize]
}

/// the tokens of a source, as css-tree's `tokenize` reports them
struct Tokenizer<'a> {
	source: &'a [u8],
	offset: usize,
	kind: u8,
}

impl Tokenizer<'_> {
	/// `getCharCode`: 0 past the end
	fn code(&self, offset: usize) -> u32 {
		self.source.get(offset).map_or(0, |&byte| byte as u32)
	}
	/// `source.charCodeAt`: NaN past the end
	fn raw(&self, offset: usize) -> u32 {
		self.source.get(offset).map_or(NAN, |&byte| byte as u32)
	}
	fn len(&self) -> usize {
		self.source.len()
	}
	fn newline_length(&self, offset: usize, code: u32) -> usize {
		if code == 13 && self.code(offset + 1) == 10 {
			2
		} else {
			1
		}
	}
	fn cmp_char(&self, offset: usize, reference: u32) -> bool {
		let mut code = self.raw(offset);
		if is_uppercase(code) {
			code |= 32;
		}
		code == reference
	}
	fn cmp_str(&self, start: usize, end: usize, reference: &[u8]) -> bool {
		if end < start || end - start != reference.len() || end > self.len() {
			return false;
		}
		self.source[start..end]
			.iter()
			.zip(reference)
			.all(|(&byte, &wanted)| byte.to_ascii_lowercase() == wanted)
	}
	fn white_space_end(&self, mut offset: usize) -> usize {
		while offset < self.len() && class(self.source[offset]) & SPACE != 0 {
			offset += 1;
		}
		offset
	}
	fn decimal_end(&self, mut offset: usize) -> usize {
		while offset < self.len() && class(self.source[offset]) & DIGIT != 0 {
			offset += 1;
		}
		offset
	}
	fn consume_escaped(&self, mut offset: usize) -> usize {
		offset += 2;
		if is_hex_digit(self.code(offset - 1)) {
			let max = self.len().min(offset + 5);
			while offset < max && is_hex_digit(self.code(offset)) {
				offset += 1;
			}
			let code = self.code(offset);
			if is_white_space(code) {
				offset += self.newline_length(offset, code);
			}
		}
		offset
	}
	fn consume_name(&self, mut offset: usize) -> usize {
		while offset < self.len() {
			let byte = self.source[offset];
			if class(byte) & NAME != 0 {
				offset += 1;
				continue;
			}
			let code = byte as u32;
			if is_valid_escape(code, self.code(offset + 1)) {
				offset = self.consume_escaped(offset);
				continue;
			}
			break;
		}
		offset
	}
	fn consume_number(&self, mut offset: usize) -> usize {
		let mut code = self.raw(offset);
		if code == 0x2B || code == 0x2D {
			offset += 1;
			code = self.raw(offset);
		}
		if is_digit(code) {
			offset = self.decimal_end(offset + 1);
			code = self.raw(offset);
		}
		if code == 0x2E && is_digit(self.raw(offset + 1)) {
			offset += 2;
			offset = self.decimal_end(offset);
		}
		if self.cmp_char(offset, 101) {
			let mut sign = 0;
			code = self.raw(offset + 1);
			if code == 0x2D || code == 0x2B {
				sign = 1;
				code = self.raw(offset + 2);
			}
			if is_digit(code) {
				offset = self.decimal_end(offset + 1 + sign + 1);
			}
		}
		offset
	}
	/// the loop adds one after an escape, as css-tree's does: the character
	/// after an escape is skipped unseen, and the end can pass the source's
	fn consume_bad_url_remnants(&self, mut offset: usize) -> usize {
		while offset < self.len() {
			let code = self.source[offset] as u32;
			if code == 0x29 {
				offset += 1;
				break;
			}
			if is_valid_escape(code, self.code(offset + 1)) {
				offset = self.consume_escaped(offset);
			}
			offset += 1;
		}
		offset
	}
	fn consume_numeric_token(&mut self) {
		self.offset = self.consume_number(self.offset);
		if is_identifier_start(
			self.code(self.offset),
			self.code(self.offset + 1),
			self.code(self.offset + 2),
		) {
			self.kind = DIMENSION;
			self.offset = self.consume_name(self.offset);
			return;
		}
		if self.code(self.offset) == 0x25 {
			self.kind = PERCENTAGE;
			self.offset += 1;
			return;
		}
		self.kind = NUMBER;
	}
	fn consume_ident_like_token(&mut self) {
		let name_start = self.offset;
		self.offset = self.consume_name(self.offset);
		if self.cmp_str(name_start, self.offset, b"url") && self.code(self.offset) == 0x28 {
			self.offset = self.white_space_end(self.offset + 1);
			if self.code(self.offset) == 0x22 || self.code(self.offset) == 0x27 {
				self.kind = FUNCTION;
				self.offset = name_start + 4;
				return;
			}
			self.consume_url_token();
			return;
		}
		if self.code(self.offset) == 0x28 {
			self.kind = FUNCTION;
			self.offset += 1;
			return;
		}
		self.kind = IDENT;
	}
	fn consume_string_token(&mut self) {
		let ending = self.code(self.offset);
		self.offset += 1;
		self.kind = STRING;
		while self.offset < self.len() {
			let code = self.source[self.offset] as u32;
			if code == ending {
				self.offset += 1;
				return;
			}
			if is_newline(code) {
				self.offset += self.newline_length(self.offset, code);
				self.kind = BAD_STRING;
				return;
			}
			if code == 0x5C && self.offset != self.len() - 1 {
				let next = self.code(self.offset + 1);
				if is_newline(next) {
					self.offset += self.newline_length(self.offset + 1, next);
				} else if is_valid_escape(code, next) {
					self.offset = self.consume_escaped(self.offset) - 1;
				}
			}
			self.offset += 1;
		}
	}
	fn consume_url_token(&mut self) {
		self.kind = URL;
		self.offset = self.white_space_end(self.offset);
		while self.offset < self.len() {
			let code = self.source[self.offset] as u32;
			if code == 0x29 {
				self.offset += 1;
				return;
			}
			if is_white_space(code) {
				self.offset = self.white_space_end(self.offset);
				if self.code(self.offset) == 0x29 || self.offset >= self.len() {
					if self.offset < self.len() {
						self.offset += 1;
					}
					return;
				}
				self.offset = self.consume_bad_url_remnants(self.offset);
				self.kind = BAD_URL;
				return;
			}
			if code == 0x22 || code == 0x27 || code == 0x28 || is_non_printable(code) {
				self.offset = self.consume_bad_url_remnants(self.offset);
				self.kind = BAD_URL;
				return;
			}
			if code == 0x5C {
				if is_valid_escape(code, self.code(self.offset + 1)) {
					self.offset = self.consume_escaped(self.offset) - 1;
				} else {
					self.offset = self.consume_bad_url_remnants(self.offset);
					self.kind = BAD_URL;
					return;
				}
			}
			self.offset += 1;
		}
	}
	/// one token, from `self.offset`
	fn token(&mut self) {
		let offset = self.offset;
		let code = self.source[offset] as u32;
		// charCodeCategory, in its order: whitespace, digit, name start,
		// non-printable, then the character itself
		let bits = class(self.source[offset]);
		if bits & (SPACE | DIGIT | NAME_START) != 0 {
			if bits & SPACE != 0 {
				self.kind = WHITESPACE;
				self.offset = self.white_space_end(offset + 1);
			} else if bits & DIGIT != 0 {
				self.consume_numeric_token();
			} else {
				self.consume_ident_like_token();
			}
			return;
		}
		let (one, two, three) = (
			self.code(offset + 1),
			self.code(offset + 2),
			self.code(offset + 3),
		);
		match code {
			0x22 | 0x27 => self.consume_string_token(),
			0x23 => {
				if is_name(one) || is_valid_escape(one, two) {
					self.kind = HASH;
					self.offset = self.consume_name(offset + 1);
				} else {
					self.delim();
				}
			}
			0x28 => self.single(LEFT_PAREN),
			0x29 => self.single(RIGHT_PAREN),
			0x2B | 0x2E => {
				if is_number_start(code, one, two) {
					self.consume_numeric_token();
				} else {
					self.delim();
				}
			}
			0x2C => self.single(COMMA),
			0x2D => {
				if is_number_start(code, one, two) {
					self.consume_numeric_token();
				} else if one == 0x2D && two == 0x3E {
					self.kind = CDC;
					self.offset = offset + 3;
				} else if is_identifier_start(code, one, two) {
					self.consume_ident_like_token();
				} else {
					self.delim();
				}
			}
			0x2F => {
				if one == 0x2A {
					self.kind = COMMENT;
					self.offset =
						find(self.source, offset + 2, b"*/").map_or(self.len(), |at| at + 2);
				} else {
					self.delim();
				}
			}
			0x3A => self.single(COLON),
			0x3B => self.single(SEMICOLON),
			0x3C => {
				if one == 0x21 && two == 0x2D && three == 0x2D {
					self.kind = CDO;
					self.offset = offset + 4;
				} else {
					self.delim();
				}
			}
			0x40 => {
				if is_identifier_start(one, two, three) {
					self.kind = AT_KEYWORD;
					self.offset = self.consume_name(offset + 1);
				} else {
					self.delim();
				}
			}
			0x5B => self.single(LEFT_SQUARE),
			0x5C => {
				if is_valid_escape(code, one) {
					self.consume_ident_like_token();
				} else {
					self.delim();
				}
			}
			0x5D => self.single(RIGHT_SQUARE),
			0x7B => self.single(LEFT_CURLY),
			0x7D => self.single(RIGHT_CURLY),
			_ => self.delim(),
		}
	}
	fn delim(&mut self) {
		self.single(DELIM);
	}
	fn single(&mut self, kind: u8) {
		self.kind = kind;
		self.offset += 1;
	}
}

/// the first `needle` in `source` at or after `from`
pub(crate) fn find(source: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
	if from > source.len() {
		return None;
	}
	source[from..]
		.windows(needle.len())
		.position(|window| window == needle)
		.map(|at| at + from)
}

/// What a piece must hold for the rewriter to change anything in it: a
/// `url(` (a Url node, or a raw fallback the URL regex rewrites), or an
/// `image-set` or `src(` (whose strings are URLs), ASCII case ignored. The
/// JavaScript side looks into more (its MAY_ROUTE also takes `import` and a
/// backslash), but none of those can lead to an edit without one of these:
/// css-tree compares the raw text of a name, so an escaped `url` is not a
/// url() to it. This is where each of them stands in `source`, start and
/// end, found in one pass: in source order, and no two overlap (none of the
/// three has a `(` before its last byte), so the ends are in order as well.
fn marks(source: &[u8]) -> Vec<(u32, u32)> {
	let mut found = Vec::new();
	for (at, &byte) in source.iter().enumerate() {
		if byte == b'(' {
			if at >= 3 {
				let name = &source[at - 3..at];
				if name.eq_ignore_ascii_case(b"url") || name.eq_ignore_ascii_case(b"src") {
					found.push(((at - 3) as u32, (at + 1) as u32));
				}
			}
		} else if byte == b'-'
			&& at >= 5
			&& at + 4 <= source.len()
			&& source[at - 5..at + 4].eq_ignore_ascii_case(b"image-set")
		{
			found.push(((at - 5) as u32, (at + 4) as u32));
		}
	}
	found
}

/// the kinds of piece, as the answer spells them
pub const VALUE: u8 = b'V';
pub const PRELUDE: u8 = b'P';
pub const SELECTOR: u8 = b'S';
pub const RAW: u8 = b'R';

/// A raw piece of the sheet the rewriter looks into: a declaration's value
/// (VALUE), an at-rule's prelude (PRELUDE, with where the at-rule's name
/// stands), a rule's prelude (SELECTOR), or text no parse shaped and custom
/// property values (RAW, whose url()s the regex routes)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Piece {
	pub kind: u8,
	pub start: usize,
	pub end: usize,
	pub name: (usize, usize),
}

#[derive(Debug, PartialEq, Eq)]
pub enum Fail {
	/// css-tree's SyntaxError: the nearest `parseWithFallback` takes over
	Syntax,
	/// There is no parse of this text: a loop that consumed nothing, which
	/// in css-tree never ends.
	Decline,
}

pub(crate) type Parsed = Result<(), Fail>;

const NONE: u32 = u32::MAX;

/// no function encloses a leaf (`Leaf::function`)
pub(crate) const NO_FUNCTION: (usize, usize) = (usize::MAX, usize::MAX);

/// The leaves of a piece parsed in full that the rewriter routes, as css-tree's
/// walk visits them (source order)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Leaf {
	/// `RAW_LEAF`, `STRING_LEAF`, `URL_TOKEN_LEAF` or `URL_FUNCTION_LEAF`
	pub kind: u8,
	/// the node's `loc`, in bytes of the piece
	pub start: usize,
	pub end: usize,
	/// the token its value is decoded from (a string, a url token)
	pub value: (usize, usize),
	/// the name of the nearest Function or pseudo-class around it, or
	/// `NO_FUNCTION`: the walk's `this.function`
	pub function: (usize, usize),
}

/// text no full parse shaped: its url()s are routed by the regex
pub const RAW_LEAF: u8 = 0;
pub const STRING_LEAF: u8 = 1;
/// `url(a.png)`, one token
pub const URL_TOKEN_LEAF: u8 = 2;
/// `url("a.png")`: a function token, a string and a parenthesis
pub const URL_FUNCTION_LEAF: u8 = 3;

/// the token vectors of a parse, handed to the next (a sheet has thousands of
/// pieces, each tokenized on its own as css-tree does)
#[derive(Default)]
pub(crate) struct Buffers {
	ends: Vec<u32>,
	kinds: Vec<u8>,
	balance: Vec<u32>,
	leaves: Vec<Leaf>,
}

/// css-tree's TokenStream, and the lazy parser on top of it
pub(crate) struct Parser<'a> {
	pub(crate) source: &'a [u8],
	pub(crate) ends: Vec<u32>,
	pub(crate) kinds: Vec<u8>,
	balance: Vec<u32>,
	pub(crate) count: usize,
	first_char_offset: usize,
	pub(crate) eof: bool,
	pub(crate) index: usize,
	pub(crate) kind: u8,
	pub(crate) start: usize,
	pub(crate) end: usize,
	depth: u32,
	pieces: Vec<Piece>,
	/// the full parse (full.rs): what it found, the function it is in, and
	/// how deep its sequences are nested
	pub(crate) leaves: Vec<Leaf>,
	pub(crate) function: (usize, usize),
	pub(crate) nesting: u32,
	/// the lazy parse: `marks` of the source
	marks: Vec<(u32, u32)>,
}

fn is_opener(kind: u8) -> bool {
	matches!(kind, FUNCTION | LEFT_PAREN | LEFT_SQUARE | LEFT_CURLY)
}
fn pair_of(kind: u8) -> u8 {
	match kind {
		FUNCTION | LEFT_PAREN => RIGHT_PAREN,
		LEFT_SQUARE => RIGHT_SQUARE,
		LEFT_CURLY => RIGHT_CURLY,
		_ => 0,
	}
}

pub(crate) fn until_balance_end(_code: u8) -> u8 {
	0
}
fn until_left_curly(code: u8) -> u8 {
	(code == b'{') as u8
}
fn until_left_curly_or_semicolon(code: u8) -> u8 {
	(code == b'{' || code == b';') as u8
}
pub(crate) fn until_exclamation_or_semicolon(code: u8) -> u8 {
	(code == b'!' || code == b';') as u8
}
fn until_semicolon_included(code: u8) -> u8 {
	if code == b';' { 2 } else { 0 }
}

impl<'a> Parser<'a> {
	/// `setSource`: the tokens and the balance table
	fn new(source: &'a [u8]) -> Result<Self, Fail> {
		Self::recycled(source, Buffers::default())
	}
	/// the vectors of this parse, for the next one
	pub(crate) fn buffers(self) -> Buffers {
		Buffers {
			ends: self.ends,
			kinds: self.kinds,
			balance: self.balance,
			leaves: self.leaves,
		}
	}
	/// `new`, in the vectors an earlier parse gave back
	pub(crate) fn recycled(source: &'a [u8], buffers: Buffers) -> Result<Self, Fail> {
		let length = source.len();
		// U+FEFF or U+FFFE first: css-tree starts after it
		let bom =
			source.starts_with(&[0xEF, 0xBB, 0xBF]) || source.starts_with(&[0xEF, 0xBF, 0xBE]);
		let mut tokens = Tokenizer {
			source,
			offset: if bom { 3 } else { 0 },
			kind: 0,
		};
		let first_char_offset = if tokens.offset < length {
			tokens.offset
		} else {
			0
		};
		let Buffers {
			mut ends,
			mut kinds,
			mut balance,
			mut leaves,
		} = buffers;
		ends.clear();
		kinds.clear();
		balance.clear();
		leaves.clear();
		ends.reserve(length / 3 + 16);
		kinds.reserve(length / 3 + 16);
		while tokens.offset < length {
			tokens.token();
			// css-tree ends the remnants of a bad url() one past the text
			// when the text ends in an escape; everything it then reads by
			// that offset (substring, the edit's end) is cut to the text
			ends.push(tokens.offset.min(length) as u32);
			kinds.push(tokens.kind);
		}
		let count = ends.len();
		balance.resize(count + 1, 0);
		// NONE stands for css-tree's `source.length`: nothing is open. The
		// bracket css-tree waits for then is the pair of the token at that
		// index of its buffer, which no parse writes and src/rewriteCSS.ts
		// keeps at zero: none, so a closing bracket with nothing open is a
		// token like any other
		let mut balance_start = NONE;
		let mut close_kind = 0u8;
		for index in 0..count {
			let kind = kinds[index];
			balance[index] = balance_start;
			if kind == close_kind {
				let previous = balance[balance_start as usize];
				balance[balance_start as usize] = index as u32;
				balance_start = previous;
				close_kind = if previous == NONE {
					0
				} else {
					pair_of(kinds[previous as usize])
				};
			} else if is_opener(kind) {
				balance_start = index as u32;
				close_kind = pair_of(kind);
			}
		}
		ends.push(length as u32);
		kinds.push(EOF);
		balance[count] = count as u32;
		for index in 0..count {
			let start = balance[index];
			if start == NONE {
				balance[index] = count as u32;
			} else if start as usize <= index {
				let end = balance[start as usize];
				if end as usize != index {
					balance[index] = end;
				}
			}
		}
		let mut parser = Parser {
			source,
			ends,
			kinds,
			balance,
			count,
			first_char_offset,
			eof: false,
			index: 0,
			kind: 0,
			start: first_char_offset,
			end: first_char_offset,
			depth: 0,
			pieces: Vec::new(),
			leaves,
			function: NO_FUNCTION,
			nesting: 0,
			marks: Vec::new(),
		};
		// reset() and the first next()
		if count > 0 {
			parser.kind = parser.kinds[0];
			parser.end = parser.ends[0] as usize;
		} else {
			parser.eof = true;
			parser.start = length;
			parser.end = length;
		}
		Ok(parser)
	}
	pub(crate) fn next(&mut self) {
		let next = self.index + 1;
		if next < self.count {
			self.index = next;
			self.start = self.end;
			self.kind = self.kinds[next];
			self.end = self.ends[next] as usize;
		} else {
			self.eof = true;
			self.index = self.count;
			self.kind = EOF;
			self.start = self.source.len();
			self.end = self.source.len();
		}
	}
	/// `skip` to the token `next`. `eof` is not cleared on the way back, and
	/// a skip to the first token starts it at 0, not after a BOM: both as
	/// css-tree has them.
	pub(crate) fn skip_to(&mut self, next: usize) {
		if next < self.count {
			self.index = next;
			self.start = if next == 0 {
				0
			} else {
				self.ends[next - 1] as usize
			};
			self.kind = self.kinds[next];
			self.end = self.ends[next] as usize;
		} else {
			self.index = self.count;
			self.next();
		}
	}
	pub(crate) fn lookup_type(&self, offset: usize) -> u8 {
		let at = self.index + offset;
		if at < self.count { self.kinds[at] } else { EOF }
	}
	pub(crate) fn is_delim(&self, code: u8) -> bool {
		self.kind == DELIM && self.source.get(self.start) == Some(&code)
	}
	pub(crate) fn skip_sc(&mut self) {
		while self.kind == WHITESPACE || self.kind == COMMENT {
			self.next();
		}
	}
	pub(crate) fn eat(&mut self, kind: u8) -> Parsed {
		if self.kind != kind {
			// css-tree steps past a lone `#` before it reports the missing
			// name, and the step can reach the end, which is not undone
			if kind == HASH && self.is_delim(b'#') {
				self.next();
			}
			return Err(Fail::Syntax);
		}
		self.next();
		Ok(())
	}
	pub(crate) fn is_balance_edge(&self, token: usize) -> bool {
		(self.balance[self.index] as usize) < token
	}
	fn skip_until_balanced(&mut self, start_token: usize, stop: impl Fn(u8) -> u8) {
		let mut cursor = start_token;
		while cursor < self.count {
			let balance_end = self.balance[cursor] as usize;
			if balance_end < start_token {
				break;
			}
			let offset = if cursor > 0 {
				self.ends[cursor - 1] as usize
			} else {
				self.first_char_offset
			};
			match stop(self.source[offset]) {
				1 => break,
				2 => {
					cursor += 1;
					break;
				}
				_ => {
					if is_opener(self.kinds[cursor]) {
						cursor = balance_end;
					}
				}
			}
			cursor += 1;
		}
		self.skip_to(cursor);
	}
	/// `Raw`: where the raw text stands
	pub(crate) fn raw(
		&mut self,
		stop: impl Fn(u8) -> u8,
		exclude_white_space: bool,
	) -> (usize, usize) {
		let start = self.start;
		self.skip_until_balanced(self.index, stop);
		let end = if exclude_white_space && self.start > start {
			self.offset_exclude_ws()
		} else {
			self.start
		};
		(start, end)
	}
	fn offset_exclude_ws(&self) -> usize {
		if self.index > 0 && self.kinds[self.index - 1] == WHITESPACE {
			return if self.index > 1 {
				self.ends[self.index - 2] as usize
			} else {
				self.first_char_offset
			};
		}
		self.start
	}
	/// `substring()`: a start past its end is swapped with it
	fn span(&self, (start, end): (usize, usize)) -> (usize, usize) {
		let (start, end) = if start <= end {
			(start, end)
		} else {
			(end, start)
		};
		(start.min(self.source.len()), end.min(self.source.len()))
	}
	pub(crate) fn text(&self, range: (usize, usize)) -> &'a [u8] {
		let (start, end) = self.span(range);
		&self.source[start..end]
	}
	/// the marks that stand whole in `range`
	fn marked(&self, range: (usize, usize)) -> impl Iterator<Item = &(u32, u32)> {
		let (start, end) = self.span(range);
		let first = self.marks.partition_point(|mark| (mark.0 as usize) < start);
		self.marks[first..]
			.iter()
			.take_while(move |mark| mark.1 as usize <= end)
	}
	/// whether the rewriter could change anything in the text at `range`
	fn may_route(&self, range: (usize, usize)) -> bool {
		self.marked(range).next().is_some()
	}
	fn piece(&mut self, kind: u8, range: (usize, usize), name: (usize, usize)) {
		self.pieces.push(Piece {
			kind,
			start: range.0,
			end: range.1,
			name,
		});
	}
	/// text no parse shaped: the walk routes its url()s by the regex
	fn raw_piece(&mut self, range: (usize, usize)) {
		// `includes('url(')`: in lower case only
		let source = self.source;
		if self
			.marked(range)
			.any(|mark| &source[mark.0 as usize..mark.1 as usize] == b"url(")
		{
			self.piece(RAW, range, (0, 0));
		}
	}
	/// `parseWithFallback`: what the failed consumer found is forgotten
	fn with_fallback(
		&mut self,
		consumer: impl FnOnce(&mut Self, bool) -> Parsed,
		argument: bool,
		stop: impl Fn(u8) -> u8,
		exclude_white_space: bool,
	) -> Parsed {
		let start_index = self.index;
		let found = self.pieces.len();
		match consumer(self, argument) {
			Ok(()) => Ok(()),
			Err(Fail::Decline) => Err(Fail::Decline),
			Err(Fail::Syntax) => {
				self.pieces.truncate(found);
				self.skip_to(start_index);
				let range = self.raw(stop, exclude_white_space);
				self.raw_piece(range);
				Ok(())
			}
		}
	}
	/// a loop that consumed nothing would never end, and css-tree's would
	/// not either: the host is told there is no parse of this text
	pub(crate) fn advanced(&self, from: usize) -> Parsed {
		if self.index == from && !self.eof {
			return Err(Fail::Decline);
		}
		Ok(())
	}
	fn style_sheet(&mut self) -> Parsed {
		while !self.eof {
			let from = self.index;
			match self.kind {
				// a comment is skipped or kept (`/*!`), and nothing is in it
				WHITESPACE | COMMENT | CDO | CDC => self.next(),
				AT_KEYWORD => self.with_fallback(Self::atrule, false, until_balance_end, false)?,
				_ => self.with_fallback(Self::rule, false, until_balance_end, false)?,
			}
			self.advanced(from)?;
		}
		Ok(())
	}
	fn declaration_list(&mut self) -> Parsed {
		while !self.eof {
			let from = self.index;
			match self.kind {
				WHITESPACE | COMMENT | SEMICOLON => self.next(),
				AT_KEYWORD => {
					self.with_fallback(Self::atrule, true, until_semicolon_included, true)?
				}
				_ => {
					if self.is_delim(b'&') {
						self.with_fallback(Self::rule, false, until_semicolon_included, true)?
					} else {
						self.with_fallback(
							Self::declaration,
							false,
							until_semicolon_included,
							true,
						)?
					}
				}
			}
			self.advanced(from)?;
		}
		Ok(())
	}
	fn is_declaration_block_atrule(&self) -> bool {
		let mut offset = 1;
		loop {
			match self.lookup_type(offset) {
				EOF => return false,
				RIGHT_CURLY => return true,
				LEFT_CURLY | AT_KEYWORD => return false,
				_ => offset += 1,
			}
		}
	}
	fn atrule(&mut self, is_declaration: bool) -> Parsed {
		let start = self.start;
		self.eat(AT_KEYWORD)?;
		let name = (start + 1, self.start);
		self.skip_sc();
		if !self.eof && self.kind != LEFT_CURLY && self.kind != SEMICOLON {
			let prelude = self.raw(until_left_curly_or_semicolon, true);
			if self.text(name) == b"import" || self.may_route(prelude) {
				self.piece(PRELUDE, prelude, name);
			}
			self.skip_sc();
		}
		match self.kind {
			SEMICOLON => self.next(),
			LEFT_CURLY => {
				// the at-rules css-tree has a block parser for, by lower
				// case name (no other character lowers to one of theirs)
				let lower = self.text(name).to_ascii_lowercase();
				let style = match lower.as_slice() {
					b"font-face" | b"nest" | b"page" => true,
					b"layer" => false,
					b"container" | b"media" | b"scope" | b"starting-style" | b"supports" => {
						is_declaration
					}
					_ => self.is_declaration_block_atrule(),
				};
				self.block(style)?;
			}
			_ => {}
		}
		Ok(())
	}
	fn rule(&mut self, _: bool) -> Parsed {
		let prelude = self.raw(until_left_curly, true);
		if self.may_route(prelude) {
			self.piece(SELECTOR, prelude, (0, 0));
		}
		self.block(true)
	}
	fn block(&mut self, is_style_block: bool) -> Parsed {
		if self.depth >= MAX_DEPTH {
			return Err(Fail::Syntax);
		}
		self.depth += 1;
		let parsed = self.block_children(is_style_block);
		self.depth -= 1;
		parsed
	}
	fn block_children(&mut self, is_style_block: bool) -> Parsed {
		self.eat(LEFT_CURLY)?;
		while !self.eof {
			let from = self.index;
			match self.kind {
				RIGHT_CURLY => break,
				WHITESPACE | COMMENT => self.next(),
				AT_KEYWORD => {
					self.with_fallback(Self::atrule, is_style_block, until_balance_end, true)?
				}
				_ => {
					if !is_style_block || self.is_delim(b'&') {
						self.with_fallback(Self::rule, false, until_balance_end, true)?
					} else if self.kind == SEMICOLON {
						let range = self.raw(until_semicolon_included, true);
						self.raw_piece(range);
					} else {
						self.with_fallback(
							Self::declaration,
							false,
							until_semicolon_included,
							true,
						)?;
						if self.kind == SEMICOLON {
							self.next();
						}
					}
				}
			}
			self.advanced(from)?;
		}
		if !self.eof {
			self.eat(RIGHT_CURLY)?;
		}
		Ok(())
	}
	fn declaration(&mut self, _: bool) -> Parsed {
		let start = self.start;
		let start_token = self.index;
		// readProperty, with its hacks
		if self.kind == DELIM {
			match self.source.get(self.start) {
				Some(b'*' | b'$' | b'+' | b'#' | b'&') => self.next(),
				Some(b'/') => {
					self.next();
					if self.is_delim(b'/') {
						self.next();
					}
				}
				_ => {}
			}
		}
		if self.kind == HASH {
			self.eat(HASH)?;
		} else {
			self.eat(IDENT)?;
		}
		let custom = self.text((start, self.start)).starts_with(b"--");
		self.skip_sc();
		self.eat(COLON)?;
		if !custom {
			self.skip_sc();
		}
		let value = self.raw(until_exclamation_or_semicolon, !custom);
		if custom {
			self.raw_piece(value);
		} else if self.may_route(value) {
			self.piece(VALUE, value, (0, 0));
		}
		if self.is_delim(b'!') {
			self.eat(DELIM)?;
			self.skip_sc();
			self.eat(IDENT)?;
			self.skip_sc();
		}
		if !self.eof && self.kind != SEMICOLON && !self.is_balance_edge(start_token) {
			return Err(Fail::Syntax);
		}
		Ok(())
	}
}

/// The pieces of a stylesheet (`declaration_list` false) or of a
/// declaration list (an element's `style`), in source order, offsets in
/// bytes
pub fn scan(source: &[u8], declaration_list: bool) -> Result<Vec<Piece>, Fail> {
	let mut parser = Parser::new(source)?;
	parser.marks = marks(source);
	if declaration_list {
		parser.declaration_list()?;
	} else {
		parser.style_sheet()?;
	}
	Ok(parser.pieces)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn pieces(source: &str, list: bool) -> Vec<(char, &str)> {
		scan(source.as_bytes(), list)
			.unwrap()
			.into_iter()
			.map(|piece| (piece.kind as char, &source[piece.start..piece.end]))
			.collect()
	}

	#[test]
	fn values_preludes_and_raws() {
		assert_eq!(
			pieces(
				"@import 'a.css';\na { color: red; background: url(a.png) no-repeat !important; --x: url(b) }\n@media print { b[href*=\"url(\"] { src: local(x) } }",
				false
			),
			vec![
				('P', "'a.css'"),
				('V', "url(a.png) no-repeat"),
				('R', " url(b) "),
				('S', "b[href*=\"url(\"]"),
			]
		);
	}

	#[test]
	fn a_failed_declaration_is_raw() {
		assert_eq!(
			pieces("a { url(x); color: red }", false),
			vec![('R', "url(x);")]
		);
		assert_eq!(
			pieces("background: url(a); url(b)", true),
			vec![('V', "url(a)"), ('R', "url(b)")]
		);
	}

	#[test]
	fn a_stray_closer_at_the_top_is_a_token_like_any_other() {
		// it joins the prelude of the rule after it, as in css-tree
		assert_eq!(
			pieces("a{b:url(c)} } d{e:url(f)}", false),
			vec![('V', "url(c)"), ('V', "url(f)")]
		);
		assert_eq!(
			pieces(") a[b=url(] { c: url(d) }", false),
			vec![('R', ") a[b=url(] { c: url(d) }")]
		);
	}

	#[test]
	fn nesting_past_the_depth_this_port_recurses_to_is_raw() {
		// the at-rule whose block would be one too deep is raw text
		let deep = "@media x{".repeat(MAX_DEPTH as usize + 3) + "a{b:url(c)}";
		let found = pieces(&deep, false);
		assert_eq!(found.len(), 1);
		assert_eq!(found[0], ('R', "@media x{@media x{@media x{a{b:url(c)}"));
	}

	#[test]
	fn tokens_end_where_css_tree_ends_them() {
		// an unquoted url with a space inside is a bad url, to its `)`
		assert_eq!(
			pieces("a { b: url(x y) z; c: url( 'q' ) }", false),
			vec![('V', "url(x y) z"), ('V', "url( 'q' )")]
		);
		// a comment hides a brace; a string hides a semicolon
		assert_eq!(
			pieces("a { /* } */ b: 'x;y' url(z); }", false),
			vec![('V', "'x;y' url(z)")]
		);
	}
}
