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
	let mut checker = Checker {
		source: source.as_bytes(),
		mode,
		error: false,
		unshipped: false,
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
	};
	checker.visit_program(program);
	if checker.error {
		Verdict::Refused
	} else if checker.unshipped {
		Verdict::Unshipped
	} else {
		Verdict::Compiles
	}
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

/// The names declared so far, each with a number: open addressing over the
/// names' bytes, nothing removed
struct Table<'a> {
	slots: Vec<(&'a str, u32)>,
	used: u32,
}

impl<'a> Table<'a> {
	fn new() -> Self {
		Self {
			slots: vec![("", 0); 64],
			used: 0,
		}
	}

	fn find(&self, name: &str) -> usize {
		let mut hash: u32 = 0x811c_9dc5;
		for byte in name.bytes() {
			hash = (hash ^ u32::from(byte)).wrapping_mul(0x0100_0193);
		}
		let mask = self.slots.len() - 1;
		let mut at = hash as usize & mask;
		loop {
			let slot = self.slots[at].0;
			if slot.is_empty() || slot == name {
				return at;
			}
			at = (at + 1) & mask;
		}
	}

	/// the number of `name`, if it was ever declared
	fn get(&self, name: &str) -> Option<u32> {
		let (slot, id) = self.slots[self.find(name)];
		(!slot.is_empty()).then_some(id)
	}

	/// the number of `name`, a new one the first time
	fn id(&mut self, name: &'a str) -> u32 {
		let mut at = self.find(name);
		if self.slots[at].0.is_empty() {
			if (self.used as usize + 1) * 2 > self.slots.len() {
				let wider = vec![("", 0); self.slots.len() * 2];
				let old = std::mem::replace(&mut self.slots, wider);
				for (name, id) in old {
					if !name.is_empty() {
						let at = self.find(name);
						self.slots[at] = (name, id);
					}
				}
				at = self.find(name);
			}
			self.slots[at] = (name, self.used);
			self.used += 1;
		}
		self.slots[at].1
	}
}

struct Private<'a> {
	name: &'a str,
	is_static: bool,
	/// 1 a getter, 2 a setter, 0 anything else
	accessors: u8,
}

