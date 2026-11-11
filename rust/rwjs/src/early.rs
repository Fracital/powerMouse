//! Early errors: what a browser refuses to compile though it parses. The
//! parser reports none of them (its crate leaves them to a semantic pass
//! that costs a quarter of the artifact and refuses Annex B scripts a
//! browser takes), so a script V8 answers with a SyntaxError would be
//! rewritten, and where the rewrite replaces the construct (`delete
//! location` in strict code) it would run. This is the one walk that finds
//! them, by the clauses of ECMA-262 as V8 reads them, held to V8's verdicts
//! on rust/host/early-errors.txt.
//!
//! It errs to one side only: what it reports V8 refuses. What it misses is
//! rewritten and refused by the browser all the same, since the rewrite
//! keeps the construct, and rust/host/early.mjs names every such text.
use oxc::ast::ast::*;
use oxc::ast_visit::{Visit, walk};
use oxc::syntax::scope::ScopeFlags;

/// What the text is, as far as the caller knows
#[derive(Clone, Copy)]
pub struct Mode {
	pub module: bool,
	/// the text may be a function's body (a handler attribute) or the code
	/// of a direct eval: `super`, a private name and `using` may stand at
	/// its top level, as they may there
	pub lenient: bool,
	/// `return` may stand at its top level
	pub top_return: bool,
}

/// What V8 makes of a text that parses
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
	Compiles,
	/// an early error
	Refused,
	/// syntax no browser has yet (decorators, `accessor` fields,
	/// `import.defer()`): V8 refuses it today. It is no early error to act
	/// on, though: the day a browser takes it, a script handed back as it
	/// was would run unrewritten
	Unshipped,
}

/// V8's verdict on `program` (the parse of `source`)
pub fn check<'a>(program: &Program<'a>, source: &str, mode: Mode) -> Verdict {
	let mut checker = Checker::new(source, mode);
	checker.visit_program(program);
	checker.verdict()
}



/// What the code around a node allows, replaced at a function's border
#[derive(Clone, Copy)]
struct Cx {
	strict: bool,
	/// `yield` is the operator here (a generator's parameters and body), so
	/// no name
	yield_kw: bool,
	/// `await` is the operator here (an async function, a static block), so
	/// no name
	await_kw: bool,
	/// in a parameter list: no `yield` or `await` expression
	in_params: bool,
	/// in a field's initializer or a static block: no `yield` or `await`
	/// expression, no `for await`, no `await using`
	no_await: bool,
	/// in a field's initializer or a static block, through arrows: no
	/// `arguments`
	no_arguments: bool,
	super_property: bool,
	super_call: bool,
	returns: bool,
	/// where this function's labels start in `labels`
	label_base: u32,
	loops: u32,
	/// loops and switches
	breakables: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
	/// `var`, and a function declared at the top of a script or a function
	Var,
	Param,
	/// `let`, `const`, `using`: lexical, and never the name `let`
	Let,
	/// a class, an import, a function declared at a module's top, a
	/// generator or async function in a block, a catch clause's pattern
	Lexical,
	/// a plain function in a block: sloppy code may declare it twice
	BlockFunction,
	/// `catch (name)`: a `var` of its block may share the name
	CatchSimple,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ScopeKind {
	/// a script's top, a function, a static block: `var` stops here, and a
	/// function declared at its top is a `var`
	Function,
	/// a module's top: `var` stops here, a function declared is lexical
	Module,
	Block,
	Switch,
}

struct Scope {
	kind: ScopeKind,
	/// where its names start in `names`
	names: u32,
	/// the depth of the scope its `var`s belong to
	function: u32,
}

/// A declaration of one name in one open scope: a name's are a list,
/// innermost first
#[derive(Clone, Copy)]
struct Node {
	depth: u32,
	kind: Kind,
	/// the next outer one's index and one, 0 at the end
	next: u32,
}

/// The names declared so far, each with a number. A name of one ASCII
/// character (most of a minified script's) is found by its byte; any other
/// by open addressing over its hash, a slot holding the hash and the number,
/// the name compared only where the hashes are equal. Nothing is removed.
struct Table<'a> {
	/// by an ASCII byte: the number of that one-character name and one, 0
	/// when it was never declared
	ascii: [u32; 128],
	/// the hash in the high half, the number and one in the low, 0 empty
	slots: Vec<u64>,
	/// by number: the name
	names: Vec<&'a str>,
	/// the slots in use
	used: u32,
}

fn hash(name: &str) -> u32 {
	let mut hash: u32 = 0x811c_9dc5;
	for byte in name.bytes() {
		hash = (hash ^ u32::from(byte)).wrapping_mul(0x0100_0193);
	}
	hash
}

impl<'a> Table<'a> {
	fn new() -> Self {
		Self {
			ascii: [0; 128],
			slots: vec![0; 64],
			names: Vec::new(),
			used: 0,
		}
	}

	/// the slot of `name` (whose hash is `hash`): its own, or the empty one
	/// it would take
	fn find(&self, name: &str, hash: u32) -> usize {
		let mask = self.slots.len() - 1;
		let mut at = hash as usize & mask;
		loop {
			let slot = self.slots[at];
			if slot == 0 || ((slot >> 32) as u32 == hash && self.names[(slot as u32 - 1) as usize] == name) {
				return at;
			}
			at = (at + 1) & mask;
		}
	}

	/// the number of `name`, if it was ever declared
	fn get(&self, name: &str) -> Option<u32> {
		if let [byte] = name.as_bytes()
			&& *byte < 0x80
		{
			let id = self.ascii[*byte as usize];
			return (id != 0).then(|| id - 1);
		}
		let slot = self.slots[self.find(name, hash(name))];
		(slot != 0).then(|| slot as u32 - 1)
	}

	/// the number of `name`, a new one the first time
	fn id(&mut self, name: &'a str) -> u32 {
		if let [byte] = name.as_bytes()
			&& *byte < 0x80
		{
			let at = *byte as usize;
			if self.ascii[at] == 0 {
				self.names.push(name);
				self.ascii[at] = self.names.len() as u32;
			}
			return self.ascii[at] - 1;
		}
		let hash = hash(name);
		let mut at = self.find(name, hash);
		if self.slots[at] == 0 {
			if (self.used as usize + 1) * 2 > self.slots.len() {
				let wider = vec![0; self.slots.len() * 2];
				let old = std::mem::replace(&mut self.slots, wider);
				let mask = self.slots.len() - 1;
				for slot in old {
					if slot != 0 {
						let mut to = (slot >> 32) as usize & mask;
						while self.slots[to] != 0 {
							to = (to + 1) & mask;
						}
						self.slots[to] = slot;
					}
				}
				at = self.find(name, hash);
			}
			self.names.push(name);
			self.slots[at] = (u64::from(hash) << 32) | self.names.len() as u64;
			self.used += 1;
		}
		(self.slots[at] as u32) - 1
	}
}

struct Private<'a> {
	name: &'a str,
	is_static: bool,
	/// 1 a getter, 2 a setter, 0 anything else
	accessors: u8,
}

/// what a hook hands back to be handed to the one that closes its node
#[derive(Clone, Copy)]
pub(crate) struct Saved {
	cx: Cx,
	/// the hook ran (it was not muted)
	live: bool,
}

/// what `class_body_enter` hands `class_leave`
#[derive(Clone, Copy)]
pub(crate) struct ClassBody {
	privates: usize,
	uses: usize,
	live: bool,
}

