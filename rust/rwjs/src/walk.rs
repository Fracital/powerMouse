//! The walk: every rewrite of src/rewriteJS.ts as text edits at the spans of
//! oxc's tree. Nothing is printed from the tree. A rewritten node keeps its
//! operands where they stand and has the text between them replaced
//! (`o[k]` to `$s$j.get2(o, k, "o[k]")` is a wrap opening at `o`, `[`
//! replaced by `, ` and `]` by the rest), so an operand is rewritten in
//! place by the same walk; a part that has to move or to stand twice (a
//! direct eval's arguments, a hoisted parameter pattern) is rendered on its
//! own and becomes the text of an edit.
//!
//! The JavaScript rewriter decides from a node and its parent; here the
//! parent decides for its operands (a call looks at its callee, an
//! assignment at its target), which is the same table read the other way.
//! What it leaves unvisited (`result()` not given) is walked for the
//! function marks alone, as its tree keeps those nodes as they were.

use edits::{Edit, Piece, Span as EditSpan, apply_range};
use oxc::ast::AstKind;
use oxc::ast::ast::*;
use oxc::ast_visit::{Visit, walk};
use oxc::span::{GetSpan, Span};
use oxc::syntax::scope::ScopeFlags;

use crate::rewrite::{Decline, Options, ROUTE_IMPORT, Route, js_whitespace};
use crate::shape::{
	Mem, Post, Shapes, bindings_named, bound_names, in_optional_chain, inner_span, is_literal,
	is_pattern_call, post_message, pure, pure_arguments, spec_text, unparen,
};
use crate::source::{Utf16Offsets, function_mark, quote, source_key};

/// What a node's place says about it, handed from the parent to the next
/// expression visited
#[derive(Clone, Copy, Default)]
struct Cx {
	/// a callee or a template's tag: a literal index is no window read there
	no_index: bool,
	/// the chain goes on past this node (it is the object of a member or
	/// the callee of a call)
	continues: bool,
	/// what `new` constructs, or the object of a member of it: a call
	/// written there would take the `new` for itself (`new top.A()` is not
	/// `new $s$j.get(top, "top").A()`), so it goes in parentheses
	new_callee: bool,
}

/// where a `var` declaration stands, for `var location`
#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum VarPlace {
	#[default]
	Statement,
	/// the head of a `for (... in/of ...)`
	Loop,
	/// the initialiser of a `for (;;)`
	ForInit,
}

/// A rewritten node being written: the text waiting to replace whatever
/// stands between the last operand and the next
struct Seq {
	node: Span,
	cursor: u32,
	pending: String,
}

pub struct Walker<'a, 'c, 'h> {
	src: &'a str,
	options: &'c Options<'c>,
	shapes: Shapes<'c>,
	offsets: &'c Utf16Offsets,
	route: &'c mut Route<'h>,
	edits: Vec<Edit>,
	/// whether the node the JavaScript rewriter has as the parent of what
	/// is visited next is an expression by its type's name (it puts a
	/// partial in parentheses then), innermost last
	parents: Vec<bool>,
	/// false inside what the JavaScript rewriter does not visit: only the
	/// function marks are written there
	rewriting: bool,
	/// inside what the JavaScript rewriter drops: marks are counted, not written
	dropped: bool,
	/// functions, arrows and static blocks around: a `var` in one is local
	functions: u32,
	cx: Cx,
	/// the node just visited is one whose parent link must become optional
	chain_out: bool,
	var_place: VarPlace,
	/// the assignments a `for (var location of ...)` head leaves for its body
	loop_assignments: String,
	/// the function that is a method's value: marked as the method
	method_value: Option<Span>,
	/// the start of the expression statement being walked when it stands in
	/// a statement list: a replacement that opens a parenthesis there must
	/// not join the statement before it
	statement_start: Option<u32>,
	/// the statement start a helper call was written at (`head`)
	headed: std::cell::Cell<Option<u32>>,
	marks: u32,
	key: Option<String>,
	declined: Option<Decline>,
}

fn espan(span: Span) -> EditSpan {
	EditSpan::new(span.start, span.end)
}

fn text(text: String) -> Vec<Piece> {
	if text.is_empty() { Vec::new() } else { vec![Piece::Text(text)] }
}

fn ident_byte(byte: u8) -> bool {
	byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$' || byte >= 0x80
}

impl<'a, 'c, 'h> Walker<'a, 'c, 'h> {
	pub fn new(
		src: &'a str,
		options: &'c Options<'c>,
		offsets: &'c Utf16Offsets,
		route: &'c mut Route<'h>,
	) -> Self {
		Self {
			src,
			options,
			shapes: Shapes { config: options.config },
			offsets,
			route,
			edits: Vec::new(),
			parents: vec![false],
			rewriting: true,
			dropped: false,
			functions: 0,
			cx: Cx::default(),
			chain_out: false,
			var_place: VarPlace::Statement,
			loop_assignments: String::new(),
			method_value: None,
			statement_start: None,
			headed: std::cell::Cell::new(None),
			marks: 0,
			key: options.params.key.clone(),
			declined: None,
		}
	}

	pub fn finish(self) -> (Vec<Edit>, u32, Option<String>, Option<Decline>) {
		(self.edits, self.marks, self.key, self.declined)
	}

	pub fn push(&mut self, edit: Edit) {
		self.edits.push(edit);
	}

	pub fn route(&mut self, kind: u32, text: &str) -> Option<String> {
		(self.route)(kind, text)
	}

	fn decline(&mut self, why: Decline) {
		self.declined.get_or_insert(why);
	}

	// ---- text ----

