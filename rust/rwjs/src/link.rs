//! The module linker: the modules of one import cycle merged into one
//! module, for a document no service worker controls (src/inject/dom/
//! moduleGraph.ts). There the inject copies each module of a graph to a
//! blob: URL whose imports name their copies, which a cycle cannot have (a
//! blob's text is fixed when its URL is made), and Firefox takes no import
//! map once a module of the document has loaded, which could close it.
//!
//! The input is the cycle's modules (rewritten), apart by `\0`, the first
//! the one the graph reaches first. An import of another of them names it
//! by `\u{1}` and its index; any other import names its copy. The output is
//! the merged module and then, apart by `\0`, one module for each input
//! that stands for it (its "facade"): it imports the merged one, named by
//! `\u{1}` (the host puts its copy's URL there), and exports what the
//! module did, under the same names, as live bindings of the merged one.
//!
//! The merge keeps the module semantics a page can see:
//!
//! - Each module's top-level bindings stay its own: one whose name another
//!   module of the cycle declares, or reads as a global, is renamed (the
//!   declaration and every reference that resolves to it, by a scope walk
//!   of each module). A renamed function or class keeps its `name`, and so
//!   does an anonymous function a renamed binding names.
//! - An import of another module of the cycle reads that module's binding
//!   itself, so it is live and in its temporal dead zone as natively; `*`
//!   imports read an object of getters with the module's export names.
//! - The modules run in the order the browser runs a cycle (depth first
//!   from the first, each after its imports); function declarations are
//!   hoisted across the cycle as natively, so a module may call another's
//!   before that one ran.
//! - Each module keeps an `import.meta` of its own, which its lead fills
//!   (src/scriptLead.ts).
//! - The modules outside the cycle are imported by the merged module, in
//!   the order the cycle would first run them.
//!
//! What it does not keep: the identity of a `*` import of a cycle module
//! (one object inside, the facade's namespace outside), and the order of a
//! module outside the cycle against the cycle's own bodies (all of them
//! run first). Anything it cannot place (an import of a name the module
//! does not export, a namespace whose names a module outside the cycle
//! decides) declines the link, and the host closes the cycle as it did
//! before.
//!
//! Its functions are built for size (`#[optimize(size)]`) in a crate built
//! for speed (rust/Cargo.toml): a document links a cycle once, if at all.
use std::collections::HashMap;

use edits::{Edit, Piece};
use oxc::allocator::Allocator;
use oxc::ast::ast::*;
use oxc::ast_visit::{Visit, walk};
use oxc::parser::Parser;
use oxc::span::{GetSpan, SourceType, Span};
use oxc::syntax::operator::AssignmentOperator;
use oxc::syntax::scope::{ScopeFlags, ScopeId};

/// what an import names: a module of the cycle, or another by its
/// specifier and the attributes written with it
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
enum Source {
	Member(usize),
	Outside(String, String),
}

#[derive(Clone, PartialEq, Eq, Debug)]
enum Imported {
	Name(String),
	Namespace,
}

#[derive(Clone, PartialEq, Eq, Debug)]
enum Export {
	/// a binding of the module's top
	Local(String),
	From(Source, String),
	Namespace(Source),
}

/// what an export comes to
#[derive(Clone, PartialEq, Eq, Debug)]
enum Target {
	/// a top-level binding of a member (an import from outside included)
	Binding(usize, String),
	/// a member's namespace
	Namespace(usize),
	/// a module outside's export or namespace, which no binding imports
	Outside(Source, Imported),
}

/// the binding of an anonymous `export default`
const DEFAULT: &str = "*default*";

struct Scope<'a> {
	parent: usize,
	/// `var` declares here
	var: bool,
	names: Vec<&'a str>,
}

struct Ref<'a> {
	name: &'a str,
	scope: usize,
	span: Span,
	/// `{name}`: the name stays as the key
	shorthand: bool,
}

struct Decl<'a> {
	name: &'a str,
	span: Span,
	shorthand: bool,
}

/// a top-level function or class, whose `name` a rename would change
enum Fix {
	Function,
	/// at the end of the declaration; none when it has a static `name`
	Class(Option<u32>),
}

/// an anonymous function a name gives its `name` to
enum Named {
	Decl(usize),
	Ref(usize),
}

enum Default {
	Expression { prefix: Span, end: u32, anonymous: bool },
	Function { prefix: Span, at: u32 },
	Class { prefix: Span, at: u32, end: Option<u32> },
}

/// One module of the cycle, walked
struct Member<'a> {
	text: &'a str,
	scopes: Vec<Scope<'a>>,
	refs: Vec<Ref<'a>>,
	/// the top level's declarations
	decls: Vec<Decl<'a>>,
	metas: Vec<Span>,
	named: Vec<(Span, Named)>,
	fixes: Vec<(&'a str, Fix)>,
	imports: Vec<(&'a str, Source, Imported)>,
	exports: Vec<(String, Export)>,
	stars: Vec<Source>,
	/// the modules it imports, in order
	requested: Vec<Source>,
	removed: Vec<Span>,
	default: Option<Default>,
}

struct Walk<'a> {
	m: Member<'a>,
	current: usize,
	stack: Vec<usize>,
	var_kind: bool,
	shorthand: bool,
}

impl<'a> Walk<'a> {
	#[optimize(size)]
	fn enter(&mut self, var: bool) {
		self.stack.push(self.current);
		self.m.scopes.push(Scope {
			parent: self.current,
			var,
			names: Vec::new(),
		});
		self.current = self.m.scopes.len() - 1;
	}

	#[optimize(size)]
	fn leave(&mut self) {
		self.current = self.stack.pop().unwrap_or(0);
	}

