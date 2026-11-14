//! V8 names the expression an error is about in the error's message (`o[k] is
//! not a function`, `Cannot destructure property 'a' of 'f(...)' as it is
//! undefined.`) by printing it back from its syntax tree (CallPrinter, in V8's
//! src/ast/prettyprinter.cc). The access API, which the rewriter routed the
//! page's expression to, must name the page's expression the same way, so this
//! prints a page's expression as CallPrinter would, from the source the
//! rewriter handed the helper. It is the port of src/callPrinter.ts, held to it
//! byte for byte (rust/host/printer.mjs over a corpus); the host side is the
//! `print` member of src/inject/rewriter.ts, over the module.
use oxc::allocator::Allocator;
use oxc::ast::ast::*;
use oxc::parser::{ParseOptions, Parser};
use oxc::span::SourceType;
use oxc::syntax::number::ToJsString;

use crate::shape::{Mem, unparen};

const INTERMEDIATE: &str = "(intermediate value)";

/// what CallPrinter prints for `e` where it prints it (Find(node, true))
fn shown(e: &Expression) -> String {
	let text = visit(e);
	if text.is_empty() {
		INTERMEDIATE.to_owned()
	} else {
		text
	}
}

/// '' becomes the placeholder, as `shown` has it
fn or_intermediate(text: String) -> String {
	if text.is_empty() {
		INTERMEDIATE.to_owned()
	} else {
		text
	}
}

/// a number V8's parser folds `-1`, `+1`, `~1`, `!1` and `1 + 2` into
#[derive(Clone, Copy)]
enum Folded {
	Num(f64),
	Bool(bool),
}

/// ToUint32 of a number, as `|`, `<<` and the rest coerce it
fn to_uint32(n: f64) -> u32 {
	if !n.is_finite() {
		return 0;
	}
	n.trunc().rem_euclid(4_294_967_296.0) as u32
}

fn to_int32(n: f64) -> i32 {
	to_uint32(n) as i32
}

fn folded(e: &Expression) -> Option<Folded> {
	match unparen(e) {
		Expression::NumericLiteral(n) => Some(Folded::Num(n.value)),
		Expression::UnaryExpression(u) => {
			let value = folded(&u.argument);
			if u.operator == UnaryOperator::LogicalNot {
				return value.map(|value| {
					Folded::Bool(match value {
						Folded::Num(n) => n == 0.0 || n.is_nan(),
						Folded::Bool(b) => !b,
					})
				});
			}
			let Some(Folded::Num(n)) = value else {
				return None;
			};
			match u.operator {
				UnaryOperator::UnaryNegation => Some(Folded::Num(-n)),
				UnaryOperator::UnaryPlus => Some(Folded::Num(n)),
				UnaryOperator::BitwiseNot => Some(Folded::Num(f64::from(!to_int32(n)))),
				_ => None,
			}
		}
		Expression::BinaryExpression(b) => {
			let (Some(Folded::Num(left)), Some(Folded::Num(right))) =
				(folded(&b.left), folded(&b.right))
			else {
				return None;
			};
			let shift = to_uint32(right) & 31;
			Some(Folded::Num(match b.operator {
				BinaryOperator::Addition => left + right,
				BinaryOperator::Subtraction => left - right,
				BinaryOperator::Multiplication => left * right,
				BinaryOperator::Division => left / right,
				BinaryOperator::Remainder => left % right,
				BinaryOperator::Exponential => left.powf(right),
				BinaryOperator::BitwiseOR => f64::from(to_int32(left) | to_int32(right)),
				BinaryOperator::BitwiseAnd => f64::from(to_int32(left) & to_int32(right)),
				BinaryOperator::BitwiseXOR => f64::from(to_int32(left) ^ to_int32(right)),
				BinaryOperator::ShiftLeft => f64::from(to_int32(left).wrapping_shl(shift)),
				BinaryOperator::ShiftRight => f64::from(to_int32(left).wrapping_shr(shift)),
				BinaryOperator::ShiftRightZeroFill => f64::from(to_uint32(left) >> shift),
				_ => return None,
			}))
		}
		_ => None,
	}
}

fn folded_text(f: Folded) -> String {
	match f {
		Folded::Num(n) => n.to_js_string(),
		Folded::Bool(b) => b.to_string(),
	}
}

