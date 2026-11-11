//! The full parse of a raw piece: what `deep` in `src/rewriteCSS.ts` has
//! css-tree do with a declaration's value, an at-rule's prelude or a rule's
//! prelude once the lazy parse (css.rs) found it could hold a URL.
//!
//! The rewriter walks the tree of that parse and routes three kinds of node:
//! a `Url`, a `String` (inside `image-set()` or `src()`, or in an `@import`
//! prelude) and a `Raw` (text the full parse could not shape, whose url()s a
//! regex routes). So this builds no tree: it runs css-tree 3.2.1's node
//! parsers (`lib/syntax/node/*.js`, `atrule/*.js`, `pseudo/*.js`,
//! `scope/*.js`, `function/*.js`) for what they consume and where they
//! fail, and records those three kinds of leaf as they are made, each with
//! the function it stands in (the walk's `this.function`). The walk visits
//! a node's fields in source order for every node type there is, so the
//! order leaves are made in is the order the walk routes them in; a leaf
//! made inside an attempt that failed (`parseWithFallback`) is forgotten
//! with it.
//!
//! It is a port, quirk for quirk, with the JavaScript names kept: `eof` that
//! stays set after a step back, a comparison read without consuming its
//! `=`, `Object` found as the parser of a feature named `constructor`.
//! Where a piece is past what the port covers it declines the sheet
//! (`Fail::Decline`), never guesses.

use crate::css::*;

/// sequences (brackets, functions, conditions) nested deeper than this are
/// left to the JavaScript rewriter, which has a stack of its own to run out of
const MAX_NESTING: u32 = 96;

/// the parse context `deep` asks for
#[derive(Clone, Copy)]
pub enum Context<'n> {
	Value,
	SelectorList,
	/// with the at-rule's name as the sheet wrote it
	AtrulePrelude(&'n [u8]),
}

/// `scope/{value,atrulePrelude,selector}.js`: which nodes a sequence is of
#[derive(Clone, Copy, PartialEq, Eq)]
enum Scope {
	Value,
	AtrulePrelude,
	Selector,
}

/// the `kind` of a Condition
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
	Media,
	Container,
	Supports,
}

/// `cmpChar`: the character at `offset`, an ASCII capital lowered, is
/// `reference`
fn cmp_char(source: &[u8], offset: usize, reference: u8) -> bool {
	source
		.get(offset)
		.is_some_and(|&byte| byte.to_ascii_lowercase() == reference)
}

/// `cmpStr`: `source[start..end]` is `reference` (lower case), ASCII
/// capitals lowered
fn cmp_str(source: &[u8], start: usize, end: usize, reference: &[u8]) -> bool {
	end >= start
		&& end - start == reference.len()
		&& end <= source.len()
		&& source[start..end]
			.iter()
			.zip(reference)
			.all(|(&byte, &wanted)| byte.to_ascii_lowercase() == wanted)
}

/// `text.toLowerCase() === reference`, for a lower case ASCII `reference`:
/// ASCII capitals lower to their letters, and the one other character that
/// lowers to an ASCII letter is the Kelvin sign (U+212A, to `k`)
pub(crate) fn lower_is(text: &[u8], reference: &[u8]) -> bool {
	let mut at = 0;
	for &wanted in reference {
		if wanted == b'k' && text[at.min(text.len())..].starts_with(&[0xE2, 0x84, 0xAA]) {
			at += 3;
		} else if text.get(at).is_some_and(|&byte| byte.to_ascii_lowercase() == wanted) {
			at += 1;
		} else {
			return false;
		}
	}
	at == text.len()
}

impl<'a> Parser<'a> {
	/// `parse(text, { context })`: the context's node, then the end of input
	pub(crate) fn parse_context(&mut self, context: Context) -> Parsed {
		match context {
			Context::Value => {
				self.read_sequence(Scope::Value)?;
			}
			Context::SelectorList => self.selector_list()?,
			Context::AtrulePrelude(name) => self.atrule_prelude(name)?,
		}
		if !self.eof {
			return Err(Fail::Syntax);
		}
		Ok(())
	}

	// TokenStream