	#[optimize(size)]
	fn declare(&mut self, name: &'a str, span: Span, scope: usize) {
		let shorthand = std::mem::take(&mut self.shorthand);
		self.m.scopes[scope].names.push(name);
		if scope == 0 {
			self.m.decls.push(Decl { name, span, shorthand });
		}
	}

	#[optimize(size)]
	fn reference(&mut self, it: &IdentifierReference<'a>, shorthand: bool) {
		self.m.refs.push(Ref {
			name: it.name.as_str(),
			scope: self.current,
			span: it.span,
			shorthand,
		});
	}
}

/// whether a class has a static member `name`, which its `name` is then
#[optimize(size)]
fn static_name(class: &Class) -> bool {
	// (the key's own text: oxc's static name of a numeric key formats the
	// number, which would bring the float printer into the module)
	let name = |key: &PropertyKey| match key {
		PropertyKey::StaticIdentifier(id) => id.name == "name",
		PropertyKey::StringLiteral(literal) => literal.value.as_str() == Some("name"),
		_ => false,
	};
	class.body.body.iter().any(|element| match element {
		ClassElement::MethodDefinition(it) => it.r#static && name(&it.key),
		ClassElement::PropertyDefinition(it) => it.r#static && name(&it.key),
		ClassElement::AccessorProperty(it) => it.r#static && name(&it.key),
		_ => false,
	})
}

impl<'a> Visit<'a> for Walk<'a> {
	#[optimize(size)]
	fn enter_scope(&mut self, flags: ScopeFlags, _: &std::cell::Cell<Option<ScopeId>>) {
		self.enter(flags.contains(ScopeFlags::ClassStaticBlock));
	}

	#[optimize(size)]
	fn leave_scope(&mut self) {
		self.leave();
	}

	#[optimize(size)]
	fn visit_function(&mut self, it: &Function<'a>, _: ScopeFlags) {
		let kind = std::mem::take(&mut self.var_kind);
		let mut named = false;
		if let Some(id) = &it.id {
			if it.r#type == FunctionType::FunctionDeclaration {
				if self.current == 0 {
					self.m.fixes.push((id.name.as_str(), Fix::Function));
				}
				self.declare(id.name.as_str(), id.span, self.current);
			} else {
				self.enter(false);
				named = true;
				self.declare(id.name.as_str(), id.span, self.current);
			}
		}
		self.enter(false);
		self.visit_formal_parameters(&it.params);
		if let Some(body) = &it.body {
			self.enter(true);
			self.visit_function_body(body);
			self.leave();
		}
		self.leave();
		if named {
			self.leave();
		}
		self.var_kind = kind;
	}

	#[optimize(size)]
	fn visit_arrow_function_expression(&mut self, it: &ArrowFunctionExpression<'a>) {
		let kind = std::mem::take(&mut self.var_kind);
		self.enter(false);
		self.visit_formal_parameters(&it.params);
		self.enter(true);
		match &it.body {
			ArrowFunctionBody::FunctionBody(body) => self.visit_function_body(body),
			body => self.visit_expression(body.to_expression()),
		}
		self.leave();
		self.leave();
		self.var_kind = kind;
	}

	#[optimize(size)]
	fn visit_class(&mut self, it: &Class<'a>) {
		let kind = std::mem::take(&mut self.var_kind);
		let declaration = it.r#type == ClassType::ClassDeclaration;
		if let (true, Some(id)) = (declaration, &it.id) {
			if self.current == 0 {
				let end = (!static_name(it)).then_some(it.span.end);
				self.m.fixes.push((id.name.as_str(), Fix::Class(end)));
			}
			self.declare(id.name.as_str(), id.span, self.current);
		}
		self.enter(false);
		if let (false, Some(id)) = (declaration, &it.id) {
			self.declare(id.name.as_str(), id.span, self.current);
		}
		if let Some(heritage) = &it.heritage {
			self.visit_expression(&heritage.expression);
		}
		for element in &it.body.body {
			match element {
				ClassElement::MethodDefinition(method) => {
					if method.computed {
						self.visit_property_key(&method.key);
					}
					self.visit_function(&method.value, ScopeFlags::Function);
				}
				ClassElement::PropertyDefinition(property) => {
					if property.computed {
						self.visit_property_key(&property.key);
					}
					if let Some(value) = &property.value {
						self.enter(true);
						self.visit_expression(value);
						self.leave();
					}
				}
				ClassElement::AccessorProperty(property) => {
					if property.computed {
						self.visit_property_key(&property.key);
					}
					if let Some(value) = &property.value {
						self.enter(true);
						self.visit_expression(value);
						self.leave();
					}
				}
				ClassElement::StaticBlock(block) => self.visit_static_block(block),
				ClassElement::TSIndexSignature(_) => {}
			}
		}
		self.leave();
		self.var_kind = kind;
	}

	#[optimize(size)]
	fn visit_variable_declaration(&mut self, it: &VariableDeclaration<'a>) {
		let kind = self.var_kind;
		for declarator in &it.declarations {
			self.var_kind = it.kind.is_var();
			let declared = self.m.decls.len();
			self.visit_binding_pattern(&declarator.id);
			self.var_kind = false;
			if let Some(init) = &declarator.init {
				if self.m.decls.len() > declared
					&& matches!(declarator.id, BindingPattern::BindingIdentifier(_))
					&& init.is_anonymous_function_definition()
				{
					self.m.named.push((init.span(), Named::Decl(declared)));
				}
				self.visit_expression(init);
			}
		}
		self.var_kind = kind;
	}

	#[optimize(size)]
	fn visit_binding_identifier(&mut self, it: &BindingIdentifier<'a>) {
		let mut scope = self.current;
		if self.var_kind {
			while !self.m.scopes[scope].var {
				scope = self.m.scopes[scope].parent;
			}
		}
		self.declare(it.name.as_str(), it.span, scope);
	}

	#[optimize(size)]
	fn visit_binding_property(&mut self, it: &BindingProperty<'a>) {
		if it.computed {
			self.visit_property_key(&it.key);
		}
		self.shorthand = it.shorthand;
		self.visit_binding_pattern(&it.value);
		self.shorthand = false;
	}

	#[optimize(size)]
	fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
		self.reference(it, false);
	}

	#[optimize(size)]
	fn visit_object_property(&mut self, it: &ObjectProperty<'a>) {
		if let (true, Expression::Identifier(id)) = (it.shorthand, &it.value) {
			self.reference(id, true);
			return;
		}
		walk::walk_object_property(self, it);
	}

	#[optimize(size)]
	fn visit_assignment_target_property_identifier(&mut self, it: &AssignmentTargetPropertyIdentifier<'a>) {
		self.reference(&it.binding, true);
		if let Some(init) = &it.init {
			self.visit_expression(init);
		}
	}

	#[optimize(size)]
	fn visit_assignment_expression(&mut self, it: &AssignmentExpression<'a>) {
		let at = self.m.refs.len();
		walk::walk_assignment_expression(self, it);
		if matches!(
			it.operator,
			AssignmentOperator::Assign
				| AssignmentOperator::LogicalAnd
				| AssignmentOperator::LogicalOr
				| AssignmentOperator::LogicalNullish
		) && matches!(it.left, AssignmentTarget::AssignmentTargetIdentifier(_))
			&& it.right.is_anonymous_function_definition()
		{
			self.m.named.push((it.right.span(), Named::Ref(at)));
		}
	}

	#[optimize(size)]
	fn visit_import_meta(&mut self, it: &ImportMeta) {
		self.m.metas.push(it.span);
	}
}