/// the name a member's key prints as (a string literal, as V8 has it)
fn named_key<'a>(m: Mem<'_, 'a>) -> Option<&'a str> {
	match m {
		Mem::Static(s) => Some(s.property.name.as_str()),
		Mem::Private(_) => None,
		Mem::Computed(c) => match unparen(&c.expression) {
			Expression::StringLiteral(s) => s.value.as_str(),
			Expression::TemplateLiteral(t) if t.expressions.is_empty() => t
				.quasis
				.first()
				.and_then(|q| q.value.cooked.as_ref())
				.and_then(|c| c.as_str()),
			_ => None,
		},
	}
}

/// the V8 flags of a regular expression, in V8's own order (`dgimsuvy`)
fn regex_flags(flags: RegExpFlags) -> String {
	let mut out = String::new();
	for (flag, letter) in [
		(RegExpFlags::D, 'd'),
		(RegExpFlags::G, 'g'),
		(RegExpFlags::I, 'i'),
		(RegExpFlags::M, 'm'),
		(RegExpFlags::S, 's'),
		(RegExpFlags::U, 'u'),
		(RegExpFlags::V, 'v'),
		(RegExpFlags::Y, 'y'),
	] {
		if flags.contains(flag) {
			out.push(letter);
		}
	}
	out
}

fn literal(e: &Expression) -> String {
	match e {
		Expression::RegExpLiteral(r) => {
			format!("/{}/{}", r.regex.pattern.text.as_str(), regex_flags(r.regex.flags))
		}
		Expression::StringLiteral(s) => format!("\"{}\"", s.value.as_str().unwrap_or_default()),
		Expression::NumericLiteral(n) => n.value.to_js_string(),
		Expression::BooleanLiteral(b) => b.value.to_string(),
		Expression::NullLiteral(_) => "null".to_owned(),
		// a BigInt: CallPrinter prints nothing for one
		_ => String::new(),
	}
}

/// the printed operands of a left-associative chain of one operator V8 parses
/// as one (`a + b + c`, and `(a + b) + c` too). `#a in o` is a BinaryExpression
/// of `in` to V8 (meriyah's tree), so it flattens into an `in` chain with its
/// private name as an operand, which oxc's own PrivateInExpression is not.
fn chain(e: &Expression, operator: &str, out: &mut Vec<String>) {
	match unparen(e) {
		Expression::BinaryExpression(b) if b.operator.as_str() == operator => {
			chain(&b.left, operator, out);
			out.push(shown(&b.right));
		}
		Expression::LogicalExpression(l) if l.operator.as_str() == operator => {
			chain(&l.left, operator, out);
			out.push(shown(&l.right));
		}
		Expression::PrivateInExpression(p) if operator == "in" => {
			out.push(format!("#{}", p.left.name.as_str()));
			out.push(shown(&p.right));
		}
		inner => out.push(shown(inner)),
	}
}

fn member(m: Mem) -> String {
	let object = shown(m.object());
	let dot = if m.optional() { "?." } else { "." };
	match m {
		Mem::Private(p) => format!("{object}{dot}#{}", p.field.name.as_str()),
		_ => match named_key(m) {
			Some(name) => format!("{object}{dot}{name}"),
			None => {
				let key = match m {
					Mem::Computed(c) => shown(&c.expression),
					_ => String::new(),
				};
				let open = if m.optional() { "?." } else { "" };
				format!("{object}{open}[{key}]")
			}
		},
	}
}

/// what CallPrinter prints for an assignment's target (an expression to V8)
fn target(t: &AssignmentTarget) -> String {
	if let AssignmentTarget::AssignmentTargetIdentifier(id) = t {
		return id.name.to_string();
	}
	match t.as_member_expression() {
		Some(m) => member(Mem::of_member(m)),
		None => String::new(),
	}
}

fn simple_target(t: &SimpleAssignmentTarget) -> String {
	if let SimpleAssignmentTarget::AssignmentTargetIdentifier(id) = t {
		return id.name.to_string();
	}
	match t.as_member_expression() {
		Some(m) => member(Mem::of_member(m)),
		None => String::new(),
	}
}

