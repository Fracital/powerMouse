//! Which functions' `arguments` is their own arguments object for certain:
//! a read of it by a computed key (`arguments[i]`, the loop a downlevelled
//! rest parameter is) goes to the access API's `arg`, which reads it with
//! no question about the object (an arguments object is no window, no
//! stand-in, nothing a fresh browsing context replaced), only the look at
//! the value every read has (src/inject/modules/Access.ts).
//!
//! The name is the function's own unless something in reach can rebind
//! it: a declaration of the name (a parameter, `var`, `let`, a function or
//! a class, a catch clause's), a write of it (sloppy code may assign
//! `arguments`), a `with` (its object's property of the name would be
//! found first) or a direct `eval` (whose code may declare the name). One
//! anywhere inside a function, nested functions included, leaves that
//! function and every function around it out: more than needed. So a
//! function's answer is in its own text, nested functions included, and is
//! asked of that part of the tree alone, the first time a read needs it.
use std::collections::{HashMap, HashSet};

use oxc::ast::ast::*;
use oxc::ast_visit::{Visit, walk};
use oxc::span::{GetSpan, Span};
use oxc::syntax::scope::ScopeFlags;

use crate::shape::unparen;

/// The starts of the functions (not arrows: an arrow's `arguments` is the
/// function's around it) whose `arguments` something in reach may rebind
pub fn rebound(program: &Program) -> HashSet<u32> {
	let mut finder = Finder {
		open: Vec::new(),
		rebound: HashSet::new(),
		only: None,
	};
	finder.visit_program(program);
	finder.rebound
}

/// Whether something in reach may rebind the `arguments` of the function
/// that starts at `start` (one of `program`'s, not an arrow), as
/// [`rebound`] answers for it: asked of that function's part of the tree.
/// `known` keeps the answers found on the way (the function's and those of
/// the functions inside it), and is asked first.
pub fn rebound_at(program: &Program, start: u32, known: &mut HashMap<u32, bool>) -> bool {
	if let Some(answer) = known.get(&start) {
		return *answer;
	}
	let mut finder = Finder {
		open: Vec::new(),
		rebound: HashSet::new(),
		only: Some(Only {
			start,
			inside: false,
			done: false,
			seen: Vec::new(),
		}),
	};
	finder.visit_program(program);
	let only = finder.only.take().unwrap_or_else(|| unreachable!());
	if !only.done {
		// (no such function: the whole tree's answer, as it was asked)
		let answer = rebound(program).contains(&start);
		known.insert(start, answer);
		return answer;
	}
	for function in only.seen {
		known.insert(function, finder.rebound.contains(&function));
	}
	known.get(&start).copied().unwrap_or(true)
}

struct Finder {
	/// the functions around the node visited, innermost last
	open: Vec<u32>,
	rebound: HashSet<u32>,
	/// when asked of one function, that function
	only: Option<Only>,
}

/// The function a [`Finder`] is asked of: it walks down to it through the
/// statements and expressions whose text holds its start, then all of it
struct Only {
	start: u32,
	/// the walk is in it
	inside: bool,
	/// the walk was through it
	done: bool,
	/// every function walked in it, itself first
	seen: Vec<u32>,
}

impl Finder {
	fn taint(&mut self) {
		for start in &self.open {
			self.rebound.insert(*start);
		}
	}

	/// whether to walk a node with this span: not, when asked of one
	/// function, out of it
	fn walks(&self, span: Span) -> bool {
		match &self.only {
			None => true,
			Some(only) => !only.done && (only.inside || (span.start <= only.start && only.start < span.end)),
		}
	}
}

impl<'a> Visit<'a> for Finder {
	fn visit_statement(&mut self, it: &Statement<'a>) {
		if self.walks(it.span()) {
			walk::walk_statement(self, it);
		}
	}

	fn visit_expression(&mut self, it: &Expression<'a>) {
		if self.walks(it.span()) {
			walk::walk_expression(self, it);
		}
	}

	fn visit_function(&mut self, it: &Function<'a>, flags: ScopeFlags) {
		if !self.walks(it.span) {
			return;
		}
		let mut asked = false;
		if let Some(only) = &mut self.only {
			if !only.inside && only.start == it.span.start {
				only.inside = true;
				asked = true;
			}
			if only.inside {
				only.seen.push(it.span.start);
			}
		}
		self.open.push(it.span.start);
		walk::walk_function(self, it, flags);
		self.open.pop();
		if let (true, Some(only)) = (asked, &mut self.only) {
			only.inside = false;
			only.done = true;
		}
	}

	fn visit_binding_identifier(&mut self, it: &BindingIdentifier<'a>) {
		if it.name == "arguments" {
			self.taint();
		}
	}

	fn visit_simple_assignment_target(&mut self, it: &SimpleAssignmentTarget<'a>) {
		if let SimpleAssignmentTarget::AssignmentTargetIdentifier(id) = it {
			if id.name == "arguments" {
				self.taint();
			}
		}
		walk::walk_simple_assignment_target(self, it);
	}

