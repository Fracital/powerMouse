//! What the rewriter asks of a node before it decides anything: the
//! predicates of src/rewriteJS.ts (`routesMember`, `printsHelper`, `pure`,
//! `postMessageCall`, `inOptionalChain`, `patternSpec`), over oxc's tree.
//! meriyah's tree has no parenthesized expression, so every question about
//! what a node is looks through parentheses first; only the optional chain
//! does not, because a parenthesis ends a chain.

use oxc::syntax::number::ToJsString;
use oxc::ast::ast::*;
use oxc::span::{GetSpan, Span};

use crate::config::Config;

/// the expression inside any parentheses
pub fn unparen<'b, 'a>(mut e: &'b Expression<'a>) -> &'b Expression<'a> {
	while let Expression::ParenthesizedExpression(p) = e {
		e = &p.expression;
	}
	e
}

/// A member expression of any kind, as ESTree has one node for the three
#[derive(Clone, Copy)]
pub enum Mem<'b, 'a> {
	Static(&'b StaticMemberExpression<'a>),
	Computed(&'b ComputedMemberExpression<'a>),
	Private(&'b PrivateFieldExpression<'a>),
}

impl<'b, 'a> Mem<'b, 'a> {
	pub fn of(e: &'b Expression<'a>) -> Option<Self> {
		match e {
			Expression::StaticMemberExpression(m) => Some(Mem::Static(m)),
			Expression::ComputedMemberExpression(m) => Some(Mem::Computed(m)),
			Expression::PrivateFieldExpression(m) => Some(Mem::Private(m)),
			_ => None,
		}
	}
	pub fn of_member(m: &'b MemberExpression<'a>) -> Self {
		match m {
			MemberExpression::StaticMemberExpression(m) => Mem::Static(m),
			MemberExpression::ComputedMemberExpression(m) => Mem::Computed(m),
			MemberExpression::PrivateFieldExpression(m) => Mem::Private(m),
		}
	}
	pub fn object(self) -> &'b Expression<'a> {
		match self {
			Mem::Static(m) => &m.object,
			Mem::Computed(m) => &m.object,
			Mem::Private(m) => &m.object,
		}
	}
	pub fn optional(self) -> bool {
		match self {
			Mem::Static(m) => m.optional,
			Mem::Computed(m) => m.optional,
			Mem::Private(m) => m.optional,
		}
	}
	pub fn span(self) -> Span {
		match self {
			Mem::Static(m) => m.span,
			Mem::Computed(m) => m.span,
			Mem::Private(m) => m.span,
		}
	}
	pub fn is_private(self) -> bool {
		matches!(self, Mem::Private(_))
	}
	pub fn on_super(self) -> bool {
		matches!(self.object(), Expression::Super(_))
	}
	/// the key when it is a name or a string literal (`o.k`, `o["k"]`)
	pub fn literal_key(self) -> Option<&'b str> {
		match self {
			Mem::Static(m) => Some(m.property.name.as_str()),
			Mem::Computed(m) => match unparen(&m.expression) {
				Expression::StringLiteral(s) => s.value.as_str(),
				_ => None,
			},
			Mem::Private(_) => None,
		}
	}
}

/// an ESTree `Literal`
pub fn is_literal(e: &Expression) -> bool {
	matches!(
		e,
		Expression::BooleanLiteral(_)
			| Expression::NullLiteral(_)
			| Expression::NumericLiteral(_)
			| Expression::BigIntLiteral(_)
			| Expression::RegExpLiteral(_)
			| Expression::StringLiteral(_)
	)
}

/// `0`, `17`: a string that is an array index as written
fn index_text(text: &str) -> bool {
	!text.is_empty()
		&& text.bytes().all(|b| b.is_ascii_digit())
		&& (text == "0" || !text.starts_with('0'))
}

/// `0`, `1e3`: a number that is an array index
fn index_number(value: f64) -> bool {
	value.is_finite() && value >= 0.0 && value.fract() == 0.0
}

/// a member whose key is a literal array index (`o[0]`, `o["1"]`)
fn literal_index(m: Mem) -> bool {
	match m {
		Mem::Computed(m) => match unparen(&m.expression) {
			Expression::StringLiteral(s) => s.value.as_str().is_some_and(index_text),
			Expression::NumericLiteral(n) => index_number(n.value),
			_ => false,
		},
		_ => false,
	}
}