pub(crate) struct Checker<'a, 's> {
	source: &'s [u8],
	mode: Mode,
	error: bool,
	unshipped: bool,
	/// inside code the check does not read (`mute`)
	muted: u32,
	cx: Cx,
	/// the labels around the node, and whether each one labels a loop
	labels: Vec<(&'a str, bool)>,
	scopes: Vec<Scope>,
	/// one entry a node of the open scopes, a scope's in a run: the name's
	/// number
	names: Vec<u32>,
	/// (the `var`s a closing scope hands its parent)
	hoisted: Vec<u32>,
	nodes: Vec<Node>,
	/// the free nodes' list
	free: u32,
	table: Table<'a>,
	/// by a name's number: the head of its list in `nodes` and one, 0 when
	/// no open scope declares it
	heads: Vec<u32>,
	duplicate_param: bool,
	/// the declaration visited next is `export default`'s: it needs no name
	default_export: bool,
	/// the local names `export { }` lists
	exports: Vec<&'a str>,
	/// the open classes' private names, a class's in a run
	privates: Vec<Private<'a>>,
	/// the private names used and not declared by a class closed so far
	private_uses: Vec<&'a str>,
	/// the open classes: whether each extends another
	classes: Vec<bool>,
	/// the `__proto__: value` properties of the object literal being walked
	protos: u32,
}


fn strict_directive(directives: &[Directive]) -> bool {
	directives.iter().any(|directive| directive.directive == "use strict")
}

/// a function behind labels (`l: function f() {}`)
fn labelled_function(statement: &Statement) -> bool {
	let Statement::LabeledStatement(labelled) = statement else {
		return false;
	};
	let mut body = &labelled.body;
	loop {
		match body {
			Statement::LabeledStatement(inner) => body = &inner.body,
			Statement::FunctionDeclaration(_) => return true,
			_ => return false,
		}
	}
}

impl<'a, 's> Checker<'a, 's> {
	fn fail(&mut self) {
		self.error = true;
	}

	fn enter(&mut self, kind: ScopeKind) {
		let depth = self.scopes.len() as u32;
		let function = match (kind, self.scopes.last()) {
			(ScopeKind::Block | ScopeKind::Switch, Some(parent)) => parent.function,
			_ => depth,
		};
		self.scopes.push(Scope {
			kind,
			names: self.names.len() as u32,
			function,
		});
	}

	fn push(&mut self, id: u32, depth: u32, kind: Kind) {
		let node = Node {
			depth,
			kind,
			next: self.heads[id as usize],
		};
		let at = if self.free == 0 {
			self.nodes.push(node);
			self.nodes.len() as u32
		} else {
			let at = self.free;
			self.free = self.nodes[at as usize - 1].next;
			self.nodes[at as usize - 1] = node;
			at
		};
		self.heads[id as usize] = at;
		self.names.push(id);
	}

	/// the scope closes: its names end, and its `var`s are its parent's too
	/// up to the function's scope (`{ { var a } let a }`)
	fn leave(&mut self) {
		let Some(scope) = self.scopes.pop() else {
			return;
		};
		let depth = self.scopes.len() as u32;
		let hoists = depth > scope.function;
		for at in (scope.names as usize..self.names.len()).rev() {
			let id = self.names[at];
			let head = self.heads[id as usize];
			if head == 0 {
				continue;
			}
			let node = self.nodes[head as usize - 1];
			self.heads[id as usize] = node.next;
			self.nodes[head as usize - 1].next = self.free;
			self.free = head;
			if hoists && node.kind == Kind::Var {
				self.hoisted.push(id);
			}
		}
		self.names.truncate(scope.names as usize);
		while let Some(id) = self.hoisted.pop() {
			let head = self.heads[id as usize];
			let covered = head != 0 && {
				let node = self.nodes[head as usize - 1];
				node.depth == depth - 1 && matches!(node.kind, Kind::Var | Kind::Param)
			};
			if !covered {
				self.push(id, depth - 1, Kind::Var);
			}
		}
	}

	/// `name` is declared in the scope the node is in
	fn declare(&mut self, name: &'a str, kind: Kind) {
		let Some(scope) = self.scopes.last() else {
			return;
		};
		let depth = self.scopes.len() as u32 - 1;
		let floor = scope.function;
		let id = self.table.id(name);
		if id as usize == self.heads.len() {
			self.heads.push(0);
		}
		let head = self.heads[id as usize];
		let top = (head != 0).then(|| self.nodes[head as usize - 1]);
		match kind {
			Kind::Var => {
				// (declared here already by a `var` or a parameter: whatever
				// lexical name stands between here and the function failed
				// that declaration, and none can have come since)
				if top.is_some_and(|top| top.depth == depth && matches!(top.kind, Kind::Var | Kind::Param)) {
					return;
				}
				// against every lexical name between here and the function
				let mut at = head;
				while at != 0 {
					let node = self.nodes[at as usize - 1];
					if node.depth < floor {
						break;
					}
					if matches!(node.kind, Kind::Lexical | Kind::BlockFunction) {
						return self.fail();
					}
					at = node.next;
				}
				self.push(id, depth, Kind::Var);
			}
			Kind::Param => {
				if top.is_some_and(|top| top.depth == depth) {
					self.duplicate_param = true;
				} else {
					self.push(id, depth, Kind::Param);
				}
			}
			Kind::CatchSimple => self.push(id, depth, Kind::CatchSimple),
			Kind::Let | Kind::Lexical | Kind::BlockFunction => {
				if kind == Kind::Let && name == "let" {
					return self.fail();
				}
				let kind = if kind == Kind::Let { Kind::Lexical } else { kind };
				if let Some(top) = top
					&& top.depth == depth
				{
					// Annex B.3.2.4: a block's plain functions may share a
					// name in sloppy code
					if top.kind == Kind::BlockFunction && kind == Kind::BlockFunction && !self.cx.strict {
						return;
					}
					return self.fail();
				}
				self.push(id, depth, kind);
			}
		}
	}

	fn declare_pattern(&mut self, pattern: &BindingPattern<'a>, kind: Kind) {
		match pattern {
			BindingPattern::BindingIdentifier(id) => self.declare(id.name.as_str(), kind),
			BindingPattern::ObjectPattern(object) => {
				for property in &object.properties {
					self.declare_pattern(&property.value, kind);
				}
				if let Some(rest) = &object.rest {
					self.declare_pattern(&rest.argument, kind);
				}
			}
			BindingPattern::ArrayPattern(array) => {
				for element in array.elements.iter().flatten() {
					self.declare_pattern(element, kind);
				}
				if let Some(rest) = &array.rest {
					self.declare_pattern(&rest.argument, kind);
				}
			}
			BindingPattern::AssignmentPattern(assignment) => self.declare_pattern(&assignment.left, kind),
		}
	}

	/// a name where an identifier stands: a reference, a binding, a label
	#[inline]
	fn name(&mut self, name: &str, binding: bool) {
		// (the names below are 3 to 10 bytes and start with one of
		// `aeilpsy`: most names are neither)
		if (3..=10).contains(&name.len())
			&& matches!(name.as_bytes()[0], b'a' | b'e' | b'i' | b'l' | b'p' | b's' | b'y')
		{
			self.reserved(name, binding);
		}
	}

	#[inline(never)]
	fn reserved(&mut self, name: &str, binding: bool) {
		let refused = match name {
			"implements" | "interface" | "let" | "package" | "private" | "protected" | "public" | "static" => {
				self.cx.strict
			}
			"yield" => self.cx.strict || self.cx.yield_kw,
			"await" => self.mode.module || self.cx.await_kw,
			"arguments" => self.cx.no_arguments || (binding && self.cx.strict),
			"eval" => binding && self.cx.strict,
			_ => false,
		};
		if refused {
			self.fail();
		}
	}

	/// a name assigned to
	fn target(&mut self, name: &str) {
		if self.cx.strict && (name == "eval" || name == "arguments") {
			self.fail();
		}
	}

	/// a string literal as written, in strict code: no octal escape, no
	/// `\8` or `\9`
	fn string(&mut self, span: oxc::span::Span) {
		let raw = &self.source[span.start as usize..span.end as usize];
		let mut at = 0;
		while let Some(found) = raw[at..].iter().position(|byte| *byte == b'\\') {
			let escaped = at + found + 1;
			match raw.get(escaped) {
				Some(b'1'..=b'9') => return self.fail(),
				Some(b'0') if raw.get(escaped + 1).is_some_and(u8::is_ascii_digit) => return self.fail(),
				_ => {}
			}
			at = escaped + 1;
			if at >= raw.len() {
				break;
			}
		}
	}