/// what `literal` (with `with`) names, of `count` members
#[optimize(size)]
fn source_of(text: &str, literal: &StringLiteral, with: &Option<oxc::allocator::Box<WithClause>>, count: usize) -> Option<Source> {
	let value = literal.value.as_str()?;
	if let Some(index) = value.strip_prefix('\u{1}') {
		let index: usize = index.parse().ok()?;
		return (index < count).then_some(Source::Member(index));
	}
	// (`with` and the attributes as written: the clause's span leaves out
	// the keyword)
	let attributes = with.as_ref().map_or("", |with| text[literal.span.end as usize..with.span.end as usize].trim());
	Some(Source::Outside(value.to_owned(), attributes.to_owned()))
}

#[optimize(size)]
fn walk_member<'a>(allocator: &'a Allocator, text: &'a str, count: usize) -> Option<Member<'a>> {
	let parsed = Parser::new(allocator, text, SourceType::mjs()).parse();
	if parsed.fatal_error || parsed.diagnostics.has_errors() {
		return None;
	}
	let program = parsed.program;
	let mut walk = Walk {
		m: Member {
			text,
			scopes: vec![Scope {
				parent: 0,
				var: true,
				names: Vec::new(),
			}],
			refs: Vec::new(),
			decls: Vec::new(),
			metas: Vec::new(),
			named: Vec::new(),
			fixes: Vec::new(),
			imports: Vec::new(),
			exports: Vec::new(),
			stars: Vec::new(),
			requested: Vec::new(),
			removed: Vec::new(),
			default: None,
		},
		current: 0,
		stack: Vec::new(),
		var_kind: false,
		shorthand: false,
	};
	if let Some(hashbang) = &program.hashbang {
		walk.m.removed.push(hashbang.span);
	}
	for statement in &program.body {
		match statement {
			Statement::ImportDeclaration(it) => {
				let from = source_of(text, &it.source, &it.with_clause, count)?;
				if it.phase.is_some() {
					return None;
				}
				walk.m.requested.push(from.clone());
				walk.m.removed.push(it.span);
				for specifier in it.specifiers.iter().flatten() {
					let (local, imported) = match specifier {
						ImportDeclarationSpecifier::ImportSpecifier(it) => {
							(&it.local, Imported::Name(it.imported.name().to_string()))
						}
						ImportDeclarationSpecifier::ImportDefaultSpecifier(it) => {
							(&it.local, Imported::Name("default".into()))
						}
						ImportDeclarationSpecifier::ImportNamespaceSpecifier(it) => (&it.local, Imported::Namespace),
					};
					walk.m.scopes[0].names.push(local.name.as_str());
					walk.m.imports.push((local.name.as_str(), from.clone(), imported));
				}
			}
			Statement::ExportAllDeclaration(it) => {
				let from = source_of(text, &it.source, &it.with_clause, count)?;
				walk.m.requested.push(from.clone());
				walk.m.removed.push(it.span);
				match &it.exported {
					Some(name) => walk.m.exports.push((name.name().to_string(), Export::Namespace(from))),
					None => walk.m.stars.push(from),
				}
			}
			Statement::ExportFromDeclaration(it) => {
				let from = source_of(text, &it.source, &it.with_clause, count)?;
				walk.m.requested.push(from.clone());
				walk.m.removed.push(it.span);
				for specifier in &it.specifiers {
					walk.m.exports.push((
						specifier.exported.name().to_string(),
						Export::From(from.clone(), specifier.local.name().to_string()),
					));
				}
			}
			Statement::ExportNamedDeclaration(it) => {
				walk.m.removed.push(it.span);
				for specifier in &it.specifiers {
					walk.m.exports.push((
						specifier.exported.name().to_string(),
						Export::Local(specifier.local.name().to_string()),
					));
				}
			}
			Statement::ExportDeclaration(it) => {
				walk.m.removed.push(Span::new(it.span.start, it.declaration.span().start));
				let declared = walk.m.decls.len();
				walk.visit_declaration(&it.declaration);
				for decl in &walk.m.decls[declared..] {
					walk.m.exports.push((decl.name.to_owned(), Export::Local(decl.name.to_owned())));
				}
			}
			Statement::ExportDefaultDeclaration(it) => {
				let local = match &it.declaration {
					ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
						let prefix = Span::new(it.span.start, function.span.start);
						walk.visit_function(function, ScopeFlags::Function);
						match &function.id {
							Some(id) => {
								walk.m.removed.push(prefix);
								id.name.to_string()
							}
							None => {
								walk.m.default = Some(Default::Function {
									prefix,
									at: function.params.span.start,
								});
								DEFAULT.into()
							}
						}
					}
					ExportDefaultDeclarationKind::ClassDeclaration(class) => {
						let prefix = Span::new(it.span.start, class.span.start);
						walk.visit_class(class);
						match &class.id {
							Some(id) => {
								walk.m.removed.push(prefix);
								id.name.to_string()
							}
							None => {
								if !text[class.span.start as usize..].starts_with("class") {
									return None;
								}
								walk.m.default = Some(Default::Class {
									prefix,
									at: class.span.start + 5,
									end: (!static_name(class)).then_some(class.span.end),
								});
								DEFAULT.into()
							}
						}
					}
					kind => {
						let expression = kind.as_expression()?;
						walk.m.default = Some(Default::Expression {
							prefix: Span::new(it.span.start, expression.span().start),
							end: expression.span().end,
							anonymous: expression.is_anonymous_function_definition(),
						});
						walk.visit_expression(expression);
						DEFAULT.into()
					}
				};
				walk.m.exports.push(("default".into(), Export::Local(local)));
			}
			Statement::TSExportAssignment(_) | Statement::TSNamespaceExportDeclaration(_) => return None,
			statement => walk.visit_statement(statement),
		}
	}
	Some(walk.m)
}