/// Whether an expression's value is never an object the page was handed
/// (a primitive, or an object the expression itself makes), from its
/// shape alone (`madeHere`)
pub fn made_here(e: &Expression) -> bool {
	match unparen(e) {
		e if is_literal(e) => true,
		Expression::TemplateLiteral(_)
		| Expression::BinaryExpression(_)
		| Expression::PrivateInExpression(_)
		| Expression::UnaryExpression(_)
		| Expression::UpdateExpression(_)
		| Expression::ArrayExpression(_)
		| Expression::ObjectExpression(_)
		| Expression::FunctionExpression(_)
		| Expression::ArrowFunctionExpression(_)
		| Expression::ClassExpression(_) => true,
		Expression::ConditionalExpression(c) => made_here(&c.consequent) && made_here(&c.alternate),
		Expression::SequenceExpression(s) => s.expressions.last().is_some_and(made_here),
		_ => false,
	}
}

/// `select[0] = option`, `select.options[0] = option` (`indexWrite`): a
/// plain write of a literal index whose value may be a node goes through
/// the access API, as the indexed setter it reaches is no function a hook
/// could wrap
pub fn index_write(m: Mem, a: &AssignmentExpression) -> bool {
	a.operator == AssignmentOperator::Assign
		&& !m.on_super()
		&& literal_index(m)
		&& !made_here(&a.right)
}

/// Whether evaluating an expression can do nothing observable
pub fn pure(e: &Expression) -> bool {
	match unparen(e) {
		Expression::Identifier(_)
		| Expression::ThisExpression(_)
		| Expression::ArrowFunctionExpression(_)
		| Expression::FunctionExpression(_) => true,
		e if is_literal(e) => true,
		Expression::TemplateLiteral(t) => t.expressions.is_empty(),
		Expression::ArrayExpression(a) => a.elements.iter().all(|element| match element {
			ArrayExpressionElement::Elision(_) => true,
			ArrayExpressionElement::SpreadElement(_) => false,
			element => pure(element.to_expression()),
		}),
		Expression::ObjectExpression(o) => o.properties.iter().all(|property| match property {
			ObjectPropertyKind::SpreadProperty(_) => false,
			ObjectPropertyKind::ObjectProperty(p) => {
				(!p.computed || p.key.as_expression().is_some_and(pure)) && pure(&p.value)
			}
		}),
		_ => false,
	}
}

pub fn pure_arguments(args: &[Argument]) -> bool {
	args.iter().all(|argument| match argument {
		Argument::SpreadElement(_) => false,
		argument => pure(argument.to_expression()),
	})
}

/// whether an earlier link of the chain a node ends is optional
pub fn in_optional_chain(mut e: &Expression) -> bool {
	loop {
		match e {
			Expression::CallExpression(c) => {
				if c.optional {
					return true;
				}
				e = &c.callee;
			}
			_ => match Mem::of(e) {
				Some(m) => {
					if m.optional() {
						return true;
					}
					e = m.object();
				}
				None => return false,
			},
		}
	}
}

/// How a call posts a message (`postMessageCall`)
pub enum Post<'b, 'a> {
	/// `x.postMessage(...)`
	Direct(Mem<'b, 'a>),
	/// `x.postMessage.call(w, ...)`
	Call,
	/// `x.postMessage.apply(w, args)`
	Apply,
	/// `Reflect.apply(x.postMessage, w, args)`
	Reflect,
}

fn is_post_message(e: &Expression) -> bool {
	Mem::of(e).is_some_and(|m| !m.on_super() && m.literal_key() == Some("postMessage"))
}

pub fn post_message<'b, 'a>(call: &'b CallExpression<'a>) -> Option<Post<'b, 'a>> {
	let callee = Mem::of(unparen(&call.callee))?;
	if is_post_message(unparen(&call.callee)) {
		return Some(Post::Direct(callee));
	}
	let Mem::Static(named) = callee else {
		return None;
	};
	let spread = call.arguments.iter().any(|a| matches!(a, Argument::SpreadElement(_)));
	let name = named.property.name.as_str();
	// (`.apply(w, args, more)`: what follows the arguments is evaluated and
	// ignored, so the call is left as written)
	if (name == "call" || (name == "apply" && call.arguments.len() <= 2))
		&& is_post_message(unparen(&named.object))
		&& !spread
	{
		return Some(if name == "call" { Post::Call } else { Post::Apply });
	}
	if name == "apply"
		&& matches!(unparen(&named.object), Expression::Identifier(id) if id.name == "Reflect")
		&& call.arguments.len() >= 2
		&& call.arguments.len() <= 3
		&& !spread
		&& is_post_message(unparen(call.arguments[0].to_expression()))
	{
		return Some(Post::Reflect);
	}
	None
}