	fn access(&self) -> &'c str {
		&self.options.config.names.access
	}

	fn slice(&self, span: Span) -> &'a str {
		&self.src[span.start as usize..span.end as usize]
	}

	/// `$s$j.name(`, ahead of a node at `at`: with a space when the token
	/// before it would run into the name (`return"a"[i]`)
	fn head(&self, at: u32, name: &str) -> String {
		let glued = at > 0 && ident_byte(self.src.as_bytes()[at as usize - 1]);
		if self.statement_start == Some(at) {
			// the statement now starts with this name: nothing inside it
			// opens the statement any more (open_paren)
			self.headed.set(Some(at));
		}
		format!("{}{}.{name}(", if glued { " " } else { "" }, self.access())
	}

	/// an opening parenthesis ahead of a replacement at `at`: behind a `;`
	/// where the statement before could take it as a call's
	fn open_paren(&self, at: u32) -> &'static str {
		if self.statement_start != Some(at) || self.headed.get() == Some(at) {
			return "(";
		}
		let before = self.src[..at as usize].trim_end_matches(js_whitespace);
		if before.is_empty() || before.ends_with(';') || before.ends_with('{') { "(" } else { ";(" }
	}

	/// the page's text of a node as a string literal, for a helper to name
	/// it in an error; in parentheses where the JavaScript rewriter puts them
	fn partial(&self, span: Span) -> String {
		let text = self.slice(span);
		if self.parents.last().copied().unwrap_or(false) {
			quote(&format!("({text})"))
		} else {
			quote(text)
		}
	}

	/// a call's or construction's text for a helper's error (`callText`)
	fn call_text(&self, callee: &Expression, args: &[Argument], optional: bool, new: bool) -> String {
		let callee = unparen(callee);
		let plain = !new
			&& (Mem::of(callee).is_some()
				|| matches!(
					callee,
					Expression::Identifier(_)
						| Expression::CallExpression(_)
						| Expression::ChainExpression(_)
						| Expression::ThisExpression(_)
				));
		let mut out = String::new();
		if new {
			out.push_str("new ");
		}
		if !plain {
			out.push('(');
		}
		out.push_str(self.slice(callee.span()));
		if !plain {
			out.push(')');
		}
		if optional {
			out.push_str("?.");
		}
		out.push('(');
		for (i, arg) in args.iter().enumerate() {
			if i > 0 {
				out.push_str(", ");
			}
			out.push_str(if matches!(arg, Argument::SpreadElement(_)) { "...0" } else { "0" });
		}
		out.push(')');
		quote(&out)
	}

	/// the first `target` at or after `from`, past whitespace and comments
	fn find(&self, from: u32, target: u8) -> Option<u32> {
		let bytes = self.src.as_bytes();
		let mut at = from as usize;
		while at < bytes.len() {
			if bytes[at] == target {
				return Some(at as u32);
			}
			if bytes[at] == b'/' && bytes.get(at + 1) == Some(&b'*') {
				at = at + 2 + self.src[at + 2..].find("*/")? + 2;
			} else if bytes[at] == b'/' && bytes.get(at + 1) == Some(&b'/') {
				at += self.src[at..].find(['\n', '\r', '\u{2028}', '\u{2029}'])?;
			} else {
				at += 1;
			}
		}
		None
	}

	/// whether what follows `at` is a new line that starts with a token a
	/// call's `)` would take as its own continuation, where the `++` of a
	/// postfix update did not
	fn joins_next_line(&self, at: u32) -> bool {
		let mut rest = &self.src[at as usize..];
		let mut line = false;
		loop {
			let trimmed = rest.trim_start_matches(|c: char| {
				if matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
					line = true;
				}
				js_whitespace(c)
			});
			if let Some(comment) = trimmed.strip_prefix("/*") {
				let Some(end) = comment.find("*/") else {
					return false;
				};
				if comment[..end].contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
					line = true;
				}
				rest = &comment[end + 2..];
			} else if trimmed.starts_with("//") {
				let Some(end) = trimmed.find(['\n', '\r', '\u{2028}', '\u{2029}']) else {
					return false;
				};
				rest = &trimmed[end..];
			} else {
				return line && trimmed.starts_with(['(', '[', '`']);
			}
		}
	}

	// ---- edits ----

	fn wrap(&mut self, span: Span, before: String, after: String) {
		self.edits.push(Edit::wrap(espan(span), text(before), text(after)));
	}

	fn replace(&mut self, start: u32, end: u32, with: String) {
		self.edits.push(Edit::replace(EditSpan::new(start, end), text(with)));
	}

	/// `walk` with the parent of what it visits an expression or not
	fn under(&mut self, expression: bool, walk: impl FnOnce(&mut Self)) {
		self.parents.push(expression);
		walk(self);
		self.parents.pop();
	}

	/// an operand of a helper's call: its parent is that call
	fn operand(&mut self, e: &Expression<'a>) {
		self.cx = Cx::default();
		self.under(true, |walker| walker.visit_expression(e));
		self.chain_out = false;
	}

	/// what the JavaScript rewriter leaves unvisited: marks alone
	fn unvisited(&mut self, walk: impl FnOnce(&mut Self)) {
		let was = std::mem::replace(&mut self.rewriting, false);
		walk(self);
		self.rewriting = was;
	}

	/// what it drops from the output: nothing written, its marks counted
	fn drop_expression(&mut self, e: &Expression<'a>) {
		let rewriting = std::mem::replace(&mut self.rewriting, false);
		let dropped = std::mem::replace(&mut self.dropped, true);
		self.visit_expression(e);
		self.rewriting = rewriting;
		self.dropped = dropped;
	}

	/// the part `span` as the walk rewrites it, as text
	fn render(&mut self, span: Span, walk: impl FnOnce(&mut Self)) -> String {
		let outer = std::mem::take(&mut self.edits);
		walk(self);
		let inner = std::mem::replace(&mut self.edits, outer);
		match apply_range(self.src, espan(span), inner) {
			Ok(text) => text,
			Err(_) => {
				self.decline(Decline::Edits);
				String::new()
			}
		}
	}

	fn seq(&self, node: Span, name: &str) -> Seq {
		Seq {
			node,
			cursor: node.start,
			pending: self.head(node.start, name),
		}
	}

	/// the pending text in place of what stands up to `to`
	fn seq_flush(&mut self, seq: &mut Seq, to: u32) {
		let pending = std::mem::take(&mut seq.pending);
		if seq.cursor < to {
			self.replace(seq.cursor, to, pending);
		} else if !pending.is_empty() {
			if seq.cursor == seq.node.start {
				self.wrap(seq.node, pending, String::new());
			} else {
				self.decline(Decline::Shape);
			}
		}
		seq.cursor = to;
	}

	/// the next operand, visited where it stands
	fn seq_operand(&mut self, seq: &mut Seq, e: &Expression<'a>) {
		self.seq_flush(seq, e.span().start);
		if matches!(e, Expression::SequenceExpression(_)) {
			// `o[a, b]`: one argument of the helper, not two
			self.wrap(e.span(), "(".into(), ")".into());
		}
		self.operand(e);
		seq.cursor = e.span().end;
	}

	/// the arguments, between `open` and (when `close` is given) `close`;
	/// without `close` the call's own closing parenthesis stays
	fn seq_arguments(&mut self, seq: &mut Seq, args: &[Argument<'a>], open: &str, close: Option<&str>) {
		seq.pending.push_str(open);
		let (Some(first), Some(last)) = (args.first(), args.last()) else {
			seq.pending.push_str(close.unwrap_or(")"));
			return;
		};
		self.seq_flush(seq, first.span().start);
		self.under(true, |walker| {
			for arg in args {
				walker.visit_argument(arg);
			}
		});
		match close {
			Some(close) => {
				seq.cursor = last.span().end;
				seq.pending.push_str(close);
			}
			None => seq.cursor = seq.node.end,
		}
	}

	fn seq_end(&mut self, seq: Seq) {
		if seq.cursor < seq.node.end {
			self.replace(seq.cursor, seq.node.end, seq.pending);
		} else if !seq.pending.is_empty() {
			self.wrap(seq.node, String::new(), seq.pending);
		}
	}

	/// the key of a member as a helper's argument: a name quoted, a
	/// computed key visited where it stands
	fn seq_key(&mut self, seq: &mut Seq, m: Mem<'_, 'a>) {
		seq.pending.push_str(", ");
		match m {
			Mem::Static(m) => seq.pending.push_str(&quote(m.property.name.as_str())),
			Mem::Computed(m) => self.seq_operand(seq, &m.expression),
			Mem::Private(_) => self.decline(Decline::Shape),
		}
	}

	// ---- marks ----

	fn key(&mut self) -> &str {
		let src = self.src;
		self.key.get_or_insert_with(|| source_key(src))
	}

	/// where in the kept text a UTF-16 position of this script stands
	fn shifted(&self, position: u32) -> u32 {
		let mut shift = 0;
		for (from, by) in &self.options.params.shifts {
			if position < *from {
				break;
			}
			shift = *by;
		}
		(i64::from(position) + shift).max(0) as u32
	}

	/// the end of the token at `at` when a mark can follow it: a word, or
	/// one of the punctuators a function's source starts with
	fn first_token_end(&self, at: u32) -> Option<u32> {
		let bytes = self.src.as_bytes();
		let first = *bytes.get(at as usize)?;
		if matches!(first, b'(' | b'[' | b'*') {
			return Some(at + 1);
		}
		let mut end = at as usize + usize::from(first == b'#');
		let start = end;
		while end < bytes.len() && ident_byte(bytes[end]) {
			end += 1;
		}
		(end > start && bytes.get(end) != Some(&b'\\')).then_some(end as u32)
	}

	/// the mark of the function at `span`, after the token that ends at `at`
	fn mark(&mut self, at: Option<u32>, span: Span) {
		let Some(at) = at else {
			return;
		};
		self.marks += 1;
		if self.dropped {
			return;
		}
		let start = self.shifted(self.offsets.convert(span.start));
		let end = self.shifted(self.offsets.convert(span.end));
		let mark = function_mark(self.key(), start, end.max(start));
		self.edits.push(Edit::insert(at, text(mark), 0));
	}

	/// the mark of a method, getter or setter: its source starts after
	/// `static`, and the mark follows its first token
	fn mark_method(&mut self, span: Span, key: &PropertyKey<'a>, computed: bool, is_static: bool) {
		let start = if is_static { self.after_static(span.start) } else { span.start };
		let at = if !computed && key.span().start == start {
			Some(key.span().end)
		} else {
			self.first_token_end(start)
		};
		self.mark(at, Span::new(start, span.end));
	}

	/// the position after `static` and what follows it up to the method's own source
	fn after_static(&self, start: u32) -> u32 {
		let mut at = start as usize + "static".len();
		loop {
			let rest = &self.src[at..];
			if rest.starts_with("/*") {
				match rest[2..].find("*/") {
					Some(end) => at += end + 4,
					None => return at as u32,
				}
			} else if rest.starts_with("//") {
				match rest.find(['\n', '\r', '\u{2028}', '\u{2029}']) {
					Some(end) => at += end,
					None => return at as u32,
				}
			} else {
				match rest.chars().next() {
					Some(c) if js_whitespace(c) => at += c.len_utf8(),
					_ => return at as u32,
				}
			}
		}
	}

	// ---- reads ----

	/// parentheses around the helper's call about to stand for `span`,
	/// where `new` would take the call for its own
	fn paren(&mut self, span: Span, cx: Cx) {
		if cx.new_callee {
			self.wrap(span, "(".into(), ")".into());
		}
	}

	fn identifier_read(&mut self, id: &IdentifierReference<'a>, cx: Cx) {
		let name = id.name.as_str();
		if self.options.config.routes(name) {
			self.paren(id.span, cx);
			let head = self.head(id.span.start, "get");
			self.wrap(id.span, head, format!(", {})", quote(name)));
		}
	}

	/// a member the rewriter leaves as it is: its object is still read, and
	/// a computed key too, unless it is a bare name (which the JavaScript
	/// rewriter takes for a property's)
	fn plain_member(&mut self, m: Mem<'_, 'a>, cx: Cx) {
		let object = m.object();
		self.cx = Cx {
			no_index: false,
			continues: true,
			new_callee: cx.new_callee,
		};
		self.under(true, |walker| walker.visit_expression(object));
		if std::mem::take(&mut self.chain_out) && !m.optional() {
			// the object became a helper's call that answers undefined where
			// the chain short-circuited: the rest must keep short-circuiting
			let (target, with) = match m {
				Mem::Computed(_) => (b'[', "?.["),
				_ => (b'.', "?."),
			};
			match self.find(object.span().end, target) {
				Some(at) => self.replace(at, at + 1, with.to_owned()),
				None => self.decline(Decline::Shape),
			}
		}
		if let Mem::Computed(m) = m {
			if !matches!(unparen(&m.expression), Expression::Identifier(_)) {
				self.cx = Cx::default();
				self.under(true, |walker| walker.visit_expression(&m.expression));
			}
		}
		self.chain_out = false;
	}

	fn member_read(&mut self, m: Mem<'_, 'a>, cx: Cx) {
		if !self.shapes.routes_member(m, cx.no_index) {
			return self.plain_member(m, cx);
		}
		let chained = m.optional() || in_optional_chain(m.object());
		let key_pure = match m {
			Mem::Computed(m) => pure(&m.expression),
			_ => true,
		};
		let span = m.span();
		self.paren(span, cx);
		if (chained && !key_pure) || (m.optional() && cx.continues) {
			// a?.b[k()], a?.[k].x: the key is evaluated only past the links
			// that can short-circuit, and the rest of the chain follows
			let mut seq = self.seq(span, "lazy");
			self.seq_operand(&mut seq, m.object());
			seq.pending.push_str(")?.(");
			match m {
				Mem::Static(m) => seq.pending.push_str(&quote(m.property.name.as_str())),
				Mem::Computed(m) => self.seq_operand(&mut seq, &m.expression),
				Mem::Private(_) => {}
			}
			seq.pending.push(')');
			self.seq_end(seq);
			self.chain_out = false;
			return;
		}
		let partial = self.partial(span);
		let mut seq = self.seq(span, "get2");
		self.seq_operand(&mut seq, m.object());
		self.seq_key(&mut seq, m);
		seq.pending.push_str(", ");
		seq.pending.push_str(&partial);
		if chained {
			seq.pending.push_str(", true");
		}
		seq.pending.push(')');
		self.seq_end(seq);
		self.chain_out = chained && cx.continues;
	}

	// ---- calls ----

	fn call(&mut self, c: &CallExpression<'a>, cx: Cx) {
		if let Some(post) = post_message(c) {
			return self.post(c, post);
		}
		let callee = unparen(&c.callee);
		if matches!(callee, Expression::Identifier(id) if id.name == "eval") && !c.arguments.is_empty() {
			return self.direct_eval(c);
		}
		let args_pure = pure_arguments(&c.arguments);
		match Mem::of(callee) {
			Some(m) if !m.is_private() && !m.on_super() => {
				let routed = self.shapes.routes_member(m, true);
				let chained = m.optional() || in_optional_chain(m.object());
				if !routed && self.shapes.prints_helper(m.object()) {
					// a call V8 would name with a helper's call in its
					// message when it fails: the call is the access API's
					if !chained && !c.optional && args_pure {
						return self.call2(c, m, 0, true);
					}
					return self.method(c, m, chained);
				}
				if routed {
					let key_pure = match m {
						Mem::Computed(m) => pure(&m.expression),
						_ => true,
					};
					if (chained && !key_pure)
						|| ((chained || c.optional) && !args_pure)
						|| (m.optional() && cx.continues)
					{
						return self.method(c, m, chained);
					}
					let links = u8::from(chained) | (u8::from(c.optional) << 1);
					self.call2(c, m, links, false);
					self.chain_out = chained && cx.continues;
					return;
				}
			}
			Some(_) => {}
			None => {
				if !c.optional && self.shapes.prints_helper(callee) {
					let partial = self.call_text(&c.callee, &c.arguments, false, false);
					let mut seq = self.seq(c.span, "fcall");
					self.seq_operand(&mut seq, &c.callee);
					self.seq_arguments(&mut seq, &c.arguments, ", [", Some("], "));
					seq.pending.push_str(&partial);
					seq.pending.push(')');
					return self.seq_end(seq);
				}
			}
		}
		self.cx = Cx {
			no_index: true,
			continues: true,
			new_callee: false,
		};
		self.under(true, |walker| {
			walker.visit_expression(&c.callee);
			walker.chain_out = false;
			walker.visit_arguments(&c.arguments);
		});
		self.chain_out = false;
	}

	/// `$s$j.call2(o, k, [...], text, links)`, or `call3` for `o[k].m()`
	/// where the read and the call go in one helper
	fn call2(&mut self, c: &CallExpression<'a>, m: Mem<'_, 'a>, links: u8, may_read: bool) {
		let partial = self.call_text(&c.callee, &c.arguments, c.optional, false);
		let inner = Mem::of(unparen(m.object()))
			.filter(|inner| may_read && self.shapes.routes_member(*inner, false));
		let mut seq = self.seq(c.span, if inner.is_some() { "call3" } else { "call2" });
		match inner {
			Some(inner) => {
				self.seq_operand(&mut seq, inner.object());
				self.seq_key(&mut seq, inner);
			}
			None => self.seq_operand(&mut seq, m.object()),
		}
		self.seq_key(&mut seq, m);
		self.seq_arguments(&mut seq, &c.arguments, ", [", Some("], "));
		seq.pending.push_str(&partial);
		if links > 0 {
			seq.pending.push_str(&format!(", {links}"));
		}
		seq.pending.push(')');
		self.seq_end(seq);
	}

	/// `$s$j.method(o, chained, optional, text)?.(k)?.(...)`: the key and
	/// the arguments are evaluated only past the links that can short-circuit
	fn method(&mut self, c: &CallExpression<'a>, m: Mem<'_, 'a>, chained: bool) {
		let partial = self.call_text(&c.callee, &c.arguments, c.optional, false);
		let mut seq = self.seq(c.span, "method");
		self.seq_operand(&mut seq, m.object());
		seq.pending.push_str(&format!(", {chained}, {}, {partial})?.(", c.optional));
		match m {
			Mem::Static(m) => seq.pending.push_str(&quote(m.property.name.as_str())),
			Mem::Computed(m) => self.seq_operand(&mut seq, &m.expression),
			Mem::Private(_) => {}
		}
		self.seq_arguments(&mut seq, &c.arguments, ")?.(", None);
		self.seq_end(seq);
		self.chain_out = false;
	}

	/// a message posted to a window goes out from the caller's realm
	fn post(&mut self, c: &CallExpression<'a>, post: Post<'_, 'a>) {
		let partial = self.call_text(&c.callee, &c.arguments, c.optional, false);
		let args = &c.arguments;
		let mut seq = self.seq(c.span, "post");
		match post {
			Post::Direct(m) => {
				let optional = c.optional || m.optional() || in_optional_chain(m.object());
				if optional && !pure_arguments(args) {
					// w?.postMessage(f()): nothing is posted, nor f called,
					// when w is nullish
					seq = self.seq(c.span, "poster");
					self.seq_operand(&mut seq, m.object());
					seq.pending.push_str(&format!(", {partial}"));
					self.seq_arguments(&mut seq, args, ")?.(", None);
					return self.seq_end(seq);
				}
				self.seq_operand(&mut seq, m.object());
				self.seq_arguments(&mut seq, args, ", [", Some("], "));
				seq.pending.push_str(&format!("{optional}, {partial})"));
			}
			Post::Call | Post::Apply | Post::Reflect => {
				// the receiver the method was read from is not in the output
				self.drop_expression(&c.callee);
				let (target, rest) = match post {
					Post::Reflect => {
						self.drop_expression(args[0].to_expression());
						(args.get(1), args.get(2..).unwrap_or(&[]))
					}
					_ => (args.first(), args.get(1..).unwrap_or(&[])),
				};
				match target {
					Some(target) => self.seq_operand(&mut seq, target.to_expression()),
					None => seq.pending.push_str("undefined"),
				}
				if matches!(post, Post::Call) {
					self.seq_arguments(&mut seq, rest, ", [", Some("], "));
				} else {
					match rest.first() {
						Some(array) => {
							seq.pending.push_str(", ");
							self.seq_operand(&mut seq, array.to_expression());
							seq.pending.push_str(", ");
							for extra in &rest[1..] {
								self.drop_expression(extra.to_expression());
							}
						}
						None => seq.pending.push_str(", [], "),
					}
				}
				seq.pending.push_str(&format!("false, {partial})"));
			}
		}
		self.seq_end(seq);
	}

	/// `eval(code)`: the real eval gets the code rewritten in the caller's
	/// scope, anything else named eval the arguments as they are
	fn direct_eval(&mut self, c: &CallExpression<'a>) {
		let (Some(first), Some(last)) = (c.arguments.first(), c.arguments.last()) else {
			return;
		};
		let span = Span::new(first.span().start, last.span().end);
		let args = self.render(span, |walker| {
			walker.under(true, |walker| {
				for arg in &c.arguments {
					walker.visit_argument(arg);
				}
			});
		});
		let access = self.access();
		let open = self.open_paren(c.span.start);
		self.replace(
			c.span.start,
			c.span.end,
			format!("{open}{access}.isEval(eval) ? eval({access}.evalScope({args})) : eval({args}))"),
		);
	}

	fn new_expression(&mut self, n: &NewExpression<'a>, cx: Cx) {
		let callee = unparen(&n.callee);
		let partial = || self.call_text(&n.callee, &n.arguments, false, true);
		match Mem::of(callee) {
			Some(m) if !m.is_private() && !m.on_super() => {
				let routed = self.shapes.routes_member(m, true);
				if routed
					|| (self.shapes.prints_helper(m.object()) && pure_arguments(&n.arguments))
				{
					let partial = partial();
					self.paren(n.span, cx);
					let mut seq = self.seq(n.span, "new2");
					self.seq_operand(&mut seq, m.object());
					self.seq_key(&mut seq, m);
					self.seq_arguments(&mut seq, &n.arguments, ", [", Some("], "));
					seq.pending.push_str(&partial);
					seq.pending.push(')');
					return self.seq_end(seq);
				}
			}
			Some(_) => {}
			None => {
				if self.shapes.prints_helper(callee) {
					let partial = partial();
					self.paren(n.span, cx);
					let mut seq = self.seq(n.span, "fnew");
					self.seq_operand(&mut seq, &n.callee);
					self.seq_arguments(&mut seq, &n.arguments, ", [", Some("], "));
					seq.pending.push_str(&partial);
					seq.pending.push(')');
					return self.seq_end(seq);
				}
			}
		}
		self.cx = Cx {
			no_index: true,
			continues: false,
			new_callee: true,
		};
		self.under(true, |walker| {
			walker.visit_expression(&n.callee);
			walker.visit_arguments(&n.arguments);
		});
	}

	fn spread(&mut self, s: &SpreadElement<'a>, shape: &str) {
		if self.rewriting && !shape.is_empty() && self.shapes.prints_helper(&s.argument) {
			// iterated by the access API first, which fails as the page's
			// expression would
			let head = self.head(s.argument.span().start, "iter");
			let source = quote(self.slice(inner_span(&s.argument)));
			self.wrap(s.argument.span(), head, format!(", \"{shape}\", {source})"));
			return self.operand(&s.argument);
		}
		self.cx = Cx::default();
		self.under(false, |walker| walker.visit_expression(&s.argument));
	}

	// ---- writes ----

	/// `(t$t, t$p, t$v) => ` and the write on `t$t[t$p]`
	fn setter(&self, write: impl FnOnce(&str, &str) -> String) -> String {
		let [target, prop, value] = &self.options.config.temps;
		format!(
			"({target}, {prop}, {value}) => {}",
			write(&format!("{target}[{prop}]"), value)
		)
	}

	/// `$s$j.set1(name, "name", write, set, ` up to the value
	fn set1_head(&self, at: u32, name: &str, write: String) -> String {
		let value = &self.options.config.temps[2];
		format!(
			"{}{name}, {}, {write}, {value} => {name} = {value}, ",
			self.head(at, "set1"),
			quote(name)
		)
	}

	fn assignment(&mut self, a: &AssignmentExpression<'a>) {
		let operator = a.operator.as_str();
		match &a.left {
			AssignmentTarget::ArrayAssignmentTarget(_) | AssignmentTarget::ObjectAssignmentTarget(_) => {
				self.pattern_assignment(a)
			}
			AssignmentTarget::AssignmentTargetIdentifier(id) => {
				let name = id.name.as_str();
				if !self.options.config.routes(name) {
					return self.under(true, |walker| walker.visit_expression(&a.right));
				}
				let partial = self.partial(a.span);
				let write = self.setter(|slot, value| format!("{slot} {operator} {value}"));
				let head = self.set1_head(a.span.start, name, write);
				self.wrap(a.span, String::new(), format!(", {partial})"));
				self.replace(a.span.start, a.right.span().start, head);
				// (the value is not visited by the JavaScript rewriter either)
				self.unvisited(|walker| walker.visit_expression(&a.right));
			}
			target => {
				let Some(member) = target.as_member_expression() else {
					return self.decline(Decline::Shape);
				};
				let m = Mem::of_member(member);
				if !self.shapes.routes_member(m, true) {
					self.plain_member(m, Cx::default());
					return self.under(true, |walker| walker.visit_expression(&a.right));
				}
				let partial = self.partial(a.span);
				let write = self.setter(|slot, value| format!("{slot} {operator} {value}"));
				let mut seq = self.seq(a.span, "set2");
				self.seq_operand(&mut seq, m.object());
				self.seq_key(&mut seq, m);
				seq.pending.push_str(&format!(", {write}, "));
				self.seq_operand(&mut seq, &a.right);
				seq.pending.push_str(&format!(", {partial})"));
				self.seq_end(seq);
			}
		}
	}

	/// `({ top: t } = o)`, `[a] = location`: the source goes through the
	/// access API, which resolves the unforgeables the pattern reads and
	/// fails naming the page's expression
	fn pattern_assignment(&mut self, a: &AssignmentExpression<'a>) {
		let spec = match &a.left {
			AssignmentTarget::ObjectAssignmentTarget(o) => match self.shapes.target_spec(o) {
				Ok(spec) => spec,
				Err(_) => return self.decline(Decline::Shape),
			},
			_ => None,
		};
		let right = a.right.span();
		let wrapped = if let Some(spec) = spec {
			let after = format!(", {}, {})", spec_text(&spec, &|key| quote(key)), self.partial(a.span));
			Some(("pattern", after))
		} else if self.shapes.prints_helper(&a.right) {
			Some(match &a.left {
				AssignmentTarget::ArrayAssignmentTarget(_) => (
					"iter",
					format!(", \"assign\", {})", quote(self.slice(inner_span(&a.right)))),
				),
				_ => ("coerce", format!(", {})", self.partial(a.span))),
			})
		} else {
			None
		};
		self.under(true, |walker| {
			if let Some(pattern) = a.left.as_assignment_target_pattern() {
				walker.visit_assignment_target_pattern(pattern);
			}
		});
		match wrapped {
			Some((name, after)) => {
				let head = self.head(right.start, name);
				self.wrap(right, head, after);
				self.operand(&a.right);
			}
			None => self.under(true, |walker| walker.visit_expression(&a.right)),
		}
	}

	fn update(&mut self, u: &UpdateExpression<'a>) {
		let operator = u.operator.as_str();
		let write = |slot: &str, _: &str| {
			if u.prefix { format!("{operator}{slot}") } else { format!("{slot}{operator}") }
		};
		// a `)` where the `++` stood takes a `(` on the next line as a call
		let end = if !u.prefix && self.joins_next_line(u.span.end) { ";" } else { "" };
		match &u.argument {
			SimpleAssignmentTarget::AssignmentTargetIdentifier(id) => {
				let name = id.name.as_str();
				if !self.options.config.routes(name) {
					return;
				}
				let partial = self.partial(u.span);
				let head = self.set1_head(u.span.start, name, self.setter(write));
				self.replace(u.span.start, u.span.end, format!("{head}undefined, {partial}){end}"));
			}
			target => {
				let Some(member) = target.as_member_expression() else {
					return self.decline(Decline::Shape);
				};
				let m = Mem::of_member(member);
				if !self.shapes.routes_member(m, true) {
					return self.plain_member(m, Cx::default());
				}
				let partial = self.partial(u.span);
				let write = self.setter(write);
				let mut seq = self.seq(u.span, "set2");
				self.seq_operand(&mut seq, m.object());
				self.seq_key(&mut seq, m);
				seq.pending.push_str(&format!(", {write}, undefined, {partial}){end}"));
				self.seq_end(seq);
			}
		}
	}

	/// the target a pattern or a loop head writes (`[x] = a`, `for (x of
	/// a)`): a reference no helper's call can stand for, so a location
	/// there becomes a member whose write routes like the assignment
	fn pattern_target(&mut self, target: &SimpleAssignmentTarget<'a>) {
		match target {
			SimpleAssignmentTarget::AssignmentTargetIdentifier(id) => {
				if id.name == "location" {
					let text = self.ref1(id.span.start);
					self.replace(id.span.start, id.span.end, text);
				}
			}
			target => {
				let Some(member) = target.as_member_expression() else {
					return self.decline(Decline::Shape);
				};
				let m = Mem::of_member(member);
				if !m.on_super() && m.literal_key() == Some("location") {
					let mut seq = self.seq(m.span(), "ref2");
					self.seq_operand(&mut seq, m.object());
					seq.pending.push_str(", \"location\").value");
					self.seq_end(seq);
				} else {
					self.plain_member(m, Cx::default());
				}
			}
		}
	}

	/// `$s$j.ref1(location, t$v => location = t$v).value`
	fn ref1(&self, at: u32) -> String {
		let value = &self.options.config.temps[2];
		format!("{}location, {value} => location = {value}).value", self.head(at, "ref1"))
	}

	// ---- declarations ----

	/// `var location = v` in a classic script outside any function assigns
	/// the window's location: bound to a temporary and assigned, so the
	/// assignment routes like `location = v`
	fn var_location(&mut self, decl: &VariableDeclaration<'a>, place: VarPlace) {
		let mut sites = Vec::new();
		for declarator in &decl.declarations {
			if declarator.init.is_some() || place == VarPlace::Loop {
				bindings_named(&declarator.id, "location", false, &mut sites);
			}
		}
		if sites.is_empty() {
			return;
		}
		let access = self.access();
		let write = self.setter(|slot, value| format!("{slot} = {value}"));
		let mut assignments = Vec::new();
		for (index, (span, shorthand)) in sites.iter().enumerate() {
			let temp = format!("{access}l{index}");
			let renamed = if *shorthand { format!("location: {temp}") } else { temp.clone() };
			self.replace(span.start, span.end, renamed);
			assignments.push(format!(
				"{}{temp}, {})",
				self.set1_head(0, "location", write.clone()),
				quote(&format!("(location={temp})"))
			));
		}
		match place {
			VarPlace::Statement => {
				let end = if self.slice(decl.span).ends_with(';') { "" } else { ";" };
				self.wrap(decl.span, "{".into(), format!("{end}{};}}", assignments.join(";")));
			}
			VarPlace::Loop => self.loop_assignments = format!("{};", assignments.join(";")),
			VarPlace::ForInit => {
				let temp = format!("{access}l{}", sites.len());
				self.wrap(
					decl.span,
					String::new(),
					format!(", {temp} = ({})", assignments.join(", ")),
				);
			}
		}
	}

	/// `function f({ top: t }) {}`: a parameter pattern has no source to
	/// wrap, so the parameter becomes a plain one and the pattern a `var`
	/// at the top of the body. The declarations to write there.
	fn hoist_parameters(&mut self, params: &FormalParameters<'a>) -> String {
		let access = self.access();
		let mut hoisted = Vec::new();
		for (index, param) in params.items.iter().enumerate() {
			let target = match &param.pattern {
				BindingPattern::AssignmentPattern(ap) => &ap.left,
				pattern => pattern,
			};
			let BindingPattern::ObjectPattern(pattern) = target else {
				self.visit_formal_parameter(param);
				continue;
			};
			let spec = match self.shapes.binding_spec(pattern) {
				Ok(spec) => spec,
				Err(_) => {
					self.decline(Decline::Shape);
					None
				}
			};
			let mut names = Vec::new();
			bound_names(target, &mut names);
			let later = params.items[index + 1..].iter().any(|later| mentions_param(later, &names))
				|| params.rest.as_ref().is_some_and(|rest| {
					let mut finder = Mentions {
						names: &names,
						found: false,
					};
					finder.visit_binding_rest_element(&rest.rest);
					finder.found
				});
			let Some(spec) = spec.filter(|_| !later) else {
				self.visit_formal_parameter(param);
				continue;
			};
			// the pattern moves: its functions keep their marks, nothing
			// else of it is rewritten (the JavaScript rewriter does not
			// visit a declaration's pattern it gave a source)
			let span = target.span();
			let moved = self.render(span, |walker| {
				walker.unvisited(|walker| walker.visit_binding_pattern(target));
			});
			let temp = format!("{access}a{index}");
			self.replace(span.start, span.end, temp.clone());
			hoisted.push(format!(
				"{moved} = {access}.pattern({temp}, {}, {})",
				spec_text(&spec, &|key| quote(key)),
				quote(&format!("{}={temp}", self.slice(span)))
			));
			// the default stays on the parameter
			self.under(false, |walker| {
				if let BindingPattern::AssignmentPattern(ap) = &param.pattern {
					walker.visit_expression(&ap.right);
				}
				if let Some(initializer) = &param.initializer {
					walker.visit_expression(initializer);
				}
			});
		}
		if let Some(rest) = &params.rest {
			self.visit_formal_parameter_rest(rest);
		}
		if hoisted.is_empty() { String::new() } else { format!("var {};", hoisted.join(", ")) }
	}

	/// a function's body with `hoisted` at its top, after the directive prologue
	fn function_body(&mut self, body: &FunctionBody<'a>, hoisted: String) {
		if !hoisted.is_empty() {
			// `function f({ top }) { 'use strict' }` is a SyntaxError the
			// plain parameter would hide
			if body.directives.iter().any(|directive| directive.directive == "use strict") {
				return self.decline(Decline::Invalid);
			}
			match body.directives.last() {
				Some(directive) => {
					let end = if self.slice(directive.span).ends_with(';') { "" } else { ";" };
					self.wrap(directive.span, String::new(), format!("{end}{hoisted}"));
				}
				None => self.replace(body.span.start, body.span.start + 1, format!("{{{hoisted}")),
			}
		}
		self.visit_function_body(body);
	}

	/// a static import's or re-export's source, routed by the host
	fn route_source(&mut self, source: &StringLiteral<'a>, with: Option<&WithClause<'a>>) {
		if !self.rewriting {
			return;
		}
		let Some(specifier) = source.value.as_str() else {
			return self.decline(Decline::Shape);
		};
		// a bare specifier is the import map's to resolve
		if is_bare_specifier(specifier) {
			return;
		}
		let kind = with
			.and_then(|with| {
				with.with_entries.iter().find(|entry| match &entry.key {
					ImportAttributeKey::Identifier(id) => id.name == "type",
					ImportAttributeKey::StringLiteral(s) => s.value.as_str() == Some("type"),
				})
			})
			.and_then(|entry| entry.value.value.as_str())
			.unwrap_or("");
		let asked = format!("{}:{kind}{specifier}", kind.encode_utf16().count());
		match self.route(ROUTE_IMPORT, &asked) {
			Some(routed) => self.replace(source.span.start, source.span.end, quote(&routed)),
			None => self.decline(Decline::Route),
		}
	}
}