/// `text` as a string literal
#[optimize(size)]
fn quote(text: &str) -> String {
	let mut out = String::with_capacity(text.len() + 2);
	out.push('"');
	for c in text.chars() {
		match c {
			'"' => out.push_str("\\\""),
			'\\' => out.push_str("\\\\"),
			'\n' => out.push_str("\\n"),
			'\r' => out.push_str("\\r"),
			'\u{2028}' => out.push_str("\\u2028"),
			'\u{2029}' => out.push_str("\\u2029"),
			c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
			c => out.push(c),
		}
	}
	out.push('"');
	out
}

/// `from "specifier" attributes`
#[optimize(size)]
fn from(source: &Source) -> String {
	match source {
		Source::Outside(specifier, attributes) if attributes.is_empty() => format!("from {}", quote(specifier)),
		Source::Outside(specifier, attributes) => format!("from {} {attributes}", quote(specifier)),
		Source::Member(_) => unreachable!(),
	}
}

struct Linker<'a> {
	members: Vec<Member<'a>>,
}

impl<'a> Linker<'a> {
	/// the scope `name` resolves to from `scope` of member `m`, or None (a global)
	#[optimize(size)]
	fn resolve(&self, m: usize, name: &str, mut scope: usize) -> Option<usize> {
		let scopes = &self.members[m].scopes;
		loop {
			if scopes[scope].names.contains(&name) {
				return Some(scope);
			}
			if scope == 0 {
				return None;
			}
			scope = scopes[scope].parent;
		}
	}

	/// whether a scope from `scope` up to the top (not counting it) of member `m` declares `name`
	#[optimize(size)]
	fn shadowed(&self, m: usize, name: &str, mut scope: usize) -> bool {
		let scopes = &self.members[m].scopes;
		while scope != 0 {
			if scopes[scope].names.contains(&name) {
				return true;
			}
			scope = scopes[scope].parent;
		}
		false
	}

	#[optimize(size)]
	fn import_of(&self, m: usize, local: &str) -> Option<&(&'a str, Source, Imported)> {
		self.members[m].imports.iter().find(|(name, ..)| *name == local)
	}

	/// what the top-level binding `local` of member `m` is
	#[optimize(size)]
	fn local(&self, m: usize, local: &str, seen: &mut Vec<(usize, String)>) -> Option<Target> {
		match self.import_of(m, local) {
			Some((_, Source::Member(j), Imported::Name(name))) => self.export(*j, name, seen),
			Some((_, Source::Member(j), Imported::Namespace)) => Some(Target::Namespace(*j)),
			Some(_) => Some(Target::Binding(m, local.to_owned())),
			None if local == DEFAULT || self.members[m].scopes[0].names.contains(&local) => {
				Some(Target::Binding(m, local.to_owned()))
			}
			None => None,
		}
	}

	/// what export `name` of member `m` is: None when it has none, or it is ambiguous
	#[optimize(size)]
	fn export(&self, m: usize, name: &str, seen: &mut Vec<(usize, String)>) -> Option<Target> {
		if seen.iter().any(|(j, n)| *j == m && n == name) {
			return None;
		}
		seen.push((m, name.to_owned()));
		let found = self.export_in(m, name, seen);
		seen.pop();
		found
	}