	/// the parser's `charCodeAt`: 0 past the end
	fn char_code_at(&self, offset: usize) -> u8 {
		self.source.get(offset).copied().unwrap_or(0)
	}
	fn token_is(&self, reference: &[u8]) -> bool {
		cmp_str(self.source, self.start, self.end, reference)
	}
	fn lookup_type_non_sc(&self, mut idx: usize) -> u8 {
		for offset in self.index..self.count {
			let kind = self.kinds[offset];
			if kind != WHITESPACE && kind != COMMENT {
				if idx == 0 {
					return kind;
				}
				idx -= 1;
			}
		}
		EOF
	}
	fn lookup_offset_non_sc(&self, mut idx: usize) -> usize {
		for offset in self.index..self.count {
			let kind = self.kinds[offset];
			if kind != WHITESPACE && kind != COMMENT {
				if idx == 0 {
					return offset - self.index;
				}
				idx -= 1;
			}
		}
		0
	}
	fn lookup_non_ws_type(&self, mut offset: usize) -> u8 {
		loop {
			let kind = self.lookup_type(offset);
			offset += 1;
			if kind != WHITESPACE && kind != COMMENT {
				return kind;
			}
		}
	}
	/// where the token `offset` ahead starts; the first token's start reads
	/// as 0 whatever stands before it, as css-tree's does
	fn lookup_offset(&self, offset: usize) -> usize {
		let at = self.index + offset;
		if at < self.count {
			if at == 0 { 0 } else { self.ends[at - 1] as usize }
		} else {
			self.source.len()
		}
	}
	fn lookup_value(&self, offset: usize, reference: &[u8]) -> bool {
		let at = self.index + offset;
		at < self.count
			&& cmp_str(
				self.source,
				if at == 0 { 0 } else { self.ends[at - 1] as usize },
				self.ends[at] as usize,
				reference,
			)
	}
	fn is_delim_at(&self, code: u8, offset: usize) -> bool {
		if offset == 0 {
			return self.is_delim(code);
		}
		self.lookup_type(offset) == DELIM && self.source.get(self.lookup_offset(offset)) == Some(&code)
	}
	fn skip(&mut self, count: usize) {
		self.skip_to(self.index + count);
	}
	fn eat_ident(&mut self, name: &[u8]) -> Parsed {
		if self.kind != IDENT || !self.lookup_value(0, name) {
			return Err(Fail::Syntax);
		}
		self.next();
		Ok(())
	}
	fn eat_delim(&mut self, code: u8) -> Parsed {
		if !self.is_delim(code) {
			return Err(Fail::Syntax);
		}
		self.next();
		Ok(())
	}
	/// where the function's name stands
	fn consume_function_name(&mut self) -> Result<(usize, usize), Fail> {
		let name = (self.start, self.end.saturating_sub(1).max(self.start));
		self.eat(FUNCTION)?;
		Ok(name)
	}

	/// `parseWithFallback`'s first half: what `consumer` answers, or None
	/// with the parser back where it started (but for `eof`) and the leaves
	/// of the attempt forgotten
	fn attempt<T>(
		&mut self,
		consumer: impl FnOnce(&mut Self) -> Result<T, Fail>,
	) -> Result<Option<T>, Fail> {
		let start_index = self.index;
		let found = self.leaves.len();
		let function = self.function;
		match consumer(self) {
			Ok(value) => Ok(Some(value)),
			Err(Fail::Decline) => Err(Fail::Decline),
			Err(Fail::Syntax) => {
				self.leaves.truncate(found);
				self.function = function;
				self.skip_to(start_index);
				Ok(None)
			}
		}
	}

	// leaves

	/// a `Raw` node; the walk routes it only when it holds a `url(`
	fn raw_leaf(&mut self, stop: impl Fn(u8) -> u8, exclude_white_space: bool) {
		let range = self.raw(stop, exclude_white_space);
		if find(self.text(range), 0, b"url(").is_some() {
			self.leaves.push(Leaf {
				kind: RAW_LEAF,
				start: range.0,
				end: range.1,
				value: range,
				function: self.function,
			});
		}
	}
	fn string(&mut self) -> Parsed {
		let leaf = Leaf {
			kind: STRING_LEAF,
			start: self.start,
			end: self.end,
			value: (self.start, self.end),
			function: self.function,
		};
		self.eat(STRING)?;
		self.leaves.push(leaf);
		Ok(())
	}
	fn url(&mut self) -> Parsed {
		let start = self.start;
		let value = match self.kind {
			URL => {
				let value = (self.start, self.end);
				self.eat(URL)?;
				value
			}
			FUNCTION => {
				if !self.token_is(b"url(") {
					return Err(Fail::Syntax);
				}
				self.eat(FUNCTION)?;
				self.skip_sc();
				let value = (self.start, self.end);
				self.eat(STRING)?;
				self.skip_sc();
				if !self.eof {
					self.eat(RIGHT_PAREN)?;
				}
				value
			}
			_ => return Err(Fail::Syntax),
		};
		self.leaves.push(Leaf {
			kind: if value.0 == start { URL_TOKEN_LEAF } else { URL_FUNCTION_LEAF },
			start,
			end: self.start,
			value,
			function: self.function,
		});
		Ok(())
	}

	// sequences