/// A key of a pattern the access API resolves, and what is under it
pub enum Spec {
	True,
	Nested(Vec<(String, Spec)>),
	/// under `"[]"` (an array pattern's elements, by index) or `"{}"` (an
	/// object pattern's properties by their order, when a computed key's
	/// value is destructured further)
	List(Vec<Item>),
}

/// An element of a `Spec::List`
pub enum Item {
	/// nothing to wrap
	Zero,
	/// a pattern under it
	Spec(Vec<(String, Spec)>),
	/// an array pattern's rest that is a pattern (`...[{ top }]`), printed as
	/// a plain last element: the values left, as an array, wrapped by this
	Rest(Vec<(String, Spec)>),
}

/// whether a spec is an array pattern's: its source is iterated
pub fn iterates(entries: &[(String, Spec)]) -> bool {
	matches!(entries, [(key, Spec::List(_))] if key == "[]")
}

/// the entry of `name`, replaced where it stands or added
fn set_spec(entries: &mut Vec<(String, Spec)>, name: String, spec: Spec) {
	match entries.iter_mut().find(|(key, _)| *key == name) {
		Some(entry) => entry.1 = spec,
		None => entries.push((name, spec)),
	}
}

/// the entries in the order a JavaScript object lists its keys: array
/// indices ascending, then the rest as they came
fn key_order(entries: Vec<(String, Spec)>) -> Vec<(String, Spec)> {
	let index = |key: &str| {
		(index_text(key) && key.len() <= 10)
			.then(|| key.parse::<u64>().ok())
			.flatten()
			.filter(|n| *n < 4_294_967_295)
	};
	let (mut indices, names): (Vec<_>, Vec<_>) =
		entries.into_iter().partition(|(key, _)| index(key).is_some());
	indices.sort_by_key(|(key, _)| index(key));
	indices.extend(names);
	indices
}

pub fn spec_text(entries: &[(String, Spec)], quote: &dyn Fn(&str) -> String) -> String {
	let mut out = String::from("{");
	for (i, (key, spec)) in entries.iter().enumerate() {
		if i > 0 {
			out.push(',');
		}
		out.push_str(&quote(key));
		out.push(':');
		match spec {
			Spec::True => out.push_str("true"),
			Spec::Nested(nested) => out.push_str(&spec_text(nested, quote)),
			Spec::List(items) => {
				out.push('[');
				for (i, item) in items.iter().enumerate() {
					if i > 0 {
						out.push(',');
					}
					match item {
						Item::Zero => out.push('0'),
						Item::Spec(nested) => out.push_str(&spec_text(nested, quote)),
						Item::Rest(nested) => {
							out.push('[');
							out.push_str(&spec_text(nested, quote));
							out.push(']');
						}
					}
				}
				out.push(']');
			}
		}
	}
	out.push('}');
	out
}

/// a shape the rewriter leaves to the JavaScript one
pub struct Unsupported;

pub struct Shapes<'c> {
	pub config: &'c Config,
}