	#[optimize(size)]
	fn export_in(&self, m: usize, name: &str, seen: &mut Vec<(usize, String)>) -> Option<Target> {
		let member = &self.members[m];
		if let Some((_, export)) = member.exports.iter().find(|(n, _)| n == name) {
			return match export {
				Export::Local(local) => self.local(m, local, seen),
				Export::From(Source::Member(j), imported) => self.export(*j, imported, seen),
				Export::From(source, imported) => {
					Some(Target::Outside(source.clone(), Imported::Name(imported.clone())))
				}
				Export::Namespace(Source::Member(j)) => Some(Target::Namespace(*j)),
				Export::Namespace(source) => Some(Target::Outside(source.clone(), Imported::Namespace)),
			};
		}
		if name == "default" {
			return None;
		}
		let mut found: Option<Target> = None;
		let mut outside = Vec::new();
		for star in &member.stars {
			match star {
				Source::Member(j) => {
					if let Some(target) = self.export(*j, name, seen) {
						if found.as_ref().is_some_and(|found| *found != target) {
							return None;
						}
						found = Some(target);
					}
				}
				source => outside.push(source),
			}
		}
		match (found, outside.as_slice()) {
			(None, [source]) => Some(Target::Outside((*source).clone(), Imported::Name(name.to_owned()))),
			(found, _) => found,
		}
	}

	/// the export names of member `m`, and the modules outside whose names it exports by `*`
	#[optimize(size)]
	fn names(&self, m: usize, names: &mut Vec<String>, outside: &mut Vec<Source>, seen: &mut Vec<usize>, top: bool) {
		if seen.contains(&m) {
			return;
		}
		seen.push(m);
		let member = &self.members[m];
		for (name, _) in &member.exports {
			if (top || name != "default") && !names.contains(name) {
				names.push(name.clone());
			}
		}
		for star in &member.stars {
			match star {
				Source::Member(j) => self.names(*j, names, outside, seen, false),
				source => {
					if !outside.contains(source) {
						outside.push(source.clone());
					}
				}
			}
		}
	}
}

/// names by member (or 0): the one map type of the crate's (src/early.rs
/// has it), so the module holds no other map's code
type Map<'a> = HashMap<(&'a str, usize), usize>;

/// fresh names: none a module writes, none given before
struct Names<'a> {
	all: Map<'a>,
	made: Vec<String>,
}

impl Names<'_> {
	#[optimize(size)]
	fn fresh(&mut self, base: &str) -> String {
		let base = base.trim_matches('*');
		let name = (1..)
			.map(|k| format!("{base}${k}"))
			.find(|name| !self.all.contains_key(&(name.as_str(), 0)) && !self.made.contains(name))
			.unwrap();
		self.made.push(name.clone());
		name
	}
}

/// the name binding `name` of member `m` is given in the merged module, when it is not its own
#[optimize(size)]
fn renamed<'s>(index: &Map<'s>, given: &'s [String], m: usize, name: &'s str) -> Option<&'s String> {
	index.get(&(name, m)).map(|&at| &given[at]).filter(|given| given.as_str() != name)
}

/// what member `m`'s import `local` of another member reads
#[optimize(size)]
fn alias<'t>(aliases: &'t [(&str, Target)], local: &str) -> Option<&'t Target> {
	aliases.iter().find(|(name, _)| *name == local).map(|(_, target)| target)
}

/// what the merged module makes besides the members' text
struct Head<'f, 'a> {
	index: &'f Map<'a>,
	given: &'f [String],
	names: Names<'a>,
	/// its imports
	text: String,
	outside: Vec<(Source, Imported, String)>,
	/// the namespace objects asked for, by member
	namespaces: Vec<(usize, String)>,
}

impl Head<'_, '_> {
	/// the text that reads `target` in the merged module
	#[optimize(size)]
	fn read(&mut self, target: &Target) -> String {
		match target {
			Target::Binding(m, name) => self.given[self.index[&(name.as_str(), *m)]].clone(),
			Target::Namespace(m) => match self.namespaces.iter().find(|(j, _)| j == m) {
				Some((_, name)) => name.clone(),
				None => {
					let name = self.names.fresh("namespace");
					self.namespaces.push((*m, name.clone()));
					name
				}
			},
			Target::Outside(source, imported) => {
				if let Some((.., name)) = self.outside.iter().find(|(s, i, _)| s == source && i == imported) {
					return name.clone();
				}
				let name = self.names.fresh("imported");
				self.text.push_str(&import(source, imported, &name));
				self.outside.push((source.clone(), imported.clone(), name.clone()));
				name
			}
		}
	}
}

/// `import ... as local from ...`
#[optimize(size)]
fn import(source: &Source, imported: &Imported, local: &str) -> String {
	match imported {
		Imported::Name(imported) => format!("import {{ {} as {local} }} {};\n", quote(imported), from(source)),
		Imported::Namespace => format!("import * as {local} {};\n", from(source)),
	}
}

/// `Object.defineProperty(name, "name", ...)`: the `name` a function had
#[optimize(size)]
fn fix(name: &str, was: &str) -> String {
	format!("Object.defineProperty({name}, \"name\", {{ value: {} }});", quote(was))
}