	/// `readSequence`: how many children it read
	fn read_sequence(&mut self, scope: Scope) -> Result<usize, Fail> {
		if self.nesting >= MAX_NESTING {
			return Err(Fail::Decline);
		}
		self.nesting += 1;
		let read = self.sequence(scope);
		self.nesting -= 1;
		read
	}
	fn sequence(&mut self, scope: Scope) -> Result<usize, Fail> {
		let mut count = 0;
		while !self.eof {
			if self.kind == COMMENT || self.kind == WHITESPACE {
				self.next();
				continue;
			}
			let from = self.index;
			let found = if scope == Scope::Selector {
				self.selector_node()?
			} else {
				self.default_node(scope)?
			};
			if !found {
				break;
			}
			count += 1;
			self.advanced(from)?;
		}
		Ok(count)
	}
	/// `scope/default.js`: false for `undefined`, which ends the sequence
	fn default_node(&mut self, scope: Scope) -> Result<bool, Fail> {
		match self.kind {
			HASH => self.eat(HASH)?,
			COMMA => self.next(),
			LEFT_PAREN => self.bracketed(scope, LEFT_PAREN, RIGHT_PAREN)?,
			LEFT_SQUARE => self.bracketed(scope, LEFT_SQUARE, RIGHT_SQUARE)?,
			STRING => self.string()?,
			DIMENSION => self.eat(DIMENSION)?,
			PERCENTAGE => self.eat(PERCENTAGE)?,
			NUMBER => self.eat(NUMBER)?,
			FUNCTION => {
				if self.token_is(b"url(") {
					self.url()?
				} else {
					self.function_node(scope)?
				}
			}
			URL => self.url()?,
			IDENT => {
				if cmp_char(self.source, self.start, b'u') && cmp_char(self.source, self.start + 1, b'+')
				{
					self.unicode_range()?
				} else {
					self.eat(IDENT)?
				}
			}
			DELIM => match self.char_code_at(self.start) {
				b'/' | b'*' | b'+' | b'-' => self.next(),
				b'#' => return Err(Fail::Syntax),
				_ => return Ok(false),
			},
			_ => return Ok(false),
		}
		Ok(true)
	}
	/// `Parentheses` and `Brackets`
	fn bracketed(&mut self, scope: Scope, open: u8, close: u8) -> Parsed {
		self.eat(open)?;
		self.read_sequence(scope)?;
		if !self.eof {
			self.eat(close)?;
		}
		Ok(())
	}
	/// `Function`, with the scope's own parsers for `expression()` and
	/// `var()` in a value
	fn function_node(&mut self, scope: Scope) -> Parsed {
		let name = self.consume_function_name()?;
		let outer = self.function;
		self.function = name;
		let children = self.function_children(scope, name);
		self.function = outer;
		children?;
		if !self.eof {
			self.eat(RIGHT_PAREN)?;
		}
		Ok(())
	}
	fn function_children(&mut self, scope: Scope, name: (usize, usize)) -> Parsed {
		if scope == Scope::Value {
			let text = self.text(name);
			if lower_is(text, b"expression") {
				self.raw_leaf(until_balance_end, false);
				return Ok(());
			}
			if lower_is(text, b"var") {
				// function/var.js, custom properties left raw
				self.skip_sc();
				self.eat(IDENT)?;
				self.skip_sc();
				if self.kind == COMMA {
					self.next();
					self.raw_leaf(until_exclamation_or_semicolon, false);
				}
				return Ok(());
			}
		}
		self.read_sequence(scope)?;
		Ok(())
	}

	// UnicodeRange

	/// `eatHexSequence`: the digits it ate, or -1 after a dash
	fn eat_hex_sequence(&mut self, offset: usize, allow_dash: bool) -> Result<i32, Fail> {
		let mut len = 0;
		let mut pos = self.start + offset;
		while pos < self.end {
			let code = self.char_code_at(pos);
			if code == b'-' && allow_dash && len != 0 {
				self.eat_hex_sequence(offset + len as usize + 1, false)?;
				return Ok(-1);
			}
			if !is_hex_digit(code as u32) {
				return Err(Fail::Syntax);
			}
			len += 1;
			if len > 6 {
				return Err(Fail::Syntax);
			}
			pos += 1;
		}
		self.next();
		Ok(len)
	}
	fn eat_question_marks(&mut self, max: i32) -> Parsed {
		let mut count = 0;
		while self.is_delim(b'?') {
			count += 1;
			if count > max {
				return Err(Fail::Syntax);
			}
			self.next();
		}
		Ok(())
	}
	fn unicode_range(&mut self) -> Parsed {
		self.eat_ident(b"u")?;
		match self.kind {
			NUMBER => {
				let hex = self.eat_hex_sequence(1, true)?;
				if self.is_delim(b'?') {
					self.eat_question_marks(6 - hex)?;
				} else if self.kind == DIMENSION || self.kind == NUMBER {
					if self.char_code_at(self.start) != b'-' {
						return Err(Fail::Syntax);
					}
					self.eat_hex_sequence(1, false)?;
				}
			}
			DIMENSION => {
				let hex = self.eat_hex_sequence(1, true)?;
				if hex > 0 {
					self.eat_question_marks(6 - hex)?;
				}
			}
			_ => {
				self.eat_delim(b'+')?;
				if self.kind == IDENT {
					let hex = self.eat_hex_sequence(0, true)?;
					if hex > 0 {
						self.eat_question_marks(6 - hex)?;
					}
				} else if self.is_delim(b'?') {
					self.next();
					self.eat_question_marks(5)?;
				} else {
					return Err(Fail::Syntax);
				}
			}
		}
		Ok(())
	}

	// at-rule preludes