fn visit(e: &Expression) -> String {
	if let Expression::ParenthesizedExpression(p) = e {
		return visit(&p.expression);
	}
	if let Some(m) = Mem::of(e) {
		return member(m);
	}
	match e {
		Expression::Identifier(id) => id.name.to_string(),
		Expression::ThisExpression(_) => "this".to_owned(),
		Expression::Super(_) => String::new(),
		Expression::BooleanLiteral(_)
		| Expression::NullLiteral(_)
		| Expression::NumericLiteral(_)
		| Expression::BigIntLiteral(_)
		| Expression::RegExpLiteral(_)
		| Expression::StringLiteral(_) => literal(e),
		Expression::TemplateLiteral(t) => {
			// a template without substitutions is a string literal to V8
			if t.expressions.is_empty() {
				format!(
					"\"{}\"",
					t.quasis
						.first()
						.and_then(|q| q.value.cooked.as_ref())
						.and_then(|c| c.as_str())
						.unwrap_or_default()
				)
			} else {
				t.expressions.iter().map(shown).collect()
			}
		}
		Expression::ArrayExpression(a) => {
			let parts: Vec<String> = a
				.elements
				.iter()
				.map(|element| match element {
					ArrayExpressionElement::Elision(_) => INTERMEDIATE.to_owned(),
					ArrayExpressionElement::SpreadElement(s) => format!("(...{})", shown(&s.argument)),
					element => shown(element.to_expression()),
				})
				.collect();
			format!("[{}]", parts.join(","))
		}
		// CallPrinter visits an object's properties without printing them
		Expression::ObjectExpression(o) => format!("{{{}}}", INTERMEDIATE.repeat(o.properties.len())),
		Expression::CallExpression(c) => format!("{}(...)", shown(&c.callee)),
		Expression::TaggedTemplateExpression(t) => format!("{}(...)", shown(&t.tag)),
		Expression::ImportExpression(i) => format!("ImportCall({})", shown(&i.source)),
		// three unprinted operands for a conditional, nothing for the rest
		Expression::ConditionalExpression(_) => INTERMEDIATE.repeat(3),
		Expression::NewExpression(_)
		| Expression::ChainExpression(_)
		| Expression::AwaitExpression(_)
		| Expression::YieldExpression(_)
		| Expression::FunctionExpression(_)
		| Expression::ArrowFunctionExpression(_)
		| Expression::ClassExpression(_)
		| Expression::NewTarget(_)
		| Expression::ImportMeta(_) => String::new(),
		Expression::UnaryExpression(u) => {
			if let Some(f) = folded(e) {
				return folded_text(f);
			}
			let space = matches!(
				u.operator,
				UnaryOperator::Typeof | UnaryOperator::Void | UnaryOperator::Delete
			);
			format!(
				"({}{}{})",
				u.operator.as_str(),
				if space { " " } else { "" },
				shown(&u.argument)
			)
		}
		Expression::UpdateExpression(u) => {
			let arg = or_intermediate(simple_target(&u.argument));
			if u.prefix {
				format!("({}{arg})", u.operator.as_str())
			} else {
				format!("({arg}{})", u.operator.as_str())
			}
		}
		Expression::BinaryExpression(b) => {
			if let Some(f) = folded(e) {
				return folded_text(f);
			}
			let op = b.operator.as_str();
			let mut parts = Vec::new();
			chain(e, op, &mut parts);
			format!("({})", parts.join(&format!(" {op} ")))
		}
		Expression::LogicalExpression(l) => {
			let op = l.operator.as_str();
			let mut parts = Vec::new();
			chain(e, op, &mut parts);
			format!("({})", parts.join(&format!(" {op} ")))
		}
		Expression::PrivateInExpression(_) => {
			let mut parts = Vec::new();
			chain(e, "in", &mut parts);
			format!("({})", parts.join(" in "))
		}
		Expression::SequenceExpression(s) => {
			format!("({})", s.expressions.iter().map(shown).collect::<Vec<_>>().join(" , "))
		}
		Expression::AssignmentExpression(a) => or_intermediate(target(&a.left)),
		_ => String::new(),
	}
}