/// The cycle `input` merged (see the module's comment), or None
#[optimize(size)]
pub fn link(input: &str) -> Option<String> {
	let texts: Vec<&str> = input.split('\0').collect();
	let count = texts.len();
	let allocators: Vec<Allocator> = texts.iter().map(|_| Allocator::default()).collect();
	let mut members = Vec::with_capacity(count);
	for (text, allocator) in texts.iter().zip(&allocators) {
		members.push(walk_member(allocator, text, count)?);
	}
	let linker = Linker { members };
	let members = &linker.members;

	// the order the browser runs them in, and the modules outside first run
	let mut order = Vec::with_capacity(count);
	let mut outside: Vec<Source> = Vec::new();
	let mut visited = vec![false; count];
	#[optimize(size)]
	fn visit(m: usize, members: &[Member], visited: &mut [bool], order: &mut Vec<usize>, outside: &mut Vec<Source>) {
		visited[m] = true;
		for source in &members[m].requested {
			match source {
				Source::Member(j) if !visited[*j] => visit(*j, members, visited, order, outside),
				Source::Member(_) => {}
				source => {
					if !outside.contains(source) {
						outside.push(source.clone());
					}
				}
			}
		}
		order.push(m);
	}
	for m in 0..count {
		if !visited[m] {
			visit(m, members, &mut visited, &mut order, &mut outside);
		}
	}

	// every name a module reads as a global (and those the merge reads), and
	// every name written anywhere
	let mut free = Map::new();
	let mut all = Map::new();
	for name in ["Object", "Symbol"] {
		free.insert((name, 0), 0);
		all.insert((name, 0), 0);
	}
	for (m, member) in members.iter().enumerate() {
		for scope in &member.scopes {
			for name in &scope.names {
				all.insert((name, 0), 0);
			}
		}
		for r in &member.refs {
			all.insert((r.name, 0), 0);
			if linker.resolve(m, r.name, r.scope).is_none() {
				free.insert((r.name, 0), 0);
			}
		}
	}
	let mut names = Names { all, made: Vec::new() };

	// the merged module's own bindings: each member's top level, its imports
	// from outside, its anonymous default
	let mut bindings: Vec<(usize, &str)> = Vec::new();
	let mut bound = Map::new();
	for (m, member) in members.iter().enumerate() {
		let own = member.decls.iter().map(|decl| decl.name);
		let imported = member
			.imports
			.iter()
			.filter(|(_, from, _)| matches!(from, Source::Outside(..)))
			.map(|(local, ..)| *local);
		let default = member.default.is_some().then_some(DEFAULT);
		for name in own.chain(imported).chain(default) {
			if !bound.contains_key(&(name, m)) {
				bound.insert((name, m), 0);
				bindings.push((m, name));
			}
		}
	}
	// what each member's imports of the others read
	let mut aliases: Vec<Vec<(&str, Target)>> = Vec::with_capacity(count);
	for (m, member) in members.iter().enumerate() {
		let mut read = Vec::new();
		for (local, from, _) in &member.imports {
			if let Source::Member(_) = from {
				read.push((*local, linker.local(m, local, &mut Vec::new())?));
			}
		}
		aliases.push(read);
	}
	// a binding keeps its name unless one before it took it, a module reads
	// it as a global, or another module reads it where a scope of its own
	// declares the name (a fresh name is none a module writes)
	let mut forced = Map::new();
	let mut index: Map;
	let mut given: Vec<String>;
	loop {
		index = Map::new();
		given = Vec::with_capacity(bindings.len());
		let mut taken = Map::new();
		for &(m, name) in &bindings {
			let fresh = name == DEFAULT
				|| forced.contains_key(&(name, m))
				|| free.contains_key(&(name, 0))
				|| taken.contains_key(&(name, 0));
			index.insert((name, m), given.len());
			given.push(if fresh {
				names.fresh(name)
			} else {
				taken.insert((name, 0), 0);
				name.to_owned()
			});
		}
		let mut changed = false;
		for (m, member) in members.iter().enumerate() {
			for r in &member.refs {
				if let Some(Target::Binding(j, name)) = alias(&aliases[m], r.name) {
					let target = &given[*index.get(&(name.as_str(), *j))?];
					if target != r.name
						&& linker.resolve(m, r.name, r.scope) == Some(0)
						&& linker.shadowed(m, target, r.scope)
						&& !forced.contains_key(&(name.as_str(), *j))
					{
						forced.insert((name.as_str(), *j), 0);
						changed = true;
					}
				}
			}
		}
		if !changed {
			break;
		}
	}

	let mut head = Head {
		index: &index,
		given: &given,
		names,
		text: String::new(),
		outside: Vec::new(),
		namespaces: Vec::new(),
	};
	for source in &outside {
		head.text.push_str(&format!("import {};\n", &from(source)[5..]));
	}
	for (m, member) in members.iter().enumerate() {
		for (local, source, imported) in &member.imports {
			if let Source::Outside(..) = source {
				head.text.push_str(&import(source, imported, &given[index[&(*local, m)]]));
			}
		}
	}

	// each member's text, edited
	let mut bodies: Vec<String> = vec![String::new(); count];
	let mut fixes = String::new();
	for (m, member) in members.iter().enumerate() {
		let mut edits: Vec<Edit> = member
			.removed
			.iter()
			.map(|span| Edit::replace(edits::Span::new(span.start, span.end), vec![]))
			.collect();
		let replace = |span: Span, text: String| Edit::replace(edits::Span::new(span.start, span.end), vec![Piece::Text(text)]);
		let renamed = |name| renamed(&index, &given, m, name);
		for decl in &member.decls {
			if let Some(given) = renamed(decl.name) {
				edits.push(replace(decl.span, if decl.shorthand { format!("{}: {given}", decl.name) } else { given.clone() }));
			}
		}
		let mut reads: Vec<bool> = Vec::with_capacity(member.refs.len());
		for r in &member.refs {
			let read = if linker.resolve(m, r.name, r.scope) != Some(0) {
				None
			} else if let Some(target) = alias(&aliases[m], r.name) {
				Some(head.read(target))
			} else {
				renamed(r.name).cloned()
			};
			reads.push(read.is_some());
			if let Some(read) = read {
				edits.push(replace(r.span, if r.shorthand { format!("{}: {read}", r.name) } else { read }));
			}
		}
		if !member.metas.is_empty() {
			let meta = head.names.fresh("meta");
			head.text.push_str(&format!(
				"const {meta} = {{ __proto__: null, url: import.meta.url, resolve: import.meta.resolve }};\n"
			));
			for span in &member.metas {
				edits.push(replace(*span, meta.clone()));
			}
		}
		for (span, named) in &member.named {
			let was = match named {
				Named::Decl(i) => Some(member.decls[*i].name).filter(|name| renamed(*name).is_some()),
				Named::Ref(i) => member
					.refs
					.get(*i)
					.filter(|r| reads[*i] && alias(&aliases[m], r.name).is_none())
					.map(|r| r.name),
			};
			if let Some(was) = was {
				let key = quote(was);
				edits.push(Edit::wrap(
					edits::Span::new(span.start, span.end),
					vec![Piece::Text(format!("{{{key}: "))],
					vec![Piece::Text(format!("}}[{key}]"))],
				));
			}
		}
		for (was, kind) in &member.fixes {
			if let Some(given) = renamed(*was) {
				match kind {
					Fix::Function => fixes.push_str(&fix(given, was)),
					Fix::Class(Some(end)) => {
						edits.push(Edit::insert(*end, vec![Piece::Text(format!("\n{}", fix(given, was)))], 0))
					}
					Fix::Class(None) => {}
				}
			}
		}
		if let Some(default) = &member.default {
			let given = &given[index[&(DEFAULT, m)]];
			match default {
				Default::Expression { prefix, end, anonymous } => {
					let open = if *anonymous { "{\"default\": " } else { "" };
					edits.push(replace(*prefix, format!("const {given} = {open}")));
					if *anonymous {
						edits.push(Edit::insert(*end, vec![Piece::Text("}[\"default\"]".into())], 0));
					}
				}
				Default::Function { prefix, at } => {
					edits.push(replace(*prefix, String::new()));
					edits.push(Edit::insert(*at, vec![Piece::Text(format!(" {given}"))], 0));
					fixes.push_str(&fix(given, "default"));
				}
				Default::Class { prefix, at, end } => {
					edits.push(replace(*prefix, String::new()));
					edits.push(Edit::insert(*at, vec![Piece::Text(format!(" {given}"))], 0));
					if let Some(end) = end {
						edits.push(Edit::insert(*end, vec![Piece::Text(format!("\n{}", fix(given, "default")))], 0));
					}
				}
			}
		}
		bodies[m] = edits::apply(member.text, edits).ok()?;
	}

	// each member's facade
	let mut exported: Vec<String> = Vec::new();
	let mut facades: Vec<String> = Vec::with_capacity(count);
	for m in 0..count {
		let mut export_names = Vec::new();
		let mut stars = Vec::new();
		linker.names(m, &mut export_names, &mut stars, &mut Vec::new(), true);
		let mut through = Vec::new();
		let mut facade = String::from("import \"\u{1}\";\n");
		for name in &export_names {
			let explicit = members[m].exports.iter().any(|(n, _)| n == name);
			let target = match linker.export(m, name, &mut Vec::new()) {
				Some(target) => target,
				// (a name two `*` exports bring apart is no export, as natively)
				None if !explicit => continue,
				None => return None,
			};
			match &target {
				Target::Outside(source, Imported::Name(imported)) => {
					facade.push_str(&format!("export {{ {} as {} }} {};\n", quote(imported), quote(name), from(source)))
				}
				Target::Outside(source, Imported::Namespace) => {
					facade.push_str(&format!("export * as {} {};\n", quote(name), from(source)))
				}
				target => {
					let read = head.read(target);
					through.push(format!("{read} as {}", quote(name)));
					if !exported.contains(&read) {
						exported.push(read);
					}
				}
			}
		}
		if !through.is_empty() {
			facade.push_str(&format!("export {{ {} }} from \"\u{1}\";\n", through.join(", ")));
		}
		for source in &stars {
			facade.push_str(&format!("export * {};\n", from(source)));
		}
		facades.push(facade);
	}

	// the namespaces a `*` import of a member reads (one may ask for more)
	let mut objects = String::new();
	let mut at = 0;
	while at < head.namespaces.len() {
		let (m, name) = head.namespaces[at].clone();
		let mut export_names = Vec::new();
		let mut stars = Vec::new();
		linker.names(m, &mut export_names, &mut stars, &mut Vec::new(), true);
		if !stars.is_empty() {
			return None;
		}
		export_names.sort();
		let mut getters = Vec::new();
		for export in &export_names {
			if let Some(target) = linker.export(m, export, &mut Vec::new()) {
				getters.push(format!("get {}() {{ return {}; }}", quote(export), head.read(&target)));
			}
		}
		objects.push_str(&format!(
			"const {name} = Object.freeze(Object.defineProperty({{ __proto__: null, {} }}, Symbol.toStringTag, {{ value: \"Module\" }}));\n",
			getters.join(", ")
		));
		at += 1;
	}

	let mut out = head.text;
	out.push_str(&fixes);
	out.push('\n');
	out.push_str(&objects);
	for m in &order {
		out.push_str(&bodies[*m]);
		out.push('\n');
	}
	if !exported.is_empty() {
		out.push_str(&format!("export {{ {} }};\n", exported.join(", ")));
	}
	for facade in facades {
		out.push('\0');
		out.push_str(&facade);
	}
	Some(out)
}