	fn directives(&mut self, directives: &[Directive<'a>]) {
		if self.cx.strict {
			for directive in directives {
				self.string(directive.expression.span);
			}
		}
	}

	/// a parameter list, its names the function scope's: whether it is a
	/// simple one (names alone)
	/// a checker for `source` (the text `program` was parsed from)
	pub(crate) fn new(source: &'s str, mode: Mode) -> Self {
		Self {
			source: source.as_bytes(),
			mode,
			error: false,
			unshipped: false,
			muted: 0,
			cx: Cx {
				strict: false,
				yield_kw: false,
				await_kw: false,
				in_params: false,
				no_await: false,
				no_arguments: false,
				super_property: mode.lenient,
				super_call: mode.lenient,
				returns: mode.top_return,
				label_base: 0,
				loops: 0,
				breakables: 0,
			},
			labels: Vec::new(),
			scopes: Vec::new(),
			names: Vec::new(),
			hoisted: Vec::new(),
			nodes: Vec::new(),
			free: 0,
			table: Table::new(),
			heads: Vec::new(),
			duplicate_param: false,
			default_export: false,
			exports: Vec::new(),
			privates: Vec::new(),
			private_uses: Vec::new(),
			classes: Vec::new(),
			protos: 0,
		}
	}

	/// what V8 makes of the text, from what was seen of it
	pub(crate) fn verdict(&self) -> Verdict {
		if self.error {
			Verdict::Refused
		} else if self.unshipped {
			Verdict::Unshipped
		} else {
			Verdict::Compiles
		}
	}

	/// what follows is no code the check reads (a decorator's, an
	/// `accessor` field's: what no browser has yet), until `unmute`
	pub(crate) fn mute(&mut self) {
		self.muted += 1;
	}

	pub(crate) fn unmute(&mut self) {
		self.muted -= 1;
	}

	fn on(&self) -> bool {
		self.muted == 0
	}

	// ---- the hooks: what a walk calls where it meets a node, in the order
	// the walk of this module (the Visit impl below) calls them ----

	pub(crate) fn program_enter(&mut self, it: &Program<'a>) {
		self.cx.strict = self.mode.module || strict_directive(&it.directives);
		self.enter(if self.mode.module { ScopeKind::Module } else { ScopeKind::Function });
		self.directives(&it.directives);
	}

	pub(crate) fn program_leave(&mut self) {
		// what a module exports by name it declares
		while let Some(name) = self.exports.pop() {
			if self.table.get(name).is_none_or(|id| self.heads[id as usize] == 0) {
				self.fail();
			}
		}
		if !self.private_uses.is_empty() && !self.mode.lenient {
			self.fail();
		}
		self.leave();
	}

	/// an identifier read (`IdentifierReference`)
	#[inline]
	pub(crate) fn reference(&mut self, name: &str) {
		if self.on() {
			self.name(name, false);
		}
	}

	/// an identifier declared (`BindingIdentifier`)
	#[inline]
	pub(crate) fn binding(&mut self, name: &str) {
		if self.on() {
			self.name(name, true);
		}
	}

	/// an identifier assigned to: also a reference
	pub(crate) fn assigned(&mut self, name: &str) {
		if self.on() {
			self.target(name);
			self.name(name, false);
		}
	}

	pub(crate) fn private_use(&mut self, name: &'a str) {
		if self.on() {
			self.private_uses.push(name);
		}
	}

	#[inline]
	pub(crate) fn numeric(&mut self, it: &NumericLiteral<'a>) {
		// `010`, `08`: legacy octal and its decimal look-alike
		let start = it.span.start as usize;
		if self.on()
			&& self.cx.strict
			&& it.span.end as usize > start + 1
			&& self.source[start] == b'0'
			&& self.source[start + 1].is_ascii_digit()
		{
			self.fail();
		}
	}

	#[inline]
	pub(crate) fn string_literal(&mut self, it: &StringLiteral<'a>) {
		// (a literal as long as its value has no escape to read)
		if self.on() && self.cx.strict && it.span.size() as usize != it.value.as_bytes().len() + 2 {
			self.string(it.span);
		}
	}

	#[inline]
	pub(crate) fn unary(&mut self, it: &UnaryExpression<'a>) {
		if it.operator == UnaryOperator::Delete {
			self.delete(it);
		}
	}

	#[inline(never)]
	fn delete(&mut self, it: &UnaryExpression<'a>) {
		if !self.on() {
			return;
		}
		let mut argument = &it.argument;
		while let Expression::ParenthesizedExpression(inner) = argument {
			argument = &inner.expression;
		}
		let refused = match argument {
			Expression::Identifier(_) => self.cx.strict,
			Expression::PrivateFieldExpression(_) => true,
			Expression::ChainExpression(chain) => {
				matches!(chain.expression, ChainElement::PrivateFieldExpression(_))
			}
			_ => false,
		};
		if refused {
			self.fail();
		}
	}

	pub(crate) fn binary(&mut self, it: &BinaryExpression<'a>) {
		// `a <!--b` is `a < !--b` to the parser, and an HTML comment to V8:
		// a module's error
		if self.on()
			&& self.mode.module
			&& it.operator == BinaryOperator::LessThan
			&& let Expression::UnaryExpression(not) = &it.right
			&& not.operator == UnaryOperator::LogicalNot
		{
			let at = not.span.start as usize;
			if at > 0 && self.source[at - 1] == b'<' && self.source[at + 1..].starts_with(b"--") {
				self.fail();
			}
		}
	}

	/// `super(...)`: its callee is not visited
	pub(crate) fn super_call(&mut self) {
		if self.on() && !self.cx.super_call {
			self.fail();
		}
	}

	/// `super` as a member's object
	pub(crate) fn super_property(&mut self) {
		if self.on() && !self.cx.super_property {
			self.fail();
		}
	}

	/// `await`, `yield`
	pub(crate) fn operator(&mut self) {
		if self.on() && (self.cx.in_params || self.cx.no_await) {
			self.fail();
		}
	}

	/// an object literal, before its properties (`property` for each,
	/// then `object_leave` with what this answered)
	#[inline]
	pub(crate) fn object_enter(&mut self) -> u32 {
		std::mem::replace(&mut self.protos, 0)
	}

	/// a property of an object literal: `__proto__: value` once an object
	/// (a pattern is no ObjectExpression)
	#[inline]
	pub(crate) fn property(&mut self, property: &ObjectProperty<'a>) {
		if property.kind == PropertyKind::Init && !property.computed && !property.shorthand && !property.method {
			let proto = match &property.key {
				PropertyKey::StaticIdentifier(id) => id.name == "__proto__",
				PropertyKey::StringLiteral(string) => string.value.as_str() == Some("__proto__"),
				_ => false,
			};
			if proto {
				self.protos += 1;
			}
		}
	}

	pub(crate) fn object_leave(&mut self, around: u32) {
		if self.protos > 1 && self.on() {
			self.fail();
		}
		self.protos = around;
	}

	/// syntax no browser has yet (a decorator)
	pub(crate) fn unshipped(&mut self) {
		if self.on() {
			self.unshipped = true;
		}
	}

	pub(crate) fn import_expression(&mut self, it: &ImportExpression<'a>) {
		if it.phase == Some(ImportPhase::Defer) {
			self.unshipped();
		}
	}

	// functions: `function_enter`, then for each parameter `param` (or
	// `rest_param`) and its walk, then `params_leave`, the body's
	// statements, `function_leave`

	/// a function that is no arrow; `method` when it is a method's (whether
	/// it may call `super`)
	pub(crate) fn function_enter(&mut self, it: &Function<'a>, method: Option<bool>) -> Saved {
		let saved = Saved { cx: self.cx, live: self.on() };
		if !saved.live {
			return saved;
		}
		self.default_export = false;
		// (one with no body is no JavaScript)
		if it.body.is_none() {
			self.fail();
		}
		let own = it.body.as_ref().is_some_and(|body| strict_directive(&body.directives));
		let strict = self.cx.strict || own;
		let declaration = it.r#type == FunctionType::FunctionDeclaration;
		if declaration && let Some(id) = &it.id {
			let name = id.name.as_str();
			let kind = match self.scopes.last().map(|scope| scope.kind) {
				Some(ScopeKind::Function) | None => Kind::Var,
				Some(ScopeKind::Module) => Kind::Lexical,
				Some(ScopeKind::Block | ScopeKind::Switch) => {
					if it.generator || it.r#async {
						Kind::Lexical
					} else {
						Kind::BlockFunction
					}
				}
			};
			self.declare(name, kind);
			// the name is the code's around the function, read under the
			// function's own strictness too
			let around = self.cx.strict;
			self.cx.strict = strict;
			self.name(name, true);
			self.cx.strict = around;
		}
		self.cx = Cx {
			strict,
			yield_kw: it.generator,
			await_kw: it.r#async,
			in_params: true,
			no_await: false,
			no_arguments: false,
			super_property: method.is_some(),
			super_call: method == Some(true),
			returns: true,
			label_base: self.labels.len() as u32,
			loops: 0,
			breakables: 0,
		};
		if !declaration && let Some(id) = &it.id {
			// a function expression's name is its own code's
			self.name(id.name.as_str(), true);
		}
		self.enter(ScopeKind::Function);
		self.duplicate_param = false;
		saved
	}