impl Shapes<'_> {
	fn routed(&self, name: &str) -> bool {
		self.config.routes(name)
	}

	/// Whether a member read goes through the access API: a computed key
	/// that is no literal, an unforgeable's name, an index (read anywhere
	/// but as a callee: `callee`)
	pub fn routes_member(&self, m: Mem, callee: bool) -> bool {
		if m.on_super() {
			return false;
		}
		match m {
			Mem::Static(m) => self.routed(m.property.name.as_str()),
			Mem::Private(_) => false,
			Mem::Computed(m) => match unparen(&m.expression) {
				Expression::StringLiteral(s) => s
					.value
					.as_str()
					.is_some_and(|key| self.routed(key) || (!callee && index_text(key))),
				Expression::NumericLiteral(n) => !callee && index_number(n.value),
				key => !is_literal(key),
			},
		}
	}

	/// Whether V8, naming the node in an error's message, would print a
	/// call of the access API (`printsHelper`)
	pub fn prints_helper(&self, e: &Expression) -> bool {
		let e = unparen(e);
		if let Some(m) = Mem::of(e) {
			return self.routes_member(m, false) || (!m.on_super() && self.prints_helper(m.object()));
		}
		match e {
			Expression::Identifier(id) => self.routed(id.name.as_str()),
			Expression::CallExpression(c) => {
				let callee = unparen(&c.callee);
				post_message(c).is_some()
					|| Mem::of(callee).is_some_and(|m| self.routes_member(m, true))
					|| (!matches!(callee, Expression::Identifier(id) if id.name == "eval")
						&& self.prints_helper(callee))
			}
			Expression::ChainExpression(c) => match &c.expression {
				ChainElement::CallExpression(call) => {
					let callee = unparen(&call.callee);
					post_message(call).is_some()
						|| Mem::of(callee).is_some_and(|m| self.routes_member(m, true))
						|| (!matches!(callee, Expression::Identifier(id) if id.name == "eval")
							&& self.prints_helper(callee))
				}
				ChainElement::TSNonNullExpression(_) => false,
				element => {
					let m = Mem::of_member(element.to_member_expression());
					self.routes_member(m, false)
						|| (!m.on_super() && self.prints_helper(m.object()))
				}
			},
			Expression::TaggedTemplateExpression(t) => self.prints_helper(&t.tag),
			Expression::BinaryExpression(b) => {
				(b.operator == BinaryOperator::In && !is_literal(unparen(&b.left)))
					|| self.prints_helper(&b.left)
					|| self.prints_helper(&b.right)
			}
			Expression::PrivateInExpression(b) => self.prints_helper(&b.right),
			Expression::LogicalExpression(l) => {
				self.prints_helper(&l.left) || self.prints_helper(&l.right)
			}
			Expression::UnaryExpression(u) => {
				!(matches!(u.operator, UnaryOperator::Typeof | UnaryOperator::Delete)
					&& matches!(unparen(&u.argument), Expression::Identifier(_)))
					&& self.prints_helper(&u.argument)
			}
			Expression::UpdateExpression(u) => self.target_prints(&u.argument),
			Expression::AssignmentExpression(a) => match &a.left {
				AssignmentTarget::ArrayAssignmentTarget(_)
				| AssignmentTarget::ObjectAssignmentTarget(_) => false,
				target => self.target_prints(target.to_simple_assignment_target()),
			},
			Expression::SequenceExpression(s) => s.expressions.iter().any(|e| self.prints_helper(e)),
			Expression::ArrayExpression(a) => a.elements.iter().any(|element| match element {
				ArrayExpressionElement::Elision(_) => false,
				ArrayExpressionElement::SpreadElement(s) => self.prints_helper(&s.argument),
				element => self.prints_helper(element.to_expression()),
			}),
			Expression::TemplateLiteral(t) => t.expressions.iter().any(|e| self.prints_helper(e)),
			_ => false,
		}
	}

	fn target_prints(&self, target: &SimpleAssignmentTarget) -> bool {
		match target {
			SimpleAssignmentTarget::AssignmentTargetIdentifier(id) => self.routed(id.name.as_str()),
			SimpleAssignmentTarget::TSAsExpression(_)
			| SimpleAssignmentTarget::TSSatisfiesExpression(_)
			| SimpleAssignmentTarget::TSNonNullExpression(_)
			| SimpleAssignmentTarget::TSTypeAssertion(_) => false,
			target => {
				let m = Mem::of_member(target.to_member_expression());
				self.routes_member(m, false) || (!m.on_super() && self.prints_helper(m.object()))
			}
		}
	}

	/// the name a pattern's key reads, '' for one that names nothing routed
	fn key_name(&self, key: &PropertyKey) -> Result<String, Unsupported> {
		Ok(match key {
			PropertyKey::StaticIdentifier(id) => id.name.as_str().to_owned(),
			PropertyKey::StringLiteral(s) => s.value.as_str().ok_or(Unsupported)?.to_owned(),
			PropertyKey::NumericLiteral(n) => {
				// the key as JavaScript spells the number
				if n.value.fract() == 0.0 && n.value.abs() < 9_007_199_254_740_992.0 {
					format!("{}", n.value as i64)
				} else {
					n.value.to_js_string()
				}
			}
			PropertyKey::BigIntLiteral(_) => return Err(Unsupported),
			_ => String::new(),
		})
	}

	/// What a pattern reads without a member expression to rewrite, at any
	/// depth (`patternSpec`), for a binding pattern: an object pattern that
	/// names an unforgeable or has a computed key, an array pattern with
	/// such a pattern among its elements. `rests` gets the `...` of each
	/// array rest that is such a pattern, which is printed as a plain last
	/// element (the spec says so)
	pub fn binding_spec(
		&self,
		pattern: &BindingPattern,
		rests: &mut Vec<Span>,
	) -> Result<Option<Vec<(String, Spec)>>, Unsupported> {
		let pattern = match pattern {
			BindingPattern::AssignmentPattern(ap) => &ap.left,
			pattern => pattern,
		};
		match pattern {
			BindingPattern::ArrayPattern(a) => {
				let mut items = Vec::new();
				for element in &a.elements {
					items.push(match element {
						Some(element) => self.binding_spec(element, rests)?.map_or(Item::Zero, Item::Spec),
						None => Item::Zero,
					});
				}
				if let Some(rest) = &a.rest {
					if let Some(spec) = self.binding_spec(&rest.argument, rests)? {
						rests.push(Span::new(rest.span.start, rest.argument.span().start));
						items.push(Item::Rest(spec));
					}
				}
				Ok(list("[]", items))
			}
			BindingPattern::ObjectPattern(o) => {
				let mut fields = Fields::default();
				for property in &o.properties {
					let nested = self.binding_spec(&property.value, rests)?;
					let name = if property.computed { None } else { Some(self.key_name(&property.key)?) };
					fields.add(self, name, nested);
				}
				Ok(fields.spec())
			}
			_ => Ok(None),
		}
	}

	/// the same for the pattern an assignment or a loop head writes
	pub fn target_spec(
		&self,
		target: &AssignmentTarget,
		rests: &mut Vec<Span>,
	) -> Result<Option<Vec<(String, Spec)>>, Unsupported> {
		match target {
			AssignmentTarget::ArrayAssignmentTarget(a) => {
				let mut items = Vec::new();
				for element in &a.elements {
					items.push(match element {
						Some(element) => self.maybe_default_spec(element, rests)?.map_or(Item::Zero, Item::Spec),
						None => Item::Zero,
					});
				}
				if let Some(rest) = &a.rest {
					if let Some(spec) = self.target_spec(&rest.target, rests)? {
						rests.push(Span::new(rest.span.start, rest.target.span().start));
						items.push(Item::Rest(spec));
					}
				}
				Ok(list("[]", items))
			}
			AssignmentTarget::ObjectAssignmentTarget(o) => {
				let mut fields = Fields::default();
				for property in &o.properties {
					match property {
						AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(p) => {
							fields.add(self, Some(p.binding.name.as_str().to_owned()), None);
						}
						AssignmentTargetProperty::AssignmentTargetPropertyProperty(p) => {
							let nested = self.maybe_default_spec(&p.binding, rests)?;
							let name = if p.computed { None } else { Some(self.key_name(&p.name)?) };
							fields.add(self, name, nested);
						}
					}
				}
				Ok(fields.spec())
			}
			_ => Ok(None),
		}
	}

	fn maybe_default_spec(
		&self,
		target: &AssignmentTargetMaybeDefault,
		rests: &mut Vec<Span>,
	) -> Result<Option<Vec<(String, Spec)>>, Unsupported> {
		match target {
			AssignmentTargetMaybeDefault::AssignmentTargetWithDefault(d) => self.target_spec(&d.binding, rests),
			target => match target.as_assignment_target() {
				Some(target) => self.target_spec(target, rests),
				None => Ok(None),
			},
		}
	}
}