/// the ESTree node type V8's error message would carry, as src/callPrinter.ts
/// reads it (meriyah's tree: one `MemberExpression`, one `Literal`, a
/// `MetaProperty` for `new.target` and `import.meta`)
fn estree_type(e: &Expression) -> &'static str {
	if Mem::of(e).is_some() {
		return "MemberExpression";
	}
	match e {
		Expression::Identifier(_) => "Identifier",
		Expression::ThisExpression(_) => "ThisExpression",
		Expression::Super(_) => "Super",
		Expression::BooleanLiteral(_)
		| Expression::NullLiteral(_)
		| Expression::NumericLiteral(_)
		| Expression::BigIntLiteral(_)
		| Expression::RegExpLiteral(_)
		| Expression::StringLiteral(_) => "Literal",
		Expression::TemplateLiteral(_) => "TemplateLiteral",
		Expression::ArrayExpression(_) => "ArrayExpression",
		Expression::ObjectExpression(_) => "ObjectExpression",
		Expression::CallExpression(_) => "CallExpression",
		Expression::NewExpression(_) => "NewExpression",
		Expression::TaggedTemplateExpression(_) => "TaggedTemplateExpression",
		Expression::ImportExpression(_) => "ImportExpression",
		Expression::ConditionalExpression(_) => "ConditionalExpression",
		Expression::UnaryExpression(_) => "UnaryExpression",
		Expression::UpdateExpression(_) => "UpdateExpression",
		Expression::BinaryExpression(_) | Expression::PrivateInExpression(_) => "BinaryExpression",
		Expression::LogicalExpression(_) => "LogicalExpression",
		Expression::SequenceExpression(_) => "SequenceExpression",
		Expression::AssignmentExpression(_) => "AssignmentExpression",
		Expression::ArrowFunctionExpression(_) => "ArrowFunctionExpression",
		Expression::FunctionExpression(_) => "FunctionExpression",
		Expression::ClassExpression(_) => "ClassExpression",
		Expression::AwaitExpression(_) => "AwaitExpression",
		Expression::YieldExpression(_) => "YieldExpression",
		Expression::ChainExpression(_) => "ChainExpression",
		Expression::NewTarget(_) | Expression::ImportMeta(_) => "MetaProperty",
		_ => "",
	}
}

/// the node a partial is, past the parentheses and a chain (callPrinter's
/// `callOf`): the call, construction or tagged template its parts come from
enum Call<'b, 'a> {
	Call(&'b CallExpression<'a>),
	New(&'b NewExpression<'a>),
	Tagged(&'b TaggedTemplateExpression<'a>),
	Member(Mem<'b, 'a>),
	Other(&'b Expression<'a>),
}

fn call_of<'b, 'a>(node: &'b Expression<'a>) -> Call<'b, 'a> {
	let node = unparen(node);
	if let Expression::ChainExpression(c) = node {
		return match &c.expression {
			ChainElement::CallExpression(call) => Call::Call(call),
			ChainElement::TSNonNullExpression(_) => Call::Other(node),
			member => Call::Member(Mem::of_member(member.to_member_expression())),
		};
	}
	match node {
		Expression::CallExpression(c) => Call::Call(c),
		Expression::NewExpression(n) => Call::New(n),
		Expression::TaggedTemplateExpression(t) => Call::Tagged(t),
		_ => Call::Other(node),
	}
}

/// whether a call's arguments spread other than once at the end
fn spreads(args: &[Argument]) -> bool {
	let count = args.iter().filter(|a| matches!(a, Argument::SpreadElement(_))).count();
	count > 1 || (count == 1 && !matches!(args.last(), Some(Argument::SpreadElement(_))))
}

/// the name V8 gives a destructuring's first property in its message, if any
fn first_key(node: &Expression) -> String {
	let Expression::AssignmentExpression(a) = node else {
		return String::new();
	};
	let AssignmentTarget::ObjectAssignmentTarget(o) = &a.left else {
		return String::new();
	};
	match o.properties.first() {
		Some(AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(p)) => {
			p.binding.name.to_string()
		}
		Some(AssignmentTargetProperty::AssignmentTargetPropertyProperty(p)) => {
			if p.computed {
				return String::new();
			}
			match &p.name {
				PropertyKey::StaticIdentifier(id) => id.name.to_string(),
				PropertyKey::StringLiteral(s) => s.value.as_str().unwrap_or_default().to_owned(),
				PropertyKey::NumericLiteral(n) => n.value.to_js_string(),
				_ => String::new(),
			}
		}
		None => String::new(),
	}
}

/// the expression a parsed partial holds, past the wrappers it was parsed in
fn expression_of<'b, 'a>(program: &'b Program<'a>) -> Option<&'b Expression<'a>> {
	let mut statement = program.body.last()?;
	// `class C { async *m() { (partial) } }` and `async function* f() { ... }`
	loop {
		match statement {
			Statement::ClassDeclaration(class) => {
				let ClassElement::MethodDefinition(method) = class.body.body.last()? else {
					return None;
				};
				statement = method.value.body.as_ref()?.statements.first()?;
			}
			Statement::FunctionDeclaration(function) => {
				statement = function.body.as_ref()?.statements.first()?;
			}
			_ => break,
		}
	}
	match statement {
		Statement::ExpressionStatement(s) => Some(unparen(&s.expression)),
		_ => None,
	}
}