	/// `AtrulePrelude`, with the prelude parser of the at-rule `name`
	fn atrule_prelude(&mut self, name: &[u8]) -> Parsed {
		self.skip_sc();
		if lower_is(name, b"container") {
			if self.kind == IDENT {
				let ident = self.text((self.start, self.end));
				if !(lower_is(ident, b"none")
					|| lower_is(ident, b"and")
					|| lower_is(ident, b"not")
					|| lower_is(ident, b"or"))
				{
					self.eat(IDENT)?;
				}
			}
			self.condition(Kind::Container)?;
		} else if lower_is(name, b"import") {
			self.import_prelude()?;
		} else if lower_is(name, b"layer") {
			self.layer_list()?;
		} else if lower_is(name, b"media") {
			self.media_query_list()?;
		} else if lower_is(name, b"nest") || lower_is(name, b"page") {
			self.selector_list()?;
		} else if lower_is(name, b"scope") {
			self.scope_node()?;
		} else if lower_is(name, b"supports") {
			self.condition(Kind::Supports)?;
		} else {
			self.read_sequence(Scope::AtrulePrelude)?;
		}
		self.skip_sc();
		if !self.eof && self.kind != LEFT_CURLY && self.kind != SEMICOLON {
			return Err(Fail::Syntax);
		}
		Ok(())
	}
	/// `atrule/import.js`
	fn import_prelude(&mut self) -> Parsed {
		match self.kind {
			STRING => self.string()?,
			URL | FUNCTION => self.url()?,
			_ => return Err(Fail::Syntax),
		}
		self.skip_sc();
		if self.kind == IDENT && self.token_is(b"layer") {
			self.eat(IDENT)?;
		} else if self.kind == FUNCTION && self.token_is(b"layer(") {
			self.import_function(false)?;
		}
		self.skip_sc();
		if self.kind == FUNCTION && self.token_is(b"supports(") {
			self.import_function(true)?;
		}
		if matches!(self.lookup_non_ws_type(0), IDENT | LEFT_PAREN) {
			self.media_query_list()?;
		}
		Ok(())
	}
	/// `layer(...)` and `supports(...)` of an @import
	fn import_function(&mut self, supports: bool) -> Parsed {
		let name = self.consume_function_name()?;
		let outer = self.function;
		self.function = name;
		let children = self.import_function_children(supports);
		self.function = outer;
		children?;
		if !self.eof {
			self.eat(RIGHT_PAREN)?;
		}
		Ok(())
	}
	fn import_function_children(&mut self, supports: bool) -> Parsed {
		self.skip_sc();
		if supports {
			if self
				.attempt(|parser| parser.to_parenthesis(Self::full_declaration))?
				.is_some()
			{
				return Ok(());
			}
			if self
				.attempt(|parser| parser.to_parenthesis(|inner| inner.condition(Kind::Supports)))?
				.is_some()
			{
				return Ok(());
			}
		} else if self
			.attempt(|parser| parser.to_parenthesis(Self::layer))?
			.is_some()
		{
			return Ok(());
		}
		self.raw_leaf(until_balance_end, true);
		Ok(())
	}
	/// import.js's `try { parse } finally { the closing parenthesis is next }`
	fn to_parenthesis(&mut self, parse: impl FnOnce(&mut Self) -> Parsed) -> Parsed {
		let parsed = parse(self);
		if parsed == Err(Fail::Decline) {
			return parsed;
		}
		self.skip_sc();
		if self.lookup_non_ws_type(0) != RIGHT_PAREN {
			return Err(Fail::Syntax);
		}
		parsed
	}
	fn layer(&mut self) -> Parsed {
		self.eat(IDENT)?;
		while self.is_delim(b'.') {
			self.eat(DELIM)?;
			self.eat(IDENT)?;
		}
		Ok(())
	}
	fn layer_list(&mut self) -> Parsed {
		self.skip_sc();
		while !self.eof {
			self.layer()?;
			if self.lookup_type_non_sc(0) != COMMA {
				break;
			}
			self.skip_sc();
			self.next();
			self.skip_sc();
		}
		Ok(())
	}
	fn media_query_list(&mut self) -> Parsed {
		self.skip_sc();
		while !self.eof {
			self.media_query()?;
			if self.kind != COMMA {
				break;
			}
			self.next();
		}
		Ok(())
	}
	fn media_query(&mut self) -> Parsed {
		self.skip_sc();
		if self.kind == IDENT && self.lookup_type_non_sc(1) != LEFT_PAREN {
			let ident = self.text((self.start, self.end));
			self.eat(IDENT)?;
			if lower_is(ident, b"not") || lower_is(ident, b"only") {
				self.skip_sc();
				self.eat(IDENT)?;
			}
			match self.lookup_type_non_sc(0) {
				IDENT => {
					self.skip_sc();
					self.eat_ident(b"and")?;
					self.condition(Kind::Media)?;
				}
				LEFT_CURLY | SEMICOLON | COMMA | EOF => {}
				_ => return Err(Fail::Syntax),
			}
		} else {
			match self.kind {
				IDENT | LEFT_PAREN | FUNCTION => self.condition(Kind::Media)?,
				LEFT_CURLY | SEMICOLON | EOF => {}
				_ => return Err(Fail::Syntax),
			}
		}
		Ok(())
	}
	fn scope_node(&mut self) -> Parsed {
		self.skip_sc();
		if self.kind == LEFT_PAREN {
			self.next();
			self.scope_selectors()?;
		}
		if self.lookup_non_ws_type(0) == IDENT {
			self.skip_sc();
			self.eat_ident(b"to")?;
			self.skip_sc();
			self.eat(LEFT_PAREN)?;
			self.scope_selectors()?;
		}
		Ok(())
	}
	fn scope_selectors(&mut self) -> Parsed {
		self.skip_sc();
		if self.attempt(Self::selector_list)?.is_none() {
			self.raw_leaf(until_balance_end, true);
		}
		self.skip_sc();
		self.eat(RIGHT_PAREN)
	}

	// conditions