	/// a parameter, before its walk: its names are the function scope's
	pub(crate) fn param(&mut self, param: &FormalParameter<'a>) {
		if self.on() {
			if !param.decorators.is_empty() {
				self.unshipped = true;
			}
			self.declare_pattern(&param.pattern, Kind::Param);
		}
	}

	pub(crate) fn rest_param(&mut self, rest: &BindingRestElement<'a>) {
		if self.on() {
			self.declare_pattern(&rest.argument, Kind::Param);
		}
	}

	/// the parameters walked: `unique` when no name may be there twice (a
	/// method's, an arrow's), and the body's directives
	pub(crate) fn params_leave(&mut self, params: &FormalParameters<'a>, unique: bool, directives: &[Directive<'a>]) {
		if !self.on() {
			return;
		}
		let simple = params.rest.is_none()
			&& params.items.iter().all(|param| {
				param.initializer.is_none() && matches!(param.pattern, BindingPattern::BindingIdentifier(_))
			});
		if self.duplicate_param && (unique || !simple || self.cx.strict) {
			self.fail();
		}
		if strict_directive(directives) && !simple {
			self.fail();
		}
		self.cx.in_params = false;
		self.directives(directives);
	}

	pub(crate) fn function_leave(&mut self, saved: Saved) {
		if saved.live {
			self.leave();
			self.cx = saved.cx;
		}
	}

	/// an arrow, before its parameters (then `param`, `params_leave` with
	/// `arrow_body`, the body, `function_leave`)
	pub(crate) fn arrow_enter(&mut self, it: &ArrowFunctionExpression<'a>) -> Saved {
		let saved = Saved { cx: self.cx, live: self.on() };
		if !saved.live {
			return saved;
		}
		let own = match &it.body {
			ArrowFunctionBody::FunctionBody(body) => strict_directive(&body.directives),
			_ => false,
		};
		// its parameters are read as the code around it is; its body is its own
		self.cx = Cx {
			strict: saved.cx.strict || own,
			await_kw: saved.cx.await_kw || it.r#async,
			in_params: true,
			no_await: false,
			returns: true,
			label_base: self.labels.len() as u32,
			loops: 0,
			breakables: 0,
			..saved.cx
		};
		self.enter(ScopeKind::Function);
		self.duplicate_param = false;
		saved
	}

	/// an arrow's parameters walked (`params_leave` for an arrow)
	pub(crate) fn arrow_params_leave(&mut self, it: &ArrowFunctionExpression<'a>) {
		if !self.on() {
			return;
		}
		let directives = match &it.body {
			ArrowFunctionBody::FunctionBody(body) => &body.directives[..],
			_ => &[],
		};
		let simple = it.params.rest.is_none()
			&& it.params.items.iter().all(|param| {
				param.initializer.is_none() && matches!(param.pattern, BindingPattern::BindingIdentifier(_))
			});
		if self.duplicate_param {
			self.fail();
		}
		if strict_directive(directives) && !simple {
			self.fail();
		}
		self.cx.in_params = false;
		self.cx.yield_kw = false;
		self.cx.await_kw = it.r#async;
		self.directives(directives);
	}

	// classes: `class_enter`, the walk of its id and heritage,
	// `class_body_enter`, the walk of its elements (`method` before a
	// method's function, `field_enter`/`field_leave` around a field's value,
	// `static_enter`/`static_leave` around a static block), `class_leave`

	pub(crate) fn class_enter(&mut self, it: &Class<'a>) -> Saved {
		let saved = Saved { cx: self.cx, live: self.on() };
		if !saved.live {
			return saved;
		}
		let anonymous_allowed = std::mem::take(&mut self.default_export);
		if !it.decorators.is_empty() {
			self.unshipped = true;
		}
		let declaration = it.r#type == ClassType::ClassDeclaration;
		match &it.id {
			Some(id) => {
				if declaration {
					self.declare(id.name.as_str(), Kind::Lexical);
				}
				self.cx.strict = true;
				self.name(id.name.as_str(), true);
			}
			None => {
				if declaration && !anonymous_allowed {
					self.fail();
				}
			}
		}
		// all of a class is strict code
		self.cx.strict = true;
		saved
	}