/// `{ "[]": [...] }` up to its last entry that wraps something, or none
fn list(key: &str, mut items: Vec<Item>) -> Option<Vec<(String, Spec)>> {
	while matches!(items.last(), Some(Item::Zero)) {
		items.pop();
	}
	(!items.is_empty()).then(|| vec![(key.to_owned(), Spec::List(items))])
}

/// An object pattern's properties as `patternSpec` takes them
#[derive(Default)]
struct Fields {
	entries: Vec<(String, Spec)>,
	/// what is under each property, by position
	positions: Vec<Item>,
	any: bool,
	/// a computed key's value is destructured further: told apart by order
	positional: bool,
}

impl Fields {
	/// a property: its name, none when computed (it may name anything: the
	/// source is wrapped), and the spec of the pattern it destructures to
	fn add(&mut self, shapes: &Shapes, name: Option<String>, nested: Option<Vec<(String, Spec)>>) {
		let Some(name) = name else {
			self.any = true;
			self.positional |= nested.is_some();
			self.positions.push(nested.map_or(Item::Zero, Item::Spec));
			return;
		};
		match nested {
			Some(nested) => {
				self.positions.push(Item::Spec(clone_entries(&nested)));
				set_spec(&mut self.entries, name, Spec::Nested(nested));
				self.any = true;
			}
			None => {
				self.positions.push(Item::Zero);
				if shapes.routed(&name) {
					set_spec(&mut self.entries, name, Spec::True);
					self.any = true;
				}
			}
		}
	}