/// the private names a source uses (`#a`), for the class wrapping
fn private_names(source: &str) -> Vec<&str> {
	let bytes = source.as_bytes();
	let mut names: Vec<&str> = Vec::new();
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b'#' {
			let start = i + 1;
			let mut j = start;
			while j < bytes.len() {
				let c = bytes[j];
				if c == b'_' || c == b'$' || c.is_ascii_alphanumeric() || c >= 0x80 {
					j += 1;
				} else {
					break;
				}
			}
			if j > start {
				let name = &source[i..j];
				if !names.contains(&name) {
					names.push(name);
				}
				i = j;
				continue;
			}
		}
		i += 1;
	}
	names
}

/// a partial parsed as an expression (the attempt's wrapping around it removed)
fn parse_in<'a>(
	allocator: &'a Allocator,
	source: &'a str,
	module: bool,
) -> Option<&'a Expression<'a>> {
	let source_type = SourceType::unambiguous()
		.with_javascript(true)
		.with_module(module)
		.with_commonjs(!module)
		.with_standard(true);
	let parsed = Parser::new(allocator, source, source_type)
		.with_options(ParseOptions {
			allow_return_outside_function: true,
			preserve_parens: true,
			..ParseOptions::default()
		})
		.parse();
	if parsed.fatal_error || parsed.diagnostics.has_errors() {
		return None;
	}
	expression_of(allocator.alloc(parsed.program))
}

/// what a parsed partial answers for `part`
fn reprint(node: &Expression, part: &str) -> Option<String> {
	match part {
		"callee" => match call_of(node) {
			Call::Call(c) => Some(shown(&c.callee)),
			Call::New(n) => Some(shown(&n.callee)),
			Call::Tagged(t) => Some(shown(&t.tag)),
			Call::Member(_) | Call::Other(_) => None,
		},
		"spread" => {
			let args: &[Argument] = match call_of(node) {
				Call::Call(c) => &c.arguments,
				Call::New(n) => &n.arguments,
				Call::Tagged(_) | Call::Member(_) | Call::Other(_) => &[],
			};
			Some(if spreads(args) { "1".to_owned() } else { String::new() })
		}
		"type" => Some(
			match call_of(node) {
				Call::Call(_) => "CallExpression",
				Call::New(_) => "NewExpression",
				Call::Tagged(_) => "TaggedTemplateExpression",
				Call::Member(_) => "MemberExpression",
				Call::Other(e) => estree_type(e),
			}
			.to_owned(),
		),
		"key" => Some(first_key(node)),
		"init" => match node {
			Expression::AssignmentExpression(a) => Some(shown(&a.right)),
			_ => None,
		},
		_ => Some(shown(node)),
	}
}

/// What V8 names a part of `source` (a page's expression, as the rewriter
/// handed it to a helper) by in an error about it, or None when the source does
/// not parse or the part does not apply (src/callPrinter.ts printExpression). A
/// None is told from an empty string by the caller (the status it answers).
/// `part`: 'callee', 'spread' ('1' when a call spreads other than once at the
/// end), 'type' (the call's ESTree node type), 'key'/'init' (a destructuring
/// assignment's first property name and its source), else the expression.
pub fn print_expression(source: &str, part: &str) -> Option<String> {
	let wrapped = format!("({source}\n)");
	let privates = private_names(source);
	let class = format!(
		"class C extends Object {{ {}async *m() {{{wrapped}}} }}",
		privates.iter().map(|name| format!("{name};")).collect::<String>()
	);
	let generator = format!("async function* f() {{{wrapped}}}");
	// a script, then where `await` and `yield` are expressions, then in a class
	// method (`super`, the private names it uses), then as a module
	let attempts: [(&str, bool); 4] =
		[(&wrapped, false), (&generator, false), (&class, false), (&wrapped, true)];
	for (text, module) in attempts {
		// each attempt owns its parse; the printing (owned String) finishes
		// before the arena drops
		let allocator = Allocator::default();
		if let Some(expression) = parse_in(&allocator, text, module) {
			return reprint(expression, part);
		}
	}
	None
}