#[cfg(test)]
mod tests {
	use super::link;

	fn linked(members: &[&str]) -> (String, Vec<String>) {
		let out = link(&members.join("\0")).expect("links");
		let mut parts = out.split('\0').map(str::to_owned);
		(parts.next().unwrap(), parts.collect())
	}

	#[test]
	fn two_modules() {
		let (merged, facades) = linked(&[
			"import { y } from '\u{1}1'; export const x = 'x'; export const both = () => `${x}${y}`;",
			"import { x } from '\u{1}0'; export const y = 'y'; export const seen = () => x;",
		]);
		// b runs first, then a; the imports read the bindings themselves
		let b = merged.find("const y = 'y'").unwrap();
		let a = merged.find("const x = 'x'").unwrap();
		assert!(b < a, "{merged}");
		assert!(merged.contains("`${x}${y}`"), "{merged}");
		assert!(merged.contains("export { x as \"x\"") || merged.contains("export { x, both"), "{merged}");
		assert!(facades[0].contains("x as \"x\""), "{}", facades[0]);
		assert!(facades[1].contains("seen as \"seen\""), "{}", facades[1]);
	}

	#[test]
	fn collisions_rename() {
		let (merged, _) = linked(&[
			"import { f } from '\u{1}1'; function helper() { return 1; } const g = () => 0; export const a = helper() + f();",
			"import { a } from '\u{1}0'; function helper() { return 2; } const g = () => 0; export function f() { return helper(); }",
		]);
		assert!(merged.contains("function helper$1()"), "{merged}");
		assert!(merged.contains("return helper$1();"), "{merged}");
		assert!(merged.contains("Object.defineProperty(helper$1, \"name\", { value: \"helper\" })"), "{merged}");
		assert!(merged.contains("const g$1 = {\"g\": () => 0}[\"g\"]"), "{merged}");
	}