	fn spec(self) -> Option<Vec<(String, Spec)>> {
		if self.positional {
			return Some(vec![("{}".to_owned(), Spec::List(self.positions))]);
		}
		self.any.then(|| key_order(self.entries))
	}
}

fn clone_entries(entries: &[(String, Spec)]) -> Vec<(String, Spec)> {
	entries.iter().map(|(key, spec)| (key.clone(), clone_spec(spec))).collect()
}

fn clone_spec(spec: &Spec) -> Spec {
	match spec {
		Spec::True => Spec::True,
		Spec::Nested(nested) => Spec::Nested(clone_entries(nested)),
		Spec::List(items) => Spec::List(
			items
				.iter()
				.map(|item| match item {
					Item::Zero => Item::Zero,
					Item::Spec(nested) => Item::Spec(clone_entries(nested)),
					Item::Rest(nested) => Item::Rest(clone_entries(nested)),
				})
				.collect(),
		),
	}
}

/// the names a binding pattern introduces
pub fn bound_names<'b>(pattern: &'b BindingPattern, names: &mut Vec<&'b str>) {
	match pattern {
		BindingPattern::BindingIdentifier(id) => names.push(id.name.as_str()),
		BindingPattern::ObjectPattern(o) => {
			for property in &o.properties {
				bound_names(&property.value, names);
			}
			if let Some(rest) = &o.rest {
				bound_names(&rest.argument, names);
			}
		}
		BindingPattern::ArrayPattern(a) => {
			for element in a.elements.iter().flatten() {
				bound_names(element, names);
			}
			if let Some(rest) = &a.rest {
				bound_names(&rest.argument, names);
			}
		}
		BindingPattern::AssignmentPattern(ap) => bound_names(&ap.left, names),
	}
}

/// the bindings named `name` a pattern introduces, each with whether it is
/// a shorthand property's (`{ location }`, written out when renamed)
pub fn bindings_named(pattern: &BindingPattern, name: &str, shorthand: bool, out: &mut Vec<(Span, bool)>) {
	match pattern {
		BindingPattern::BindingIdentifier(id) => {
			if id.name == name {
				out.push((id.span, shorthand));
			}
		}
		BindingPattern::ObjectPattern(o) => {
			for property in &o.properties {
				bindings_named(&property.value, name, property.shorthand, out);
			}
			if let Some(rest) = &o.rest {
				bindings_named(&rest.argument, name, false, out);
			}
		}
		BindingPattern::ArrayPattern(a) => {
			for element in a.elements.iter().flatten() {
				bindings_named(element, name, false, out);
			}
			if let Some(rest) = &a.rest {
				bindings_named(&rest.argument, name, false, out);
			}
		}
		BindingPattern::AssignmentPattern(ap) => bindings_named(&ap.left, name, shorthand, out),
	}
}

/// `$s$j.pattern(...)`: a source the rewriter (or a page that names the
/// helper) already wrapped
pub fn is_pattern_call(e: &Expression, access: &str) -> bool {
	let Expression::CallExpression(call) = unparen(e) else {
		return false;
	};
	let Expression::StaticMemberExpression(callee) = unparen(&call.callee) else {
		return false;
	};
	callee.property.name == "pattern"
		&& matches!(unparen(&callee.object), Expression::Identifier(id) if id.name == access)
}

/// the span of an expression without its parentheses, as meriyah ranges it
pub fn inner_span(e: &Expression) -> Span {
	unparen(e).span()
}