	fn visit_assignment_target_property_identifier(&mut self, it: &AssignmentTargetPropertyIdentifier<'a>) {
		if it.binding.name == "arguments" {
			self.taint();
		}
		walk::walk_assignment_target_property_identifier(self, it);
	}

	fn visit_with_statement(&mut self, it: &WithStatement<'a>) {
		self.taint();
		walk::walk_with_statement(self, it);
	}

	fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
		if let Expression::Identifier(id) = unparen(&it.callee) {
			if id.name == "eval" {
				self.taint();
			}
		}
		walk::walk_call_expression(self, it);
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use oxc::allocator::Allocator;
	use oxc::parser::Parser;
	use oxc::span::SourceType;

	/// the names of the functions whose `arguments` may be rebound
	fn rebound_names(source: &str) -> Vec<String> {
		let allocator = Allocator::default();
		let program = Parser::new(&allocator, source, SourceType::cjs()).parse().program;
		let starts = rebound(&program);
		let mut names: Vec<String> = starts
			.iter()
			.map(|start| {
				let rest = &source[*start as usize..];
				rest.split(|c: char| c == '(').next().unwrap_or("").trim().to_string()
			})
			.collect();
		names.sort();
		names
	}

	/// every function of `source` asked alone, in the order given and
	/// the reverse, answers what the whole tree's walk does
	fn alone_as_whole(source: &str) {
		let allocator = Allocator::default();
		let program = Parser::new(&allocator, source, SourceType::cjs()).parse().program;
		let whole = rebound(&program);
		let mut starts = Vec::new();
		let mut at = 0;
		while let Some(found) = source[at..].find("function") {
			starts.push((at + found) as u32);
			at += found + 1;
		}
		for order in [starts.clone(), starts.iter().rev().copied().collect()] {
			let mut known = HashMap::new();
			for start in order {
				assert_eq!(rebound_at(&program, start, &mut known), whole.contains(&start), "{source:?} at {start}");
			}
		}
	}

	#[test]
	fn a_function_alone_answers_as_the_whole_tree() {
		for source in [
			"function f() { return arguments[0]; }",
			"function f() { function g() { var arguments; } return function h() { return arguments[1]; }; }",
			"function a() { with (o) { function b() { return arguments[0]; } } } function c() { eval(x); }",
			"class A { m() { return function () { arguments = 1; }; } static { (function () {})(); } }",
			"x = { m() { return arguments[0]; }, n: function () { [arguments] = y; } }; export default function () { arguments++; }",
			"function f(a = function () { var arguments; }) { return () => arguments[0]; }",
			"function f() { try {} catch (arguments) {} } function g() { ({ arguments } = {}); }",
		] {
			alone_as_whole(source);
		}
	}

	#[test]
	fn own() {
		assert!(rebound_names("function f() { return arguments[0]; }").is_empty());
		assert!(rebound_names("function f() { return () => arguments[0]; }").is_empty());
		assert!(rebound_names("function f() { g(...arguments); f.apply(this, arguments); }").is_empty());
	}

	#[test]
	fn declared() {
		assert_eq!(rebound_names("function f(arguments) {}"), ["function f"]);
		assert_eq!(rebound_names("function f() { var arguments; }"), ["function f"]);
		assert_eq!(rebound_names("function f() { { let arguments = 1; } }"), ["function f"]);
		assert_eq!(rebound_names("function f() { try {} catch (arguments) {} }"), ["function f"]);
		assert_eq!(rebound_names("function f() { function arguments() {} }"), ["function arguments", "function f"]);
		assert_eq!(rebound_names("function f() { function g() { var arguments; } }"), ["function f", "function g"]);
	}

	#[test]
	fn written() {
		assert_eq!(rebound_names("function f() { arguments = 1; }"), ["function f"]);
		assert_eq!(rebound_names("function f() { arguments++; }"), ["function f"]);
		assert_eq!(rebound_names("function f() { [arguments] = [1]; }"), ["function f"]);
		assert_eq!(rebound_names("function f() { ({ arguments } = {}); }"), ["function f"]);
		assert_eq!(rebound_names("function f() { for (arguments of []); }"), ["function f"]);
		assert!(rebound_names("function f() { arguments[0] = 1; arguments.x = 2; }").is_empty());
	}

	#[test]
	fn scoped() {
		assert_eq!(rebound_names("function f() { with (o) arguments[0]; }"), ["function f"]);
		assert_eq!(rebound_names("function f() { eval(c); return arguments[0]; }"), ["function f"]);
		assert_eq!(rebound_names("function f() { (eval)(c); }"), ["function f"]);
		assert_eq!(rebound_names("function f() { () => eval(c); }"), ["function f"]);
		assert!(rebound_names("function f() { window.eval(c); }").is_empty());
		// (outside every function: nothing to rebind)
		assert!(rebound_names("with (o) { function f() { return arguments[0]; } }").is_empty());
	}
}