	#[test]
	fn shadowing_and_globals() {
		let (merged, _) = linked(&[
			"import { v } from '\u{1}1'; export const w = (x) => { const v2 = v; return x + v2; }; export const read = () => { let v = 3; return v; };",
			"import { w } from '\u{1}0'; export let v = 1; const x = window; export function bump() { v++; }",
		]);
		// `x` is a parameter in one module and a binding in the other: no rename
		assert!(merged.contains("const x = window"), "{merged}");
		// the local `v` of read() stays
		assert!(merged.contains("let v = 3; return v;"), "{merged}");
	}

	#[test]
	fn shadowed_import_target_is_renamed() {
		let (merged, _) = linked(&[
			"import { v as value } from '\u{1}1'; export const f = () => { const v = 2; return value + v; };",
			"import { f } from '\u{1}0'; export let v = 1;",
		]);
		assert!(merged.contains("let v$1 = 1"), "{merged}");
		assert!(merged.contains("return v$1 + v;"), "{merged}");
	}

	#[test]
	fn global_names_stay_free() {
		let (merged, _) = linked(&[
			"import { b } from '\u{1}1'; export const a = () => document.title + b;",
			"import { a } from '\u{1}0'; const document = 1; export const b = document;",
		]);
		assert!(merged.contains("const document$1 = 1"), "{merged}");
		assert!(merged.contains("document.title"), "{merged}");
	}

	#[test]
	fn import_meta_per_module() {
		let (merged, _) = linked(&[
			"import.meta.url = 'a';import { b } from '\u{1}1'; export const a = () => import.meta.url;",
			"import.meta.url = 'b';import { a } from '\u{1}0'; export const b = () => import.meta.url;",
		]);
		assert!(merged.contains("const meta$1 = { __proto__: null, url: import.meta.url"), "{merged}");
		assert!(merged.contains("meta$1.url = 'a'"), "{merged}");
		assert!(merged.contains("meta$2.url = 'b'"), "{merged}");
	}

	#[test]
	fn defaults_and_namespaces() {
		let (merged, facades) = linked(&[
			"import * as b from '\u{1}1'; export default function () { return b.value; }",
			"import run from '\u{1}0'; export const value = 1; export default class {}; export { run };",
		]);
		assert!(merged.contains("function  default$1()"), "{merged}");
		assert!(merged.contains("class default$2"), "{merged}");
		assert!(merged.contains("get \"default\"() { return default$2; }"), "{merged}");
		assert!(merged.contains("get \"run\"() { return default$1; }"), "{merged}");
		assert!(facades[1].contains("default$1 as \"run\""), "{}", facades[1]);
	}

	#[test]
	fn outside_imports_hoist_in_order() {
		let (merged, facades) = linked(&[
			"import '\u{1}1'; import { q } from 'blob:q'; export * from 'blob:s'; export const a = q;",
			"import { a } from '\u{1}0'; import json from 'blob:j' with { type: 'json' }; export { a as again };",
		]);
		let j = merged.find("import \"blob:j\" with { type: 'json' };").expect(&merged);
		let q = merged.find("import \"blob:q\";").unwrap();
		assert!(j < q, "{merged}");
		assert!(merged.contains("import { \"default\" as json } from \"blob:j\" with { type: 'json' };"), "{merged}");
		assert!(facades[0].contains("export * from \"blob:s\";"), "{}", facades[0]);
		assert!(facades[1].contains("a as \"again\""), "{}", facades[1]);
	}

	#[test]
	fn marks_in_comments_stay() {
		// (the rewrite keeps a module's text in a comment, with U+0001 in it)
		let (merged, facades) = linked(&[
			"/*\u{1}\u{3}*/import { b } from '\u{1}1'; export const a = () => b;",
			"import { a } from '\u{1}0'; export const b = '\u{1}';",
		]);
		assert!(merged.contains("/*\u{1}\u{3}*/"), "{merged}");
		assert_eq!(facades.len(), 2);
		assert_eq!(facades[1].matches('\u{1}').count(), 2, "{}", facades[1]);
	}

	#[test]
	fn missing_export_declines() {
		assert!(link("import { nope } from '\u{1}1';\0import '\u{1}0';").is_none());
	}

	#[test]
	fn shorthand_and_patterns() {
		let (merged, _) = linked(&[
			"import { v as w } from '\u{1}1'; export const o = { w }; export const { p, q: [r] } = o; let s; ({ s } = o);",
			"import { o } from '\u{1}0'; export const v = 1; const p = 2; export { o as again }; let s = 0;",
		]);
		assert!(merged.contains("const o = { w: v }"), "{merged}");
		assert!(merged.contains("const p$1 = 2"), "{merged}");
		assert!(merged.contains("({ s } = o)"), "{merged}");
		assert!(merged.contains("let s$1 = 0"), "{merged}");
	}
}