	/// the class's elements, after its heritage: its private names
	/// declared (what the heritage uses is the code's around the class)
	pub(crate) fn class_body_enter(&mut self, it: &Class<'a>) -> ClassBody {
		let body = ClassBody {
			privates: self.privates.len(),
			uses: self.private_uses.len(),
			live: self.on(),
		};
		if !body.live {
			return body;
		}
		let mut constructors = 0;
		for element in &it.body.body {
			match element {
				ClassElement::MethodDefinition(method) => {
					let accessor = match method.kind {
						MethodDefinitionKind::Get => 1,
						MethodDefinitionKind::Set => 2,
						_ => 0,
					};
					self.private(body.privates, &method.key, method.r#static, accessor);
					if !method.decorators.is_empty() {
						self.unshipped = true;
					}
					if method.kind == MethodDefinitionKind::Constructor {
						constructors += 1;
					}
				}
				ClassElement::PropertyDefinition(property) => {
					self.private(body.privates, &property.key, property.r#static, 0);
					if !property.decorators.is_empty() {
						self.unshipped = true;
					}
				}
				ClassElement::AccessorProperty(_) => self.unshipped = true,
				ClassElement::TSIndexSignature(_) => self.fail(),
				ClassElement::StaticBlock(_) => {}
			}
		}
		if constructors > 1 {
			self.fail();
		}
		self.classes.push(it.heritage.is_some());
		body
	}

	/// a class method's function is next: what `function_enter` is told
	/// of it (whether it may call `super`)
	pub(crate) fn method(&self, method: &MethodDefinition<'a>) -> Option<bool> {
		let derived = self.classes.last().copied().unwrap_or(false);
		Some(method.kind == MethodDefinitionKind::Constructor && derived)
	}

	/// a field's initializer
	pub(crate) fn field_enter(&mut self) -> Saved {
		let saved = Saved { cx: self.cx, live: self.on() };
		if saved.live {
			self.cx = Cx {
				strict: true,
				yield_kw: false,
				await_kw: false,
				in_params: false,
				no_await: true,
				no_arguments: true,
				super_property: true,
				super_call: false,
				returns: false,
				label_base: self.labels.len() as u32,
				loops: 0,
				breakables: 0,
			};
		}
		saved
	}

	pub(crate) fn field_leave(&mut self, saved: Saved) {
		if saved.live {
			self.cx = saved.cx;
		}
	}

	pub(crate) fn static_enter(&mut self) -> Saved {
		let saved = Saved { cx: self.cx, live: self.on() };
		if saved.live {
			self.cx = Cx {
				strict: true,
				yield_kw: false,
				await_kw: true,
				in_params: false,
				no_await: true,
				no_arguments: true,
				super_property: true,
				super_call: false,
				returns: false,
				label_base: self.labels.len() as u32,
				loops: 0,
				breakables: 0,
			};
			self.enter(ScopeKind::Function);
		}
		saved
	}

	pub(crate) fn static_leave(&mut self, saved: Saved) {
		if saved.live {
			self.leave();
			self.cx = saved.cx;
		}
	}

	pub(crate) fn class_leave(&mut self, body: ClassBody, saved: Saved) {
		if body.live {
			self.classes.pop();
			// a private name used is one of this class's or of a class
			// around it
			let mut kept = body.uses;
			for at in body.uses..self.private_uses.len() {
				let name = self.private_uses[at];
				if !self.privates[body.privates..].iter().any(|private| private.name == name) {
					self.private_uses[kept] = name;
					kept += 1;
				}
			}
			self.private_uses.truncate(kept);
			self.privates.truncate(body.privates);
		}
		if saved.live {
			self.cx = saved.cx;
		}
	}

	// statements

	pub(crate) fn block_enter(&mut self) {
		if self.on() {
			self.enter(ScopeKind::Block);
		}
	}

	pub(crate) fn block_leave(&mut self) {
		if self.on() {
			self.leave();
		}
	}

	/// a declaration's names, before its walk
	pub(crate) fn variable_declaration(&mut self, it: &VariableDeclaration<'a>) {
		if !self.on() {
			return;
		}
		let kind = match it.kind {
			VariableDeclarationKind::Var => Kind::Var,
			VariableDeclarationKind::Let | VariableDeclarationKind::Const => Kind::Let,
			VariableDeclarationKind::Using | VariableDeclarationKind::AwaitUsing => {
				if it.kind == VariableDeclarationKind::AwaitUsing && self.cx.no_await {
					self.fail();
				}
				// not among a switch's cases, and not at a script's top
				let at_top = self.scopes.len() == 1 && !self.mode.module && !self.mode.lenient;
				if at_top || self.scopes.last().is_some_and(|scope| scope.kind == ScopeKind::Switch) {
					self.fail();
				}
				Kind::Let
			}
		};
		for declarator in &it.declarations {
			self.declare_pattern(&declarator.id, kind);
		}
	}

	/// the statement under `if` or `else`, before its walk: whether it
	/// is in a scope of its own (`branch_leave`)
	pub(crate) fn branch_enter(&mut self, statement: &Statement<'a>) -> bool {
		if !self.on() {
			return false;
		}
		if labelled_function(statement) {
			self.fail();
			return false;
		}
		if let Statement::FunctionDeclaration(function) = statement {
			// Annex B.3.3: sloppy code takes a plain function there, as if
			// a block held it
			if self.cx.strict || function.generator || function.r#async {
				self.fail();
				return false;
			}
			self.enter(ScopeKind::Block);
			return true;
		}
		false
	}

	pub(crate) fn branch_leave(&mut self, scoped: bool) {
		if scoped {
			self.leave();
		}
	}

	/// the statement a loop repeats or `with` runs: no function, labelled
	/// or not
	pub(crate) fn body(&mut self, statement: &Statement<'a>) {
		if self.on() && (matches!(statement, Statement::FunctionDeclaration(_)) || labelled_function(statement)) {
			self.fail();
		}
	}

	/// a loop's body, before its walk (`loop_leave` after)
	pub(crate) fn loop_enter(&mut self, statement: &Statement<'a>) {
		if self.on() {
			self.cx.loops += 1;
			self.cx.breakables += 1;
			self.body(statement);
		}
	}

	pub(crate) fn loop_leave(&mut self) {
		if self.on() {
			self.cx.loops -= 1;
			self.cx.breakables -= 1;
		}
	}

	/// `for (;;)`, before its init: whether it opened a scope
	pub(crate) fn for_enter(&mut self, it: &ForStatement<'a>) -> bool {
		let scoped = self.on()
			&& matches!(
				&it.init,
				Some(ForStatementInit::VariableDeclaration(declaration))
					if declaration.kind != VariableDeclarationKind::Var
			);
		if scoped {
			self.enter(ScopeKind::Block);
		}
		scoped
	}

	/// `for (... in/of ...)`, before its head: whether it opened a scope
	/// (`scope_leave` after the body)
	pub(crate) fn for_each_enter(&mut self, left: &ForStatementLeft<'a>, of: bool, awaits: bool) -> bool {
		if !self.on() {
			return false;
		}
		if awaits && self.cx.no_await {
			self.fail();
		}
		let ForStatementLeft::VariableDeclaration(declaration) = left else {
			return false;
		};
		let using = matches!(
			declaration.kind,
			VariableDeclarationKind::Using | VariableDeclarationKind::AwaitUsing
		);
		if let Some(first) = declaration.declarations.first()
			&& first.init.is_some()
		{
			// Annex B.3.5: `for (var a = 1 in b)` in sloppy code alone
			if of
				|| self.cx.strict || declaration.kind != VariableDeclarationKind::Var
				|| !matches!(first.id, BindingPattern::BindingIdentifier(_))
			{
				self.fail();
			}
		}
		if using && !of {
			self.fail();
		}
		let scoped = declaration.kind != VariableDeclarationKind::Var;
		if scoped {
			self.enter(ScopeKind::Block);
		}
		scoped
	}

	pub(crate) fn scope_leave(&mut self, scoped: bool) {
		if scoped {
			self.leave();
		}
	}

	pub(crate) fn with(&mut self, it: &WithStatement<'a>) {
		if self.on() && self.cx.strict {
			self.fail();
		}
		self.body(&it.body);
	}

	/// a switch's cases, before them
	pub(crate) fn switch_enter(&mut self) {
		if self.on() {
			self.enter(ScopeKind::Switch);
			self.cx.breakables += 1;
		}
	}

	pub(crate) fn switch_leave(&mut self) {
		if self.on() {
			self.cx.breakables -= 1;
			self.leave();
		}
	}

	/// a catch clause, before its parameter: the parameter and the
	/// block's own names are one scope's (`block_leave` after its body)
	pub(crate) fn catch_enter(&mut self, it: &CatchClause<'a>) {
		if !self.on() {
			return;
		}
		self.enter(ScopeKind::Block);
		if let Some(param) = &it.param {
			match &param.pattern {
				BindingPattern::BindingIdentifier(id) => self.declare(id.name.as_str(), Kind::CatchSimple),
				pattern => self.declare_pattern(pattern, Kind::Lexical),
			}
		}
	}

	/// a labelled statement, before its body: whether its label was
	/// pushed (`label_leave` after)
	pub(crate) fn label_enter(&mut self, it: &LabeledStatement<'a>) -> bool {
		if !self.on() {
			return false;
		}
		let name = it.label.name.as_str();
		self.name(name, false);
		if self.labels[self.cx.label_base as usize..].iter().any(|(label, _)| *label == name) {
			self.fail();
			return false;
		}
		let mut inner = &it.body;
		while let Statement::LabeledStatement(labelled) = inner {
			inner = &labelled.body;
		}
		let is_loop = matches!(
			inner,
			Statement::DoWhileStatement(_)
				| Statement::ForInStatement(_)
				| Statement::ForOfStatement(_)
				| Statement::ForStatement(_)
				| Statement::WhileStatement(_)
		);
		// Annex B.3.1: sloppy code takes a plain function behind a label
		if let Statement::FunctionDeclaration(function) = inner
			&& (self.cx.strict || function.generator || function.r#async)
		{
			self.fail();
			return false;
		}
		self.labels.push((name, is_loop));
		true
	}

	pub(crate) fn label_leave(&mut self, pushed: bool) {
		if pushed {
			self.labels.pop();
		}
	}

	pub(crate) fn break_statement(&mut self, it: &BreakStatement<'a>) {
		if !self.on() {
			return;
		}
		let found = match &it.label {
			Some(label) => {
				self.labels[self.cx.label_base as usize..].iter().any(|(name, _)| *name == label.name.as_str())
			}
			None => self.cx.breakables > 0,
		};
		if !found {
			self.fail();
		}
	}

	pub(crate) fn continue_statement(&mut self, it: &ContinueStatement<'a>) {
		if !self.on() {
			return;
		}
		let found = match &it.label {
			Some(label) => self.labels[self.cx.label_base as usize..]
				.iter()
				.any(|(name, is_loop)| *is_loop && *name == label.name.as_str()),
			None => true,
		};
		if !found || self.cx.loops == 0 {
			self.fail();
		}
	}

	pub(crate) fn return_statement(&mut self) {
		if self.on() && !self.cx.returns {
			self.fail();
		}
	}

	/// an import declaration (none of it is walked)
	pub(crate) fn import_declaration(&mut self, it: &ImportDeclaration<'a>) {
		if !self.on() {
			return;
		}
		for specifier in it.specifiers.iter().flatten() {
			let local = match specifier {
				ImportDeclarationSpecifier::ImportSpecifier(specifier) => &specifier.local,
				ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) => &specifier.local,
				ImportDeclarationSpecifier::ImportNamespaceSpecifier(specifier) => &specifier.local,
			};
			self.declare(local.name.as_str(), Kind::Lexical);
			self.name(local.name.as_str(), true);
		}
		self.string_literal(&it.source);
		if let Some(with) = &it.with_clause {
			self.with_clause(with);
		}
	}

	pub(crate) fn with_clause(&mut self, it: &WithClause<'a>) {
		// `assert { }`: the keyword browsers dropped
		if self.on() && it.keyword == WithClauseKeyword::Assert {
			self.fail();
		}
	}

	/// `export { a, b as c }` (its specifiers are not walked)
	pub(crate) fn export_named(&mut self, it: &ExportNamedDeclaration<'a>) {
		if !self.on() {
			return;
		}
		for specifier in &it.specifiers {
			if let ModuleExportName::IdentifierReference(local) = &specifier.local {
				self.name(local.name.as_str(), false);
				self.exports.push(local.name.as_str());
			}
		}
	}

	/// `export default`, before its declaration (`default_leave` after)
	pub(crate) fn default_enter(&mut self, it: &ExportDefaultDeclaration<'a>) {
		if self.on() {
			self.default_export = matches!(
				it.declaration,
				ExportDefaultDeclarationKind::FunctionDeclaration(_)
					| ExportDefaultDeclarationKind::ClassDeclaration(_)
			);
		}
	}

	pub(crate) fn default_leave(&mut self) {
		if self.on() {
			self.default_export = false;
		}
	}

	/// a class element's private name, declared: once, or a getter and a
	/// setter of one placement
	fn private(&mut self, start: usize, key: &PropertyKey<'a>, is_static: bool, accessor: u8) {
		let PropertyKey::PrivateIdentifier(id) = key else {
			return;
		};
		let name = id.name.as_str();
		if let Some(existing) = self.privates[start..].iter_mut().find(|private| private.name == name) {
			if accessor != 0
				&& existing.accessors != 0
				&& existing.accessors & accessor == 0
				&& existing.is_static == is_static
			{
				existing.accessors |= accessor;
			} else {
				self.fail();
			}
			return;
		}
		self.privates.push(Private {
			name,
			is_static,
			accessors: accessor,
		});
	}
}

/// The check on its own: a walk of the whole tree that calls the hooks
/// (the parse questions and the rewriter's fallback ask it; a rewrite calls
/// the same hooks from its own walk, src/walk.rs)
impl<'a> Checker<'a, '_> {
	fn params(&mut self, params: &FormalParameters<'a>) {
		for param in &params.items {
			self.param(param);
			self.visit_binding_pattern(&param.pattern);
			if let Some(initializer) = &param.initializer {
				self.visit_expression(initializer);
			}
		}
		if let Some(rest) = &params.rest {
			self.rest_param(&rest.rest);
			self.visit_binding_pattern(&rest.rest.argument);
		}
	}