struct Checker<'a, 's> {
	source: &'s [u8],
	mode: Mode,
	error: bool,
	unshipped: bool,
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

impl<'a> Checker<'a, '_> {
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
				if top.is_some_and(|top| top.depth == depth && matches!(top.kind, Kind::Var | Kind::Param)) {
					return;
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
	fn name(&mut self, name: &str, binding: bool) {
		// (the names below are 3 to 10 bytes and start with one of
		// `aeilpsy`: most names are neither)
		if !(3..=10).contains(&name.len())
			|| !matches!(name.as_bytes()[0], b'a' | b'e' | b'i' | b'l' | b'p' | b's' | b'y')
		{
			return;
		}
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
	fn params(&mut self, params: &FormalParameters<'a>, unique: bool) -> bool {
		let simple = params.rest.is_none()
			&& params.items.iter().all(|param| {
				param.initializer.is_none() && matches!(param.pattern, BindingPattern::BindingIdentifier(_))
			});
		self.duplicate_param = false;
		for param in &params.items {
			if !param.decorators.is_empty() {
				self.unshipped = true;
			}
			self.declare_pattern(&param.pattern, Kind::Param);
			self.visit_binding_pattern(&param.pattern);
			if let Some(initializer) = &param.initializer {
				self.visit_expression(initializer);
			}
		}
		if let Some(rest) = &params.rest {
			self.declare_pattern(&rest.rest.argument, Kind::Param);
			self.visit_binding_pattern(&rest.rest.argument);
		}
		if self.duplicate_param && (unique || !simple || self.cx.strict) {
			self.fail();
		}
		simple
	}

	/// a function that is no arrow; `method` when it is a method's (whether
	/// it may call `super`)
	fn function(&mut self, it: &Function<'a>, method: Option<bool>) {
		let Some(body) = &it.body else {
			return self.fail();
		};
		let own = strict_directive(&body.directives);
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
		let saved = self.cx;
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
		let simple = self.params(&it.params, method.is_some());
		if own && !simple {
			self.fail();
		}
		self.cx.in_params = false;
		self.directives(&body.directives);
		self.visit_statements(&body.statements);
		self.leave();
		self.cx = saved;
	}

	/// the statement under `if` or `else`
	fn branch(&mut self, statement: &Statement<'a>) {
		if labelled_function(statement) {
			return self.fail();
		}
		if let Statement::FunctionDeclaration(function) = statement {
			// Annex B.3.3: sloppy code takes a plain function there, as if
			// a block held it
			if self.cx.strict || function.generator || function.r#async {
				return self.fail();
			}
			self.enter(ScopeKind::Block);
			self.visit_statement(statement);
			self.leave();
		} else {
			self.visit_statement(statement);
		}
	}

	/// the statement a loop repeats or `with` runs: no function, labelled
	/// or not
	fn body(&mut self, statement: &Statement<'a>) {
		if matches!(statement, Statement::FunctionDeclaration(_)) || labelled_function(statement) {
			return self.fail();
		}
		self.visit_statement(statement);
	}

	fn loop_body(&mut self, statement: &Statement<'a>) {
		self.cx.loops += 1;
		self.cx.breakables += 1;
		self.body(statement);
		self.cx.loops -= 1;
		self.cx.breakables -= 1;
	}

	fn for_each(&mut self, left: &ForStatementLeft<'a>, right: &Expression<'a>, body: &Statement<'a>, of: bool) {
		let mut scoped = false;
		match left {
			ForStatementLeft::VariableDeclaration(declaration) => {
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
				scoped = declaration.kind != VariableDeclarationKind::Var;
				if scoped {
					self.enter(ScopeKind::Block);
				}
				self.visit_variable_declaration(declaration);
			}
			left => self.visit_for_statement_left(left),
		}
		self.visit_expression(right);
		self.loop_body(body);
		if scoped {
			self.leave();
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

	/// a class element's key: a private name is declared, not used
	fn key(&mut self, key: &PropertyKey<'a>) {
		if !matches!(key, PropertyKey::PrivateIdentifier(_)) {
			self.visit_property_key(key);
		}
	}
}

impl<'a> Visit<'a> for Checker<'a, '_> {
	fn visit_program(&mut self, it: &Program<'a>) {
		self.cx.strict = self.mode.module || strict_directive(&it.directives);
		self.enter(if self.mode.module { ScopeKind::Module } else { ScopeKind::Function });
		self.directives(&it.directives);
		self.visit_statements(&it.body);
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
		self.name(it.name.as_str(), false);
	}

	fn visit_binding_identifier(&mut self, it: &BindingIdentifier<'a>) {
		self.name(it.name.as_str(), true);
	}

	fn visit_label_identifier(&mut self, it: &LabelIdentifier<'a>) {
		self.name(it.name.as_str(), false);
	}

	fn visit_private_identifier(&mut self, it: &PrivateIdentifier<'a>) {
		self.private_uses.push(it.name.as_str());
	}

	fn visit_simple_assignment_target(&mut self, it: &SimpleAssignmentTarget<'a>) {
		if let SimpleAssignmentTarget::AssignmentTargetIdentifier(id) = it {
			self.target(id.name.as_str());
		}
		walk::walk_simple_assignment_target(self, it);
	}

	fn visit_assignment_target_property_identifier(&mut self, it: &AssignmentTargetPropertyIdentifier<'a>) {
		self.target(it.binding.name.as_str());
		walk::walk_assignment_target_property_identifier(self, it);
	}

	fn visit_numeric_literal(&mut self, it: &NumericLiteral<'a>) {
		// `010`, `08`: legacy octal and its decimal look-alike
		let start = it.span.start as usize;
		if self.cx.strict
			&& it.span.end as usize > start + 1
			&& self.source[start] == b'0'
			&& self.source[start + 1].is_ascii_digit()
		{
			self.fail();
		}
	}

	fn visit_string_literal(&mut self, it: &StringLiteral<'a>) {
		// (a literal as long as its value has no escape to read)
		if self.cx.strict && it.span.size() as usize != it.value.as_bytes().len() + 2 {
			self.string(it.span);
		}
	}

	fn visit_unary_expression(&mut self, it: &UnaryExpression<'a>) {
		if it.operator == UnaryOperator::Delete {
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
				return self.fail();
			}
		}
		walk::walk_unary_expression(self, it);
	}

	fn visit_binary_expression(&mut self, it: &BinaryExpression<'a>) {
		// `a <!--b` is `a < !--b` to the parser, and an HTML comment to V8:
		// a module's error
		if self.mode.module
			&& it.operator == BinaryOperator::LessThan
			&& let Expression::UnaryExpression(not) = &it.right
			&& not.operator == UnaryOperator::LogicalNot
		{
			let at = not.span.start as usize;
			if at > 0 && self.source[at - 1] == b'<' && self.source[at + 1..].starts_with(b"--") {
				return self.fail();
			}
		}
		walk::walk_binary_expression(self, it);
	}

	fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
		if matches!(it.callee, Expression::Super(_)) {
			if !self.cx.super_call {
				return self.fail();
			}
			self.visit_arguments(&it.arguments);
		} else {
			walk::walk_call_expression(self, it);
		}
	}

	fn visit_super(&mut self, _it: &Super) {
		if !self.cx.super_property {
			self.fail();
		}
	}

	fn visit_await_expression(&mut self, it: &AwaitExpression<'a>) {
		if self.cx.in_params || self.cx.no_await {
			return self.fail();
		}
		walk::walk_await_expression(self, it);
	}

	fn visit_yield_expression(&mut self, it: &YieldExpression<'a>) {
		if self.cx.in_params || self.cx.no_await {
			return self.fail();
		}
		walk::walk_yield_expression(self, it);
	}

	fn visit_object_expression(&mut self, it: &ObjectExpression<'a>) {
		// `__proto__: value` once an object (a pattern is no ObjectExpression)
		let mut protos = 0;
		for property in &it.properties {
			if let ObjectPropertyKind::ObjectProperty(property) = property
				&& property.kind == PropertyKind::Init
				&& !property.computed
				&& !property.shorthand
				&& !property.method
			{
				let proto = match &property.key {
					PropertyKey::StaticIdentifier(id) => id.name == "__proto__",
					PropertyKey::StringLiteral(string) => string.value.as_str() == Some("__proto__"),
					_ => false,
				};
				if proto {
					protos += 1;
				}
			}
		}
		if protos > 1 {
			return self.fail();
		}
		walk::walk_object_expression(self, it);
	}

	fn visit_object_property(&mut self, it: &ObjectProperty<'a>) {
		self.visit_property_key(&it.key);
		match &it.value {
			Expression::FunctionExpression(function) if it.method || it.kind != PropertyKind::Init => {
				self.function(function, Some(false));
			}
			value => self.visit_expression(value),
		}
	}

	fn visit_function(&mut self, it: &Function<'a>, _flags: ScopeFlags) {
		self.default_export = false;
		self.function(it, None);
	}

	fn visit_arrow_function_expression(&mut self, it: &ArrowFunctionExpression<'a>) {
		let own = match &it.body {
			ArrowFunctionBody::FunctionBody(body) => strict_directive(&body.directives),
			_ => false,
		};
		let saved = self.cx;
		// its parameters are read as the code around it is; its body is its own
		self.cx = Cx {
			strict: saved.strict || own,
			await_kw: saved.await_kw || it.r#async,
			in_params: true,
			no_await: false,
			returns: true,
			label_base: self.labels.len() as u32,
			loops: 0,
			breakables: 0,
			..saved
		};
		self.enter(ScopeKind::Function);
		let simple = self.params(&it.params, true);
		if own && !simple {
			self.fail();
		}
		self.cx.in_params = false;
		self.cx.yield_kw = false;
		self.cx.await_kw = it.r#async;
		match &it.body {
			ArrowFunctionBody::FunctionBody(body) => {
				self.directives(&body.directives);
				self.visit_statements(&body.statements);
			}
			body => self.visit_expression(body.to_expression()),
		}
		self.leave();
		self.cx = saved;
	}

	fn visit_class(&mut self, it: &Class<'a>) {
		let anonymous_allowed = std::mem::take(&mut self.default_export);
		if !it.decorators.is_empty() {
			self.unshipped = true;
		}
		let declaration = it.r#type == ClassType::ClassDeclaration;
		let saved = self.cx;
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
					return self.fail();
				}
			}
		}
		// all of a class is strict code
		self.cx.strict = true;
		if let Some(heritage) = &it.heritage {
			self.visit_expression(&heritage.expression);
		}
		let privates = self.privates.len();
		let uses = self.private_uses.len();
		for element in &it.body.body {
			match element {
				ClassElement::MethodDefinition(method) => {
					let accessor = match method.kind {
						MethodDefinitionKind::Get => 1,
						MethodDefinitionKind::Set => 2,
						_ => 0,
					};
					self.private(privates, &method.key, method.r#static, accessor);
				}
				ClassElement::PropertyDefinition(property) => {
					self.private(privates, &property.key, property.r#static, 0);
				}
				_ => {}
			}
		}
		let derived = it.heritage.is_some();
		let mut constructors = 0;
		for element in &it.body.body {
			if self.error {
				break;
			}
			match element {
				ClassElement::MethodDefinition(method) => {
					if !method.decorators.is_empty() {
						self.unshipped = true;
					}
					self.key(&method.key);
					let constructor = method.kind == MethodDefinitionKind::Constructor;
					if constructor {
						constructors += 1;
						if constructors > 1 {
							self.fail();
						}
					}
					self.function(&method.value, Some(constructor && derived));
				}
				ClassElement::PropertyDefinition(property) => {
					if !property.decorators.is_empty() {
						self.unshipped = true;
					}
					self.key(&property.key);
					if let Some(value) = &property.value {
						let around = self.cx;
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
						self.visit_expression(value);
						self.cx = around;
					}
				}
				ClassElement::StaticBlock(block) => {
					let around = self.cx;
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
					self.visit_statements(&block.body);
					self.leave();
					self.cx = around;
				}
				ClassElement::AccessorProperty(_) => self.unshipped = true,
				ClassElement::TSIndexSignature(_) => self.fail(),
			}
		}
		// a private name used is one of this class's or of a class around it
		let mut kept = uses;
		for at in uses..self.private_uses.len() {
			let name = self.private_uses[at];
			if !self.privates[privates..].iter().any(|private| private.name == name) {
				self.private_uses[kept] = name;
				kept += 1;
			}
		}
		self.private_uses.truncate(kept);
		self.privates.truncate(privates);
		self.cx = saved;
	}

	fn visit_decorator(&mut self, _it: &Decorator<'a>) {
		self.unshipped = true;
	}

	fn visit_import_expression(&mut self, it: &ImportExpression<'a>) {
		if it.phase == Some(ImportPhase::Defer) {
			self.unshipped = true;
		}
		walk::walk_import_expression(self, it);
	}

	fn visit_block_statement(&mut self, it: &BlockStatement<'a>) {
		self.enter(ScopeKind::Block);
		self.visit_statements(&it.body);
		self.leave();
	}

	fn visit_variable_declaration(&mut self, it: &VariableDeclaration<'a>) {
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
		let scoped = matches!(
			&it.init,
			Some(ForStatementInit::VariableDeclaration(declaration))
				if declaration.kind != VariableDeclarationKind::Var
		);
		if scoped {
			self.enter(ScopeKind::Block);
		}
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
		if scoped {
			self.leave();
		}
	}

	fn visit_for_in_statement(&mut self, it: &ForInStatement<'a>) {
		self.for_each(&it.left, &it.right, &it.body, false);
	}

	fn visit_for_of_statement(&mut self, it: &ForOfStatement<'a>) {
		if it.r#await && self.cx.no_await {
			return self.fail();
		}
		self.for_each(&it.left, &it.right, &it.body, true);
	}

	fn visit_with_statement(&mut self, it: &WithStatement<'a>) {
		if self.cx.strict {
			return self.fail();
		}
		self.visit_expression(&it.object);
		self.body(&it.body);
	}

	fn visit_switch_statement(&mut self, it: &SwitchStatement<'a>) {
		self.visit_expression(&it.discriminant);
		self.enter(ScopeKind::Switch);
		self.cx.breakables += 1;
		for case in &it.cases {
			if let Some(test) = &case.test {
				self.visit_expression(test);
			}
			self.visit_statements(&case.consequent);
		}
		self.cx.breakables -= 1;
		self.leave();
	}

	fn visit_catch_clause(&mut self, it: &CatchClause<'a>) {
		// the parameter and the block's own names are one scope's
		self.enter(ScopeKind::Block);
		if let Some(param) = &it.param {
			match &param.pattern {
				BindingPattern::BindingIdentifier(id) => self.declare(id.name.as_str(), Kind::CatchSimple),
				pattern => self.declare_pattern(pattern, Kind::Lexical),
			}
			self.visit_binding_pattern(&param.pattern);
		}
		self.visit_statements(&it.body.body);
		self.leave();
	}

	fn visit_labeled_statement(&mut self, it: &LabeledStatement<'a>) {
		let name = it.label.name.as_str();
		self.name(name, false);
		if self.labels[self.cx.label_base as usize..].iter().any(|(label, _)| *label == name) {
			return self.fail();
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
			return self.fail();
		}
		self.labels.push((name, is_loop));
		self.visit_statement(&it.body);
		self.labels.pop();
	}

	fn visit_break_statement(&mut self, it: &BreakStatement<'a>) {
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

	fn visit_continue_statement(&mut self, it: &ContinueStatement<'a>) {
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

	fn visit_return_statement(&mut self, it: &ReturnStatement<'a>) {
		if !self.cx.returns {
			return self.fail();
		}
		walk::walk_return_statement(self, it);
	}

	fn visit_import_declaration(&mut self, it: &ImportDeclaration<'a>) {
		for specifier in it.specifiers.iter().flatten() {
			let local = match specifier {
				ImportDeclarationSpecifier::ImportSpecifier(specifier) => &specifier.local,
				ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) => &specifier.local,
				ImportDeclarationSpecifier::ImportNamespaceSpecifier(specifier) => &specifier.local,
			};
			self.declare(local.name.as_str(), Kind::Lexical);
			self.name(local.name.as_str(), true);
		}
		self.visit_string_literal(&it.source);
		if let Some(with) = &it.with_clause {
			self.visit_with_clause(with);
		}
	}

	fn visit_with_clause(&mut self, it: &WithClause<'a>) {
		// `assert { }`: the keyword browsers dropped
		if it.keyword == WithClauseKeyword::Assert {
			self.fail();
		}
	}

	fn visit_export_named_declaration(&mut self, it: &ExportNamedDeclaration<'a>) {
		for specifier in &it.specifiers {
			if let ModuleExportName::IdentifierReference(local) = &specifier.local {
				self.name(local.name.as_str(), false);
				self.exports.push(local.name.as_str());
			}
		}
	}

	fn visit_export_from_declaration(&mut self, it: &ExportFromDeclaration<'a>) {
		if let Some(with) = &it.with_clause {
			self.visit_with_clause(with);
		}
	}

	fn visit_export_all_declaration(&mut self, it: &ExportAllDeclaration<'a>) {
		if let Some(with) = &it.with_clause {
			self.visit_with_clause(with);
		}
	}

	fn visit_export_default_declaration(&mut self, it: &ExportDefaultDeclaration<'a>) {
		self.default_export = matches!(
			it.declaration,
			ExportDefaultDeclarationKind::FunctionDeclaration(_) | ExportDefaultDeclarationKind::ClassDeclaration(_)
		);
		walk::walk_export_default_declaration(self, it);
		self.default_export = false;
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