/// a URL-like specifier is absolute, scheme-relative, or starts with `/`,
/// `./`, `../`; anything else is bare (`BARE_SPECIFIER`)
fn is_bare_specifier(specifier: &str) -> bool {
	if specifier.starts_with('/') || specifier.starts_with("./") || specifier.starts_with("../") {
		return false;
	}
	let bytes = specifier.as_bytes();
	if !bytes.first().is_some_and(u8::is_ascii_alphabetic) {
		return true;
	}
	for byte in &bytes[1..] {
		match byte {
			b':' => return false,
			b'+' | b'.' | b'-' => {}
			byte if byte.is_ascii_alphanumeric() => {}
			_ => return true,
		}
	}
	true
}

/// whether a parameter names any of `names` anywhere in it, as the
/// JavaScript rewriter's `mentions` finds an identifier node
fn mentions_param(param: &FormalParameter, names: &[&str]) -> bool {
	let mut finder = Mentions {
		names,
		found: false,
	};
	finder.visit_formal_parameter(param);
	finder.found
}

struct Mentions<'n> {
	names: &'n [&'n str],
	found: bool,
}

impl Mentions<'_> {
	fn see(&mut self, name: &str) {
		if self.names.contains(&name) {
			self.found = true;
		}
	}
}

impl<'a> Visit<'a> for Mentions<'_> {
	fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
		self.see(it.name.as_str());
	}
	fn visit_binding_identifier(&mut self, it: &BindingIdentifier<'a>) {
		self.see(it.name.as_str());
	}
	fn visit_identifier_name(&mut self, it: &IdentifierName<'a>) {
		self.see(it.name.as_str());
	}
	fn visit_label_identifier(&mut self, it: &LabelIdentifier<'a>) {
		self.see(it.name.as_str());
	}
}