	fn function(&mut self, it: &Function<'a>, method: Option<bool>) {
		let saved = self.function_enter(it, method);
		self.params(&it.params);
		let directives = it.body.as_ref().map_or(&[][..], |body| &body.directives[..]);
		self.params_leave(&it.params, method.is_some(), directives);
		if let Some(body) = &it.body {
			self.visit_statements(&body.statements);
		}
		self.function_leave(saved);
	}

	fn branch(&mut self, statement: &Statement<'a>) {
		let scoped = self.branch_enter(statement);
		self.visit_statement(statement);
		self.branch_leave(scoped);
	}

	fn loop_body(&mut self, statement: &Statement<'a>) {
		self.loop_enter(statement);
		self.visit_statement(statement);
		self.loop_leave();
	}

	fn for_each(&mut self, left: &ForStatementLeft<'a>, right: &Expression<'a>, body: &Statement<'a>, of: bool, awaits: bool) {
		let scoped = self.for_each_enter(left, of, awaits);
		match left {
			ForStatementLeft::VariableDeclaration(declaration) => self.visit_variable_declaration(declaration),
			left => self.visit_for_statement_left(left),
		}
		self.visit_expression(right);
		self.loop_body(body);
		self.scope_leave(scoped);
	}

	/// a class element's key: a private name is declared, not used
	fn key(&mut self, key: &PropertyKey<'a>) {
		if !matches!(key, PropertyKey::PrivateIdentifier(_)) {
			self.visit_property_key(key);
		}
	}
}

impl<'a> Visit<'a> for Checker<'a, '_> {
	fn visit_program(&mut self, it: &Program<'a>) {
		self.program_enter(it);
		self.visit_statements(&it.body);
		self.program_leave();
	}

	fn visit_statements(&mut self, it: &oxc::allocator::Vec<'a, Statement<'a>>) {
		for statement in it {
			if self.error {
				return;
			}
			self.visit_statement(statement);
		}
	}

	fn visit_expression(&mut self, it: &Expression<'a>) {
		if !self.error {
			walk::walk_expression(self, it);
		}
	}

	fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
		self.reference(it.name.as_str());
	}

	fn visit_binding_identifier(&mut self, it: &BindingIdentifier<'a>) {
		self.binding(it.name.as_str());
	}

	fn visit_label_identifier(&mut self, it: &LabelIdentifier<'a>) {
		self.reference(it.name.as_str());
	}

	fn visit_private_identifier(&mut self, it: &PrivateIdentifier<'a>) {
		self.private_use(it.name.as_str());
	}

	fn visit_simple_assignment_target(&mut self, it: &SimpleAssignmentTarget<'a>) {
		match it {
			SimpleAssignmentTarget::AssignmentTargetIdentifier(id) => self.assigned(id.name.as_str()),
			it => walk::walk_simple_assignment_target(self, it),
		}
	}

	fn visit_assignment_target_property_identifier(&mut self, it: &AssignmentTargetPropertyIdentifier<'a>) {
		self.assigned(it.binding.name.as_str());
		if let Some(init) = &it.init {
			self.visit_expression(init);
		}
	}

	fn visit_numeric_literal(&mut self, it: &NumericLiteral<'a>) {
		self.numeric(it);
	}

	fn visit_string_literal(&mut self, it: &StringLiteral<'a>) {
		self.string_literal(it);
	}

	fn visit_unary_expression(&mut self, it: &UnaryExpression<'a>) {
		self.unary(it);
		if !self.error {
			walk::walk_unary_expression(self, it);
		}
	}

	fn visit_binary_expression(&mut self, it: &BinaryExpression<'a>) {
		self.binary(it);
		if !self.error {
			walk::walk_binary_expression(self, it);
		}
	}

	fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
		if matches!(it.callee, Expression::Super(_)) {
			self.super_call();
			self.visit_arguments(&it.arguments);
		} else {
			walk::walk_call_expression(self, it);
		}
	}

	fn visit_super(&mut self, _it: &Super) {
		self.super_property();
	}

	fn visit_await_expression(&mut self, it: &AwaitExpression<'a>) {
		self.operator();
		walk::walk_await_expression(self, it);
	}

	fn visit_yield_expression(&mut self, it: &YieldExpression<'a>) {
		self.operator();
		walk::walk_yield_expression(self, it);
	}

	fn visit_object_expression(&mut self, it: &ObjectExpression<'a>) {
		let around = self.object_enter();
		walk::walk_object_expression(self, it);
		self.object_leave(around);
	}

	fn visit_object_property(&mut self, it: &ObjectProperty<'a>) {
		self.property(it);
		self.visit_property_key(&it.key);
		match &it.value {
			Expression::FunctionExpression(function) if it.method || it.kind != PropertyKind::Init => {
				self.function(function, Some(false));
			}
			value => self.visit_expression(value),
		}
	}

	fn visit_function(&mut self, it: &Function<'a>, _flags: ScopeFlags) {
		self.function(it, None);
	}

	fn visit_arrow_function_expression(&mut self, it: &ArrowFunctionExpression<'a>) {
		let saved = self.arrow_enter(it);
		self.params(&it.params);
		self.arrow_params_leave(it);
		match &it.body {
			ArrowFunctionBody::FunctionBody(body) => self.visit_statements(&body.statements),
			body => self.visit_expression(body.to_expression()),
		}
		self.function_leave(saved);
	}

	fn visit_class(&mut self, it: &Class<'a>) {
		let saved = self.class_enter(it);
		if let Some(heritage) = &it.heritage {
			self.visit_expression(&heritage.expression);
		}
		let body = self.class_body_enter(it);
		for element in &it.body.body {
			if self.error {
				break;
			}
			match element {
				ClassElement::MethodDefinition(method) => {
					self.key(&method.key);
					let method_of = self.method(method);
					self.function(&method.value, method_of);
				}
				ClassElement::PropertyDefinition(property) => {
					self.key(&property.key);
					if let Some(value) = &property.value {
						let around = self.field_enter();
						self.visit_expression(value);
						self.field_leave(around);
					}
				}
				ClassElement::StaticBlock(block) => {
					let around = self.static_enter();
					self.visit_statements(&block.body);
					self.static_leave(around);
				}
				ClassElement::AccessorProperty(_) | ClassElement::TSIndexSignature(_) => {}
			}
		}
		self.class_leave(body, saved);
	}

	fn visit_decorator(&mut self, _it: &Decorator<'a>) {
		self.unshipped();
	}

	fn visit_import_expression(&mut self, it: &ImportExpression<'a>) {
		self.import_expression(it);
		walk::walk_import_expression(self, it);
	}

	fn visit_block_statement(&mut self, it: &BlockStatement<'a>) {
		self.block_enter();
		self.visit_statements(&it.body);
		self.block_leave();
	}

	fn visit_variable_declaration(&mut self, it: &VariableDeclaration<'a>) {
		self.variable_declaration(it);
		for declarator in &it.declarations {
			self.visit_binding_pattern(&declarator.id);
			if let Some(init) = &declarator.init {
				self.visit_expression(init);
			}
		}
	}

	fn visit_if_statement(&mut self, it: &IfStatement<'a>) {
		self.visit_expression(&it.test);
		self.branch(&it.consequent);
		if let Some(alternate) = &it.alternate {
			self.branch(alternate);
		}
	}

	fn visit_while_statement(&mut self, it: &WhileStatement<'a>) {
		self.visit_expression(&it.test);
		self.loop_body(&it.body);
	}

	fn visit_do_while_statement(&mut self, it: &DoWhileStatement<'a>) {
		self.loop_body(&it.body);
		self.visit_expression(&it.test);
	}

	fn visit_for_statement(&mut self, it: &ForStatement<'a>) {
		let scoped = self.for_enter(it);
		if let Some(init) = &it.init {
			self.visit_for_statement_init(init);
		}
		if let Some(test) = &it.test {
			self.visit_expression(test);
		}
		if let Some(update) = &it.update {
			self.visit_expression(update);
		}
		self.loop_body(&it.body);
		self.scope_leave(scoped);
	}

	fn visit_for_in_statement(&mut self, it: &ForInStatement<'a>) {
		self.for_each(&it.left, &it.right, &it.body, false, false);
	}

	fn visit_for_of_statement(&mut self, it: &ForOfStatement<'a>) {
		self.for_each(&it.left, &it.right, &it.body, true, it.r#await);
	}

	fn visit_with_statement(&mut self, it: &WithStatement<'a>) {
		self.with(it);
		self.visit_expression(&it.object);
		self.visit_statement(&it.body);
	}

	fn visit_switch_statement(&mut self, it: &SwitchStatement<'a>) {
		self.visit_expression(&it.discriminant);
		self.switch_enter();
		for case in &it.cases {
			if let Some(test) = &case.test {
				self.visit_expression(test);
			}
			self.visit_statements(&case.consequent);
		}
		self.switch_leave();
	}

	fn visit_catch_clause(&mut self, it: &CatchClause<'a>) {
		self.catch_enter(it);
		if let Some(param) = &it.param {
			self.visit_binding_pattern(&param.pattern);
		}
		self.visit_statements(&it.body.body);
		self.block_leave();
	}

	fn visit_labeled_statement(&mut self, it: &LabeledStatement<'a>) {
		let pushed = self.label_enter(it);
		self.visit_statement(&it.body);
		self.label_leave(pushed);
	}

	fn visit_break_statement(&mut self, it: &BreakStatement<'a>) {
		self.break_statement(it);
	}

	fn visit_continue_statement(&mut self, it: &ContinueStatement<'a>) {
		self.continue_statement(it);
	}

	fn visit_return_statement(&mut self, it: &ReturnStatement<'a>) {
		self.return_statement();
		walk::walk_return_statement(self, it);
	}

	fn visit_import_declaration(&mut self, it: &ImportDeclaration<'a>) {
		self.import_declaration(it);
	}

	fn visit_export_named_declaration(&mut self, it: &ExportNamedDeclaration<'a>) {
		self.export_named(it);
	}

	fn visit_export_from_declaration(&mut self, it: &ExportFromDeclaration<'a>) {
		if let Some(with) = &it.with_clause {
			self.with_clause(with);
		}
	}

	fn visit_export_all_declaration(&mut self, it: &ExportAllDeclaration<'a>) {
		if let Some(with) = &it.with_clause {
			self.with_clause(with);
		}
	}

	fn visit_export_default_declaration(&mut self, it: &ExportDefaultDeclaration<'a>) {
		self.default_enter(it);
		walk::walk_export_default_declaration(self, it);
		self.default_leave();
	}
}

#[cfg(test)]
mod tests {
	//! The crate against rust/host/early-errors.txt, V8's recorded verdicts:
	//! no V8 runs here, so this is rust/host/early.mjs without the rewrites
	//! asked of it (what a script V8 refuses is rewritten into is V8's to
	//! refuse there). rust/host/early-known.txt names what falls short.
	use std::collections::HashMap;

	use crate::config::Config;
	use crate::rewrite::{Decline, Options, Params, parses, rewrite};

	const CASES: &str = include_str!("../../host/early-errors.txt");
	const KNOWN: &str = include_str!("../../host/early-known.txt");

	/// a case's text with its `<NL>`, `<U+XXXX>` and the like spelled out
	fn spelled(text: &str) -> String {
		let mut out = String::new();
		let mut rest = text;
		while let Some(at) = rest.find('<') {
			out.push_str(&rest[..at]);
			rest = &rest[at..];
			let token = rest.find('>').map(|end| &rest[1..end]);
			let spelt = match token {
				Some("NL") => Some('\n'),
				Some("CR") => Some('\r'),
				Some("LS") => Some('\u{2028}'),
				Some("PS") => Some('\u{2029}'),
				Some(token) => token
					.strip_prefix("U+")
					.filter(|hex| (4..=6).contains(&hex.len()))
					.and_then(|hex| u32::from_str_radix(hex, 16).ok())
					.and_then(char::from_u32),
				None => None,
			};
			match (spelt, token) {
				(Some(spelt), Some(token)) => {
					out.push(spelt);
					rest = &rest[token.len() + 2..];
				}
				_ => {
					out.push('<');
					rest = &rest[1..];
				}
			}
		}
		out + rest
	}