	fn condition(&mut self, kind: Kind) -> Parsed {
		if self.nesting >= MAX_NESTING {
			return Err(Fail::Decline);
		}
		self.nesting += 1;
		let parsed = self.condition_terms(kind);
		self.nesting -= 1;
		parsed
	}
	fn condition_terms(&mut self, kind: Kind) -> Parsed {
		let mut count = 0;
		while !self.eof {
			match self.kind {
				COMMENT | WHITESPACE => {
					self.next();
					continue;
				}
				IDENT => self.eat(IDENT)?,
				LEFT_PAREN => {
					let term = self.attempt(|parser| {
						if kind == Kind::Supports {
							parser.supports_declaration()
						} else if parser.lookup_type_non_sc(1) == IDENT
							&& matches!(parser.lookup_type_non_sc(2), COLON | RIGHT_PAREN | EOF)
						{
							parser.feature()
						} else {
							parser.feature_range()
						}
					})?;
					if term.is_none() {
						let nested = self.attempt(|parser| {
							parser.eat(LEFT_PAREN)?;
							parser.condition(kind)?;
							parser.eat(RIGHT_PAREN)
						})?;
						if nested.is_none() {
							self.general_enclosed()?;
						}
					}
				}
				FUNCTION => {
					if self
						.attempt(|parser| parser.feature_function(kind))?
						.is_none()
					{
						self.general_enclosed()?;
					}
				}
				_ => break,
			}
			count += 1;
		}
		if count == 0 {
			return Err(Fail::Syntax);
		}
		Ok(())
	}
	fn feature(&mut self) -> Parsed {
		self.eat(LEFT_PAREN)?;
		self.skip_sc();
		self.eat(IDENT)?;
		self.skip_sc();
		if self.kind != RIGHT_PAREN {
			self.eat(COLON)?;
			self.skip_sc();
			match self.kind {
				NUMBER => {
					if self.lookup_non_ws_type(1) == DELIM {
						self.ratio()?
					} else {
						self.eat(NUMBER)?
					}
				}
				DIMENSION => self.eat(DIMENSION)?,
				IDENT => self.eat(IDENT)?,
				FUNCTION => self.function_or_ratio()?,
				_ => return Err(Fail::Syntax),
			}
			self.skip_sc();
		}
		if !self.eof {
			self.eat(RIGHT_PAREN)?;
		}
		Ok(())
	}
	/// a function as a feature's value, unless a `/` follows: then a Ratio
	fn function_or_ratio(&mut self) -> Parsed {
		let function = self.attempt(|parser| {
			parser.function_node(Scope::Value)?;
			parser.skip_sc();
			if parser.is_delim(b'/') {
				return Err(Fail::Syntax);
			}
			Ok(())
		})?;
		if function.is_none() {
			self.ratio()?;
		}
		Ok(())
	}
	fn ratio(&mut self) -> Parsed {
		self.ratio_term()?;
		self.skip_sc();
		if self.is_delim(b'/') {
			self.eat_delim(b'/')?;
			self.ratio_term()?;
		}
		Ok(())
	}
	fn ratio_term(&mut self) -> Parsed {
		self.skip_sc();
		match self.kind {
			NUMBER => self.eat(NUMBER),
			FUNCTION => self.function_node(Scope::Value),
			_ => Err(Fail::Syntax),
		}
	}
	fn feature_range(&mut self) -> Parsed {
		self.skip_sc();
		self.eat(LEFT_PAREN)?;
		self.range_term()?;
		self.range_comparison()?;
		self.range_term()?;
		if self.lookup_non_ws_type(0) != RIGHT_PAREN {
			self.range_comparison()?;
			self.range_term()?;
		}
		self.skip_sc();
		self.eat(RIGHT_PAREN)
	}
	fn range_term(&mut self) -> Parsed {
		self.skip_sc();
		match self.kind {
			NUMBER => {
				if self.is_delim_at(b'/', self.lookup_offset_non_sc(1)) {
					self.ratio()
				} else {
					self.eat(NUMBER)
				}
			}
			DIMENSION => self.eat(DIMENSION),
			IDENT => self.eat(IDENT),
			FUNCTION => self.function_or_ratio(),
			_ => Err(Fail::Syntax),
		}
	}
	/// a lone `=` is read and not consumed, as in css-tree: the term after it
	/// then fails
	fn range_comparison(&mut self) -> Parsed {
		self.skip_sc();
		if self.is_delim(b'<') || self.is_delim(b'>') {
			self.next();
			if self.is_delim(b'=') {
				self.next();
			}
			return Ok(());
		}
		if self.is_delim(b'=') {
			return Ok(());
		}
		Err(Fail::Syntax)
	}
	fn supports_declaration(&mut self) -> Parsed {
		self.eat(LEFT_PAREN)?;
		self.skip_sc();
		self.full_declaration()?;
		if !self.eof {
			self.eat(RIGHT_PAREN)?;
		}
		Ok(())
	}
	/// `Declaration`, its value parsed in full (a custom property's stays
	/// raw)
	fn full_declaration(&mut self) -> Parsed {
		let start = self.start;
		let start_token = self.index;
		if self.kind == DELIM {
			match self.char_code_at(self.start) {
				b'*' | b'$' | b'+' | b'#' | b'&' => self.next(),
				b'/' => {
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
		if custom {
			self.raw_leaf(until_exclamation_or_semicolon, false);
		} else {
			self.skip_sc();
			let value = self.attempt(|parser| {
				let start_value = parser.index;
				parser.read_sequence(Scope::Value)?;
				if !parser.eof
					&& parser.kind != SEMICOLON
					&& !parser.is_delim(b'!')
					&& !parser.is_balance_edge(start_value)
				{
					return Err(Fail::Syntax);
				}
				Ok(())
			})?;
			if value.is_none() {
				self.raw_leaf(until_exclamation_or_semicolon, true);
			}
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
	fn feature_function(&mut self, kind: Kind) -> Parsed {
		#[derive(Clone, Copy)]
		enum Value {
			Selector,
			Declaration,
			Nothing,
		}
		let name = self.consume_function_name()?;
		let text = self.text(name);
		let value = if kind == Kind::Supports && lower_is(text, b"selector") {
			Value::Selector
		} else if kind == Kind::Container && lower_is(text, b"style") {
			Value::Declaration
		} else if lower_is(text, b"constructor") {
			// css-tree looks the feature up on a plain object, finds
			// `Object` there, and calls it: a value that consumes nothing
			Value::Nothing
		} else {
			return Err(Fail::Syntax);
		};
		self.skip_sc();
		let parsed = self.attempt(|parser| {
			let start_value = parser.index;
			match value {
				Value::Selector => parser.selector()?,
				Value::Declaration => parser.full_declaration()?,
				Value::Nothing => {}
			}
			if !parser.eof && !parser.is_balance_edge(start_value) {
				return Err(Fail::Syntax);
			}
			Ok(())
		})?;
		if parsed.is_none() {
			self.raw_leaf(until_balance_end, false);
		}
		if !self.eof {
			self.eat(RIGHT_PAREN)?;
		}
		Ok(())
	}
	fn general_enclosed(&mut self) -> Parsed {
		if self.kind == FUNCTION {
			self.consume_function_name()?;
		} else {
			self.eat(LEFT_PAREN)?;
		}
		let children = self.attempt(|parser| {
			let start_value = parser.index;
			parser.read_sequence(Scope::Value)?;
			if !parser.eof && !parser.is_balance_edge(start_value) {
				return Err(Fail::Syntax);
			}
			Ok(())
		})?;
		if children.is_none() {
			self.raw_leaf(until_balance_end, false);
		}
		if !self.eof {
			self.eat(RIGHT_PAREN)?;
		}
		Ok(())
	}

	// selectors

	fn selector_list(&mut self) -> Parsed {
		while !self.eof {
			self.selector()?;
			if self.kind == COMMA {
				self.next();
				continue;
			}
			break;
		}
		Ok(())
	}
	fn selector(&mut self) -> Parsed {
		if self.read_sequence(Scope::Selector)? == 0 {
			return Err(Fail::Syntax);
		}
		Ok(())
	}
	/// `scope/selector.js`
	fn selector_node(&mut self) -> Result<bool, Fail> {
		match self.kind {
			LEFT_SQUARE => self.attribute_selector()?,
			HASH => self.eat(HASH)?,
			COLON => {
				let element = self.lookup_type(1) == COLON;
				self.pseudo(element)?
			}
			IDENT => self.type_selector()?,
			NUMBER | PERCENTAGE => self.eat(PERCENTAGE)?,
			DIMENSION => {
				if self.char_code_at(self.start) == b'.' {
					return Err(Fail::Syntax);
				}
				return Ok(false);
			}
			DELIM => match self.char_code_at(self.start) {
				b'>' | b'+' | b'~' => self.next(),
				b'/' => {
					self.next();
					self.eat_ident(b"deep")?;
					self.eat_delim(b'/')?;
				}
				b'.' => {
					self.eat_delim(b'.')?;
					self.eat(IDENT)?;
				}
				b'*' | b'|' => self.type_selector()?,
				b'#' => self.eat(HASH)?,
				b'&' => self.eat_delim(b'&')?,
				_ => return Ok(false),
			},
			_ => return Ok(false),
		}
		Ok(true)
	}
	fn identifier_or_asterisk(&mut self) -> Parsed {
		if self.kind != IDENT && !self.is_delim(b'*') {
			return Err(Fail::Syntax);
		}
		self.next();
		Ok(())
	}
	fn type_selector(&mut self) -> Parsed {
		if self.is_delim(b'|') {
			self.next();
			self.identifier_or_asterisk()
		} else {
			self.identifier_or_asterisk()?;
			if self.is_delim(b'|') {
				self.next();
				self.identifier_or_asterisk()?;
			}
			Ok(())
		}
	}
	fn attribute_selector(&mut self) -> Parsed {
		self.eat(LEFT_SQUARE)?;
		self.skip_sc();
		// getAttributeName
		if self.eof {
			return Err(Fail::Syntax);
		}
		let mut expect_ident = false;
		if self.is_delim(b'*') {
			expect_ident = true;
			self.next();
		} else if !self.is_delim(b'|') {
			self.eat(IDENT)?;
		}
		if self.is_delim(b'|') {
			if self.char_code_at(self.start + 1) != b'=' {
				self.next();
				self.eat(IDENT)?;
			} else if expect_ident {
				return Err(Fail::Syntax);
			}
		} else if expect_ident {
			return Err(Fail::Syntax);
		}
		self.skip_sc();
		if self.kind != RIGHT_SQUARE {
			if self.kind != IDENT {
				// getOperator
				let code = self.char_code_at(self.start);
				if !matches!(code, b'=' | b'~' | b'^' | b'$' | b'*' | b'|') {
					return Err(Fail::Syntax);
				}
				self.next();
				if code != b'=' {
					if !self.is_delim(b'=') {
						return Err(Fail::Syntax);
					}
					self.next();
				}
				self.skip_sc();
				if self.kind == STRING {
					self.string()?;
				} else {
					self.eat(IDENT)?;
				}
				self.skip_sc();
			}
			if self.kind == IDENT {
				self.eat(IDENT)?;
				self.skip_sc();
			}
		}
		self.eat(RIGHT_SQUARE)
	}
	/// `PseudoClassSelector` and `PseudoElementSelector`: a function to the
	/// walk, like `Function`
	fn pseudo(&mut self, element: bool) -> Parsed {
		self.eat(COLON)?;
		if element {
			self.eat(COLON)?;
		}
		if self.kind != FUNCTION {
			return self.eat(IDENT);
		}
		let name = self.consume_function_name()?;
		let outer = self.function;
		self.function = name;
		let children = self.pseudo_children(name);
		self.function = outer;
		children?;
		self.eat(RIGHT_PAREN)
	}
	fn pseudo_children(&mut self, name: (usize, usize)) -> Parsed {
		if self.lookup_non_ws_type(0) == RIGHT_PAREN {
			return Ok(());
		}
		let text = self.text(name);
		let is = |reference: &[u8]| lower_is(text, reference);
		if is(b"dir") {
			self.skip_sc();
			self.eat(IDENT)?;
		} else if is(b"has")
			|| is(b"matches")
			|| is(b"is")
			|| is(b"-moz-any")
			|| is(b"-webkit-any")
			|| is(b"where")
			|| is(b"not")
		{
			self.skip_sc();
			self.selector_list()?;
		} else if is(b"lang") {
			self.skip_sc();
			self.language_ranges()?;
		} else if is(b"nth-child")
			|| is(b"nth-last-child")
			|| is(b"nth-last-of-type")
			|| is(b"nth-of-type")
		{
			self.skip_sc();
			self.nth()?;
		} else if is(b"slotted") || is(b"host") || is(b"host-context") {
			self.skip_sc();
			self.selector()?;
		} else {
			self.raw_leaf(until_balance_end, false);
			return Ok(());
		}
		self.skip_sc();
		Ok(())
	}
	/// `pseudo/lang.js`
	fn language_ranges(&mut self) -> Parsed {
		self.skip_sc();
		while !self.eof {
			match self.kind {
				IDENT => self.eat(IDENT)?,
				STRING => self.string()?,
				COMMA => self.next(),
				RIGHT_PAREN => break,
				_ => return Err(Fail::Syntax),
			}
			self.skip_sc();
		}
		Ok(())
	}
	fn nth(&mut self) -> Parsed {
		self.skip_sc();
		if self.lookup_value(0, b"odd") || self.lookup_value(0, b"even") {
			self.eat(IDENT)?;
		} else {
			self.an_plus_b()?;
		}
		self.skip_sc();
		if self.lookup_value(0, b"of") {
			self.next();
			self.selector_list()?;
		}
		Ok(())
	}

	// AnPlusB

	fn check_integer(&self, offset: usize, disallow_sign: bool) -> Parsed {
		let mut pos = self.start + offset;
		let code = self.char_code_at(pos);
		if code == b'+' || code == b'-' {
			if disallow_sign {
				return Err(Fail::Syntax);
			}
			pos += 1;
		}
		while pos < self.end {
			if !is_digit(self.char_code_at(pos) as u32) {
				return Err(Fail::Syntax);
			}
			pos += 1;
		}
		Ok(())
	}
	fn expect_char_code(&self, offset: usize, code: u8) -> Parsed {
		if !cmp_char(self.source, self.start + offset, code) {
			return Err(Fail::Syntax);
		}
		Ok(())
	}
	fn consume_b(&mut self) -> Parsed {
		let mut offset = 0;
		let mut signed = false;
		let mut kind = self.kind;
		while kind == WHITESPACE || kind == COMMENT {
			offset += 1;
			kind = self.lookup_type(offset);
		}
		if kind != NUMBER {
			if self.is_delim_at(b'+', offset) || self.is_delim_at(b'-', offset) {
				signed = true;
				loop {
					offset += 1;
					kind = self.lookup_type(offset);
					if kind != WHITESPACE && kind != COMMENT {
						break;
					}
				}
				if kind != NUMBER {
					self.skip(offset);
					self.check_integer(0, true)?;
				}
			} else {
				return Ok(());
			}
		}
		if offset > 0 {
			self.skip(offset);
		}
		if !signed {
			let code = self.char_code_at(self.start);
			if code != b'+' && code != b'-' {
				return Err(Fail::Syntax);
			}
		}
		self.check_integer(0, signed)?;
		self.eat(NUMBER)
	}
	/// what follows the `n` of an+b, by how long the token is past it
	fn after_n(&mut self, n: usize) -> Parsed {
		match self.end - self.start - n {
			1 => {
				self.next();
				self.consume_b()
			}
			2 => {
				self.expect_char_code(n + 1, b'-')?;
				self.next();
				self.skip_sc();
				self.check_integer(0, true)?;
				self.eat(NUMBER)
			}
			_ => {
				self.expect_char_code(n + 1, b'-')?;
				self.check_integer(n + 2, true)?;
				self.next();
				Ok(())
			}
		}
	}
	fn an_plus_b(&mut self) -> Parsed {
		if self.kind == NUMBER {
			self.check_integer(0, false)?;
			self.eat(NUMBER)
		} else if self.kind == IDENT && cmp_char(self.source, self.start, b'-') {
			self.expect_char_code(1, b'n')?;
			self.after_n(1)
		} else if self.kind == IDENT || (self.is_delim(b'+') && self.lookup_type(1) == IDENT) {
			if self.is_delim(b'+') {
				self.next();
			}
			self.expect_char_code(0, b'n')?;
			self.after_n(0)
		} else if self.kind == DIMENSION {
			let code = self.char_code_at(self.start);
			let sign = (code == b'+' || code == b'-') as usize;
			let mut at = self.start + sign;
			while at < self.end && is_digit(self.char_code_at(at) as u32) {
				at += 1;
			}
			if at == self.start + sign {
				return Err(Fail::Syntax);
			}
			self.expect_char_code(at - self.start, b'n')?;
			self.after_n(at - self.start)
		} else {
			Err(Fail::Syntax)
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// the leaves of `source` parsed in `context`: kind, text and function
	fn leaves(source: &str, context: Context) -> Option<Vec<(u8, String, String)>> {
		let mut parser = Parser::recycled(source.as_bytes(), Buffers::default()).unwrap();
		match parser.parse_context(context) {
			Ok(()) => {}
			Err(Fail::Syntax) => return None,
			Err(Fail::Decline) => panic!("declined"),
		}
		let text = |range: (usize, usize)| {
			String::from_utf8(parser.text(range).to_vec()).unwrap()
		};
		Some(
			parser
				.leaves
				.iter()
				.map(|leaf| {
					(
						leaf.kind,
						text((leaf.start, leaf.end)),
						if leaf.function == NO_FUNCTION {
							String::new()
						} else {
							text(leaf.function)
						},
					)
				})
				.collect(),
		)
	}
	fn leaf(kind: u8, text: &str, function: &str) -> (u8, String, String) {
		(kind, text.to_string(), function.to_string())
	}

	#[test]
	fn a_value_gives_its_urls_and_strings_with_their_functions() {
		assert_eq!(
			leaves(
				"url(a.png) no-repeat, URL( 'b' ) image-set(\"c\" 1x, (\"d\")) local(\"e\")",
				Context::Value
			),
			Some(vec![
				leaf(URL_TOKEN_LEAF, "url(a.png)", ""),
				leaf(URL_FUNCTION_LEAF, "URL( 'b' )", ""),
				leaf(STRING_LEAF, "\"c\"", "image-set"),
				leaf(STRING_LEAF, "\"d\"", "image-set"),
				leaf(STRING_LEAF, "\"e\"", "local"),
			])
		);
	}

	#[test]
	fn a_value_css_tree_rejects_is_a_syntax_error() {
		assert_eq!(leaves("url(a) ! b", Context::Value), None);
		assert_eq!(leaves("url(a) }", Context::Value), None);
		assert_eq!(leaves("url(a b) c", Context::Value), None);
		assert_eq!(leaves("u+zz url(a)", Context::Value), None);
		assert_eq!(leaves("# url(a)", Context::Value), None);
	}

	#[test]
	fn expression_and_var_keep_their_arguments_raw() {
		assert_eq!(
			leaves("expression(url(a)) var(--b, url(c) d) var(--e)", Context::Value),
			Some(vec![
				leaf(RAW_LEAF, "url(a)", "expression"),
				leaf(RAW_LEAF, " url(c) d", "var"),
			])
		);
	}

	#[test]
	fn an_import_prelude() {
		assert_eq!(
			leaves(
				"'a.css' layer(b.c) supports(background: url(d)) screen and (min-width: 1px)",
				Context::AtrulePrelude(b"import")
			),
			Some(vec![
				leaf(STRING_LEAF, "'a.css'", ""),
				leaf(URL_TOKEN_LEAF, "url(d)", "supports"),
			])
		);
		assert_eq!(
			leaves("url(a.css) supports(not (display: grid))", Context::AtrulePrelude(b"IMPORT")),
			Some(vec![leaf(URL_TOKEN_LEAF, "url(a.css)", "")])
		);
		assert_eq!(leaves("a.css", Context::AtrulePrelude(b"import")), None);
	}

	#[test]
	fn other_preludes() {
		assert_eq!(
			leaves("svg url(http://www.w3.org/2000/svg)", Context::AtrulePrelude(b"namespace")),
			Some(vec![leaf(URL_TOKEN_LEAF, "url(http://www.w3.org/2000/svg)", "")])
		);
		assert_eq!(
			leaves("(background: url(a)) and selector(b > c)", Context::AtrulePrelude(b"supports")),
			Some(vec![leaf(URL_TOKEN_LEAF, "url(a)", "")])
		);
		// a function no feature is named after is enclosed, its value read
		assert_eq!(
			leaves("src(\"a\") or (b)", Context::AtrulePrelude(b"media")),
			Some(vec![leaf(STRING_LEAF, "\"a\"", "")])
		);
		assert_eq!(
			leaves("(a: url(b)) to (c)", Context::AtrulePrelude(b"scope")),
			Some(vec![leaf(RAW_LEAF, "a: url(b)", "")])
		);
	}

	#[test]
	fn selectors() {
		assert_eq!(
			leaves("a[href*=\"url(\"]:not([b='c']), d:lang(\"e\")", Context::SelectorList),
			Some(vec![
				leaf(STRING_LEAF, "\"url(\"", ""),
				leaf(STRING_LEAF, "'c'", "not"),
				leaf(STRING_LEAF, "\"e\"", "lang"),
			])
		);
		assert_eq!(
			leaves("a:-webkit-any(b):foo(url(c)):nth-child(2n + 1 of d)", Context::SelectorList),
			Some(vec![leaf(RAW_LEAF, "url(c)", "foo")])
		);
		assert_eq!(leaves("a:is( ) url(b)", Context::SelectorList), None);
		assert_eq!(leaves("a { url(b)", Context::SelectorList), None);
	}

	#[test]
	fn lowering_knows_the_kelvin_sign() {
		assert!(lower_is("-WEB\u{212A}IT-any".as_bytes(), b"-webkit-any"));
		assert!(!lower_is(b"-webkit-an", b"-webkit-any"));
		assert!(!lower_is(b"-webkit-anyy", b"-webkit-any"));
	}

	#[test]
	fn nesting_past_what_the_port_recurses_to_is_declined() {
		let deep = "(".repeat(200) + "url(a)";
		let mut parser = Parser::recycled(deep.as_bytes(), Buffers::default()).unwrap();
		assert_eq!(parser.parse_context(Context::Value), Err(Fail::Decline));
	}
}