impl<'a> Visit<'a> for Walker<'a, '_, '_> {
	fn enter_node(&mut self, kind: AstKind<'a>) {
		// whether the node is an expression by its ESTree type's name
		let expression = match kind {
			AstKind::ParenthesizedExpression(_) => self.parents.last().copied().unwrap_or(false),
			AstKind::Class(class) => class.r#type == ClassType::ClassExpression,
			AstKind::Function(function) => function.r#type == FunctionType::FunctionExpression,
			AstKind::ArrayExpression(_)
			| AstKind::ArrowFunctionExpression(_)
			| AstKind::AssignmentExpression(_)
			| AstKind::AwaitExpression(_)
			| AstKind::BinaryExpression(_)
			| AstKind::CallExpression(_)
			| AstKind::ChainExpression(_)
			| AstKind::ComputedMemberExpression(_)
			| AstKind::ConditionalExpression(_)
			| AstKind::ExpressionStatement(_)
			| AstKind::ImportExpression(_)
			| AstKind::LogicalExpression(_)
			| AstKind::NewExpression(_)
			| AstKind::ObjectExpression(_)
			| AstKind::PrivateFieldExpression(_)
			| AstKind::PrivateInExpression(_)
			| AstKind::SequenceExpression(_)
			| AstKind::StaticMemberExpression(_)
			| AstKind::TaggedTemplateExpression(_)
			| AstKind::UnaryExpression(_)
			| AstKind::UpdateExpression(_)
			| AstKind::YieldExpression(_) => true,
			_ => false,
		};
		self.parents.push(expression);
	}

	fn leave_node(&mut self, _kind: AstKind<'a>) {
		self.parents.pop();
	}

	fn visit_expression(&mut self, e: &Expression<'a>) {
		if !self.rewriting {
			return walk::walk_expression(self, e);
		}
		let cx = std::mem::take(&mut self.cx);
		self.chain_out = false;
		match e {
			Expression::ParenthesizedExpression(p) => {
				// a parenthesis ends a chain, and is no place of its own
				self.cx = Cx {
					no_index: cx.no_index,
					continues: false,
					new_callee: false,
				};
				walk::walk_parenthesized_expression(self, p);
				self.chain_out = false;
			}
			Expression::Identifier(id) => self.identifier_read(id, cx),
			Expression::StaticMemberExpression(m) => self.member_read(Mem::Static(m), cx),
			Expression::ComputedMemberExpression(m) => self.member_read(Mem::Computed(m), cx),
			Expression::PrivateFieldExpression(m) => self.plain_member(Mem::Private(m), cx),
			Expression::CallExpression(c) => self.call(c, cx),
			Expression::NewExpression(n) => self.new_expression(n, cx),
			Expression::AssignmentExpression(a) => self.assignment(a),
			Expression::UpdateExpression(u) => self.update(u),
			Expression::BinaryExpression(b) => {
				// `key in o`: the helpers live on the window, where natively
				// nothing has their names, so the access API answers an `in`
				// whose key is one or may be one (any key but a literal)
				let left = unparen(&b.left);
				let asked = b.operator == BinaryOperator::In
					&& match left {
						Expression::StringLiteral(s) => {
							s.value.as_str().is_some_and(|key| self.options.config.is_helper_key(key))
						}
						left => !is_literal(left),
					};
				if !asked {
					return walk::walk_binary_expression(self, b);
				}
				let head = self.head(b.span.start, "has");
				self.wrap(b.span, head, ")".into());
				self.operand(&b.left);
				self.replace(b.left.span().end, b.right.span().start, ", ".into());
				self.operand(&b.right);
			}
			Expression::UnaryExpression(u) => {
				let argument = unparen(&u.argument);
				match u.operator {
					// `typeof top` must not throw in a worker
					UnaryOperator::Typeof if matches!(argument, Expression::Identifier(_)) => {}
					UnaryOperator::Delete if Mem::of(argument).is_some() => {
						if let Some(m) = Mem::of(argument) {
							self.plain_member(m, Cx::default());
						}
					}
					_ => walk::walk_unary_expression(self, u),
				}
			}
			Expression::TaggedTemplateExpression(t) => {
				self.cx = Cx {
					no_index: true,
					continues: false,
					new_callee: cx.new_callee,
				};
				self.under(true, |walker| walker.visit_expression(&t.tag));
				self.visit_template_literal(&t.quasi);
			}
			Expression::ImportExpression(i) => {
				if i.phase.is_some() {
					return self.decline(Decline::Shape);
				}
				let access = self.access();
				let base = if self.options.module {
					"import.meta.url".to_owned()
				} else {
					// a classic script resolves against its own URL, which
					// only the rewriter knows
					quote(&self.options.params.url)
				};
				let head = match &i.options {
					None => format!("{}{base}, ", self.head(i.span.start, "import")),
					// the options pick the route and the browser checks
					// them, so the import stays the page's own, given the
					// routed URL: the specifier first, then the options
					Some(_) => format!(
						"{}(s, o) => {access}.imported(import({access}.importRoute({base}, s, o), o)))(",
						self.open_paren(i.span.start)
					),
				};
				self.replace(i.span.start, i.source.span().start, head);
				let last = i.options.as_ref().unwrap_or(&i.source);
				self.replace(last.span().end, i.span.end, ")".into());
				// (neither is visited by the JavaScript rewriter)
				self.unvisited(|walker| {
					walker.visit_expression(&i.source);
					if let Some(options) = &i.options {
						walker.visit_expression(options);
					}
				});
			}
			Expression::V8IntrinsicExpression(_) => self.decline(Decline::Invalid),
			_ => walk::walk_expression(self, e),
		}
	}

	fn visit_chain_element(&mut self, it: &ChainElement<'a>) {
		if !self.rewriting {
			return walk::walk_chain_element(self, it);
		}
		let cx = Cx::default();
		self.cx = cx;
		match it {
			ChainElement::CallExpression(c) => self.call(c, cx),
			ChainElement::TSNonNullExpression(_) => self.decline(Decline::Shape),
			element => {
				let m = Mem::of_member(element.to_member_expression());
				if m.is_private() { self.plain_member(m, cx) } else { self.member_read(m, cx) }
			}
		}
		self.chain_out = false;
	}

	fn visit_member_expression(&mut self, it: &MemberExpression<'a>) {
		if !self.rewriting {
			return walk::walk_member_expression(self, it);
		}
		let cx = std::mem::take(&mut self.cx);
		let m = Mem::of_member(it);
		if m.is_private() { self.plain_member(m, cx) } else { self.member_read(m, cx) }
	}

	fn visit_arguments(&mut self, it: &oxc::allocator::Vec<'a, Argument<'a>>) {
		for argument in it {
			self.visit_argument(argument);
		}
	}

	fn visit_argument(&mut self, it: &Argument<'a>) {
		match it {
			Argument::SpreadElement(s) => self.spread(s, "args"),
			argument => {
				self.cx = Cx::default();
				self.visit_expression(argument.to_expression());
			}
		}
	}

	fn visit_array_expression_element(&mut self, it: &ArrayExpressionElement<'a>) {
		match it {
			ArrayExpressionElement::SpreadElement(s) => self.spread(s, "spread"),
			ArrayExpressionElement::Elision(_) => {}
			element => {
				self.cx = Cx::default();
				self.visit_expression(element.to_expression());
			}
		}
	}

	fn visit_spread_element(&mut self, it: &SpreadElement<'a>) {
		// an object's spread: read like any expression
		self.spread(it, "");
	}

	fn visit_property_key(&mut self, it: &PropertyKey<'a>) {
		let Some(key) = it.as_expression() else {
			return;
		};
		// a computed key that is a bare name is a property's to the
		// JavaScript rewriter, which leaves it
		if self.rewriting && matches!(unparen(key), Expression::Identifier(_)) {
			return;
		}
		self.cx = Cx::default();
		self.under(false, |walker| walker.visit_expression(key));
	}

	fn visit_object_property(&mut self, it: &ObjectProperty<'a>) {
		if it.method || it.kind != PropertyKind::Init {
			self.mark_method(it.span, &it.key, it.computed, false);
		}
		if self.rewriting && it.shorthand {
			// `{ location }` reads the value: written out, with the read
			if let Expression::Identifier(id) = &it.value {
				let name = id.name.as_str();
				if self.options.config.routes(name) {
					let access = self.access();
					self.wrap(
						id.span,
						format!("{name}: {access}.get("),
						format!(", {})", quote(name)),
					);
				}
				return;
			}
		}
		self.visit_property_key(&it.key);
		if it.method || it.kind != PropertyKind::Init {
			self.method_value = Some(it.value.span());
		}
		self.cx = Cx::default();
		self.under(false, |walker| walker.visit_expression(&it.value));
		self.method_value = None;
	}

	fn visit_method_definition(&mut self, it: &MethodDefinition<'a>) {
		// (a constructor's source is its class's)
		if it.kind != MethodDefinitionKind::Constructor {
			self.mark_method(it.span, &it.key, it.computed, it.r#static);
		}
		self.under(false, |walker| {
			walker.visit_decorators(&it.decorators);
			walker.visit_property_key(&it.key);
			walker.method_value = Some(it.value.span);
			walker.visit_function(&it.value, it.kind.scope_flags());
			walker.method_value = None;
		});
	}

	fn visit_function(&mut self, it: &Function<'a>, flags: ScopeFlags) {
		if self.method_value.take() != Some(it.span) {
			let at = self.first_token_end(it.span.start);
			self.mark(at, it.span);
		}
		self.functions += 1;
		match (&it.body, self.rewriting) {
			(Some(body), true) => {
				self.parents.push(false);
				let hoisted = self.hoist_parameters(&it.params);
				self.function_body(body, hoisted);
				self.parents.pop();
			}
			_ => walk::walk_function(self, it, flags),
		}
		self.functions -= 1;
	}

	fn visit_arrow_function_expression(&mut self, it: &ArrowFunctionExpression<'a>) {
		let at = self.first_token_end(it.span.start);
		self.mark(at, it.span);
		self.functions += 1;
		if self.rewriting {
			self.parents.push(false);
			let hoisted = self.hoist_parameters(&it.params);
			match &it.body {
				ArrowFunctionBody::FunctionBody(body) => self.function_body(body, hoisted),
				body => {
					let body = body.to_expression();
					self.cx = Cx::default();
					if hoisted.is_empty() {
						self.under(true, |walker| walker.visit_expression(body));
					} else {
						// the body becomes a block that returns it
						self.wrap(body.span(), format!("{{{hoisted}return "), ";}".into());
						self.under(false, |walker| walker.visit_expression(body));
					}
				}
			}
			self.parents.pop();
		} else {
			walk::walk_arrow_function_expression(self, it);
		}
		self.functions -= 1;
	}

	fn visit_class(&mut self, it: &Class<'a>) {
		let at = self
			.slice(it.span)
			.starts_with("class")
			.then(|| self.first_token_end(it.span.start))
			.flatten();
		self.mark(at, it.span);
		walk::walk_class(self, it);
	}

	fn visit_class_heritage(&mut self, it: &ClassHeritage<'a>) {
		// `extends top`: a bare name there is the class's to the JavaScript rewriter
		if self.rewriting && matches!(unparen(&it.expression), Expression::Identifier(_)) {
			return;
		}
		self.cx = Cx::default();
		self.visit_expression(&it.expression);
	}

	fn visit_static_block(&mut self, it: &StaticBlock<'a>) {
		self.functions += 1;
		walk::walk_static_block(self, it);
		self.functions -= 1;
	}

	fn visit_statements(&mut self, it: &oxc::allocator::Vec<'a, Statement<'a>>) {
		for statement in it {
			if let Statement::ExpressionStatement(statement) = statement {
				self.statement_start = Some(statement.span.start);
			}
			self.visit_statement(statement);
		}
	}

	fn visit_debugger_statement(&mut self, it: &DebuggerStatement) {
		// a proxied site's anti-debugging trap, not the user's breakpoint
		if self.rewriting {
			self.replace(it.span.start, it.span.end, ";".into());
		}
	}

	fn visit_variable_declaration(&mut self, it: &VariableDeclaration<'a>) {
		let place = std::mem::take(&mut self.var_place);
		if self.rewriting
			&& !self.options.module
			&& it.kind == VariableDeclarationKind::Var
			&& self.functions == 0
		{
			self.var_location(it, place);
		}
		walk::walk_variable_declaration(self, it);
	}

	fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
		let Some(init) = it.init.as_ref().filter(|_| self.rewriting) else {
			return walk::walk_variable_declarator(self, it);
		};
		// `const { top: t } = o`: the pattern reads `o.top` without a member
		// expression to rewrite, so the source is wrapped and the reads
		// resolve through it; a pattern whose source is a helper's value
		// checks it first, so an error names the page's expression
		let wrapped = if is_pattern_call(init, self.access()) {
			None
		} else {
			let spec = match &it.id {
				BindingPattern::ObjectPattern(pattern) => match self.shapes.binding_spec(pattern) {
					Ok(spec) => spec,
					Err(_) => {
						self.decline(Decline::Shape);
						None
					}
				},
				_ => None,
			};
			let text = || quote(self.slice(it.span));
			match (&it.id, spec) {
				(_, Some(spec)) => Some((
					"pattern",
					format!(", {}, {})", spec_text(&spec, &|key| quote(key)), text()),
				)),
				(BindingPattern::ArrayPattern(_), None) if self.shapes.prints_helper(init) => Some((
					"iter",
					format!(", \"array\", {})", quote(self.slice(inner_span(init)))),
				)),
				(BindingPattern::ObjectPattern(_), None) if self.shapes.prints_helper(init) => {
					Some(("coerce", format!(", {})", text())))
				}
				_ => None,
			}
		};
		let Some((name, after)) = wrapped else {
			return walk::walk_variable_declarator(self, it);
		};
		// (the pattern of a declaration given a source is not visited)
		self.unvisited(|walker| walker.visit_binding_pattern(&it.id));
		let head = self.head(init.span().start, name);
		self.wrap(init.span(), head, after);
		self.operand(init);
	}

	fn visit_for_statement(&mut self, it: &ForStatement<'a>) {
		if matches!(it.init, Some(ForStatementInit::VariableDeclaration(_))) {
			self.var_place = VarPlace::ForInit;
		}
		walk::walk_for_statement(self, it);
	}

	fn visit_for_in_statement(&mut self, it: &ForInStatement<'a>) {
		if !self.rewriting {
			return walk::walk_for_in_statement(self, it);
		}
		self.under(false, |walker| {
			walker.var_place = VarPlace::Loop;
			walker.visit_for_statement_left(&it.left);
			walker.var_place = VarPlace::Statement;
			let assignments = std::mem::take(&mut walker.loop_assignments);
			walker.cx = Cx::default();
			walker.visit_expression(&it.right);
			if !assignments.is_empty() {
				walker.wrap(it.body.span(), format!("{{{assignments}"), "}".into());
			}
			walker.visit_statement(&it.body);
		});
	}

	fn visit_for_of_statement(&mut self, it: &ForOfStatement<'a>) {
		if !self.rewriting {
			return walk::walk_for_of_statement(self, it);
		}
		self.under(false, |walker| {
			walker.var_place = VarPlace::Loop;
			walker.visit_for_statement_left(&it.left);
			walker.var_place = VarPlace::Statement;
			let assignments = std::mem::take(&mut walker.loop_assignments);
			if !it.r#await && walker.shapes.prints_helper(&it.right) {
				let head = walker.head(it.right.span().start, "iter");
				let source = quote(walker.slice(inner_span(&it.right)));
				walker.wrap(it.right.span(), head, format!(", \"of\", {source})"));
				walker.operand(&it.right);
			} else {
				walker.cx = Cx::default();
				walker.visit_expression(&it.right);
			}
			if !assignments.is_empty() {
				walker.wrap(it.body.span(), format!("{{{assignments}"), "}".into());
			}
			walker.visit_statement(&it.body);
		});
	}

	fn visit_simple_assignment_target(&mut self, it: &SimpleAssignmentTarget<'a>) {
		// reached only for a pattern's target or a loop head's: a plain
		// assignment's and an update's are their expressions' to decide
		if self.rewriting {
			self.pattern_target(it);
		} else {
			walk::walk_simple_assignment_target(self, it);
		}
	}

	fn visit_assignment_target_property_identifier(
		&mut self,
		it: &AssignmentTargetPropertyIdentifier<'a>,
	) {
		if self.rewriting && it.binding.name == "location" {
			// `({ location } = o)`: written out, with the reference
			let text = format!("location: {}", self.ref1(0));
			self.replace(it.binding.span.start, it.binding.span.end, text);
		}
		if let Some(init) = &it.init {
			self.cx = Cx::default();
			self.under(false, |walker| walker.visit_expression(init));
		}
	}

	fn visit_export_specifier(&mut self, _it: &ExportSpecifier<'a>) {}

	fn visit_import_declaration(&mut self, it: &ImportDeclaration<'a>) {
		if it.phase.is_some() {
			return self.decline(Decline::Shape);
		}
		self.route_source(&it.source, it.with_clause.as_deref());
	}

	fn visit_export_all_declaration(&mut self, it: &ExportAllDeclaration<'a>) {
		self.route_source(&it.source, it.with_clause.as_deref());
	}

	fn visit_export_from_declaration(&mut self, it: &ExportFromDeclaration<'a>) {
		self.route_source(&it.source, it.with_clause.as_deref());
	}
}