	fn run(source: &str, module: bool) -> Result<String, Decline> {
		let config = Config::default();
		let params = Params {
			url: "https://a.example/x.js".into(),
			..Params::default()
		};
		let options = Options {
			module,
			holder: false,
			config: &config,
			params: &params,
		};
		let mut route = |kind: u32, text: &str| Some(format!("/routed/{kind}/{}", text.len()));
		rewrite(source, &options, &mut route).map(|output| output.text)
	}

	#[test]
	fn the_recorded_verdicts_hold() {
		let known: HashMap<&str, &str> = KNOWN
			.lines()
			.filter(|line| !line.starts_with('#'))
			.filter_map(|line| line.split_once(' '))
			.filter(|(kind, _)| !kind.is_empty() && kind.bytes().all(|byte| byte.is_ascii_lowercase()))
			.map(|(kind, text)| (text.trim_end(), kind))
			.collect();
		let mut needed: Vec<&str> = Vec::new();
		let mut short: Vec<String> = Vec::new();
		let mut cases = 0;
		for line in CASES.lines() {
			let Some((marks, text)) = line.split_once(' ') else {
				continue;
			};
			if marks.len() != 3 || !marks.bytes().all(|mark| matches!(mark, b'+' | b'-')) {
				continue;
			}
			cases += 1;
			let text = text.trim_end();
			let code = spelled(text);
			let kind = known.get(text).copied();
			let mut name = |kinds: &[&str]| {
				let named = kind.is_some_and(|kind| kinds.contains(&kind));
				if named && !needed.contains(&text) {
					needed.push(text);
				}
				named
			};
			let forms = [
				("script", code.clone(), false),
				("strict", format!("'use strict';\n{code}"), false),
				("module", code.clone(), true),
			];
			for (at, (form, source, module)) in forms.iter().enumerate() {
				let taken = marks.as_bytes()[at] == b'+';
				let answer = run(source, *module);
				let fine = match (&answer, taken) {
					// V8 refuses it: handed back as it was, or the
					// JavaScript rewriter's to decide
					(Err(_), false) => true,
					(Ok(_), false) => name(&["top", "return"]),
					(Ok(_), true) => true,
					(Err(Decline::Parse), true) => name(&["parser"]),
					(Err(Decline::Shape), true) => name(&["shape"]),
					// a script V8 takes is never one no browser runs
					(Err(_), true) => false,
				};
				if !fine {
					short.push(format!("{form}: {text}: V8 {}, {answer:?}", if taken { "takes" } else { "refuses" }));
				}
				if *module || kind == Some("return") {
					continue;
				}
				let asked = parses(source, false);
				if asked != taken && !(taken && name(&["parser"])) {
					short.push(format!("{form}: {text}: parses as a script: {asked}, V8 {taken}"));
				}
				if !taken && parses(source, true) {
					short.push(format!("{form}: {text}: a single expression, and V8 refuses it"));
				}
			}
		}
		assert!(cases > 4000, "{cases} cases read");
		assert!(short.is_empty(), "{} short of V8's answer and not named:\n{}", short.len(), short.join("\n"));
		let idle: Vec<&&str> = known.keys().filter(|text| !needed.contains(text)).collect();
		assert!(idle.is_empty(), "named in early-known.txt and no longer needed: {idle:?}");
	}

	#[test]
	fn the_rewrite_walk_checks_as_the_check_does() {
		// every recorded text, as a script, behind 'use strict', as a module
		// and in the places rust/host/early.mjs tries it: the verdict of the
		// rewrite's walk (which drives the check) is the check's own
		let places: [(&str, &str); 8] = [
			("", ""),
			("function f() {\n", "\n}"),
			("x = () => {\n", "\n}"),
			("async function f() {\n", "\n}"),
			("function* f() {\n", "\n}"),
			("x = { m() {\n", "\n} }"),
			("class A { static {\n", "\n} }"),
			("{\n", "\n}"),
		];
		crate::rewrite::tests::DIFFER.with(|differ| differ.borrow_mut().clear());
		let mut tried = 0;
		for line in CASES.lines() {
			let Some((marks, text)) = line.split_once(' ') else {
				continue;
			};
			if marks.len() != 3 || !marks.bytes().all(|mark| matches!(mark, b'+' | b'-')) {
				continue;
			}
			let code = spelled(text.trim_end());
			for (before, after) in places {
				let wrapped = format!("{before}{code}{after}");
				for (source, module) in [
					(wrapped.clone(), false),
					(format!("'use strict';\n{wrapped}"), false),
					(wrapped.clone(), true),
				] {
					tried += 1;
					let _ = run(&source, module);
				}
			}
		}
		let differ = crate::rewrite::tests::DIFFER.with(|differ| differ.borrow().clone());
		assert!(tried > 100_000, "{tried} tried");
		assert!(differ.is_empty(), "{} of {tried} differ:\n{}", differ.len(), differ[..differ.len().min(40)].join("\n"));
	}

	/// the same over the files of a directory (STOMP_AGREE: the parity
	/// cases and a corpus of real scripts, run by hand: they are not here)
	#[test]
	#[ignore]
	fn the_rewrite_walk_checks_as_the_check_does_over_files() {
		let dir = std::env::var("STOMP_AGREE").expect("STOMP_AGREE");
		crate::rewrite::tests::DIFFER.with(|differ| differ.borrow_mut().clear());
		let mut tried = 0;
		for entry in std::fs::read_dir(&dir).unwrap() {
			let path = entry.unwrap().path();
			let Ok(text) = std::fs::read_to_string(&path) else {
				continue;
			};
			let module = path.extension().is_some_and(|ext| ext == "mjs");
			for (source, module) in [(text.clone(), module), (text, !module)] {
				tried += 1;
				let _ = run(&source, module);
			}
		}
		let differ = crate::rewrite::tests::DIFFER.with(|differ| differ.borrow().clone());
		assert!(differ.is_empty(), "{} of {tried} differ:\n{}", differ.len(), differ[..differ.len().min(20)].join("\n"));
		eprintln!("{tried} scripts, the two walks agree");
	}

	#[test]
	fn a_refused_script_is_no_browser_s() {
		for source in [
			"'use strict'; delete location",
			"'use strict'; with (a) b",
			"let a; let a",
			"function f(a, a) { 'use strict' }",
			"class A { constructor() {} constructor() {} }",
			"break",
			"l: l: a",
			"({ __proto__: 1, __proto__: 2 })",
			"/(/",
		] {
			let answer = run(source, false);
			assert!(matches!(answer, Err(Decline::Invalid | Decline::Parse)), "{source}: {answer:?}");
			assert!(!parses(source, false), "{source}");
		}
		for source in [
			"delete location",
			"with (a) b",
			"var a; var a",
			"function f(a, a) {}",
			"{ function a() {} function a() {} }",
			"if (a) function b() {}",
			"l: function f() {}",
			"try {} catch (a) { var a }",
			"for (var a = 1 in b);",
			"x = 010 + 08; '\\01'",
			"return 1",
		] {
			let answer = run(source, false);
			assert!(answer.is_ok(), "{source}: {answer:?}");
			assert!(parses(source, false), "{source}");
		}
		// what no browser has yet is the JavaScript rewriter's, not an error
		assert_eq!(run("@a class A {}", false), Err(Decline::Shape));
		// `delete` keeps the name it is asked of, for strict eval code to refuse
		assert_eq!(run("delete top", false).unwrap(), "delete top");
	}
}
