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
use oxc::syntax::scope::ScopeFlags;

use crate::shape::unparen;

/// The starts of the functions (not arrows: an arrow's `arguments` is the
/// function's around it) whose `arguments` something in reach may rebind
pub fn rebound(program: &Program) -> HashSet<u32> {
	let none = HashMap::new();
	let mut finder = Finder {
		open: Vec::new(),
		rebound: HashSet::new(),
		seen: Vec::new(),
		known: &none,
	};
	finder.visit_program(program);
	finder.rebound
}

/// Whether something in reach may rebind the `arguments` of `function` (one
/// of a program's, not an arrow), as [`rebound`] answers for it: asked of
/// the function's own part of the tree, reached directly. `known` keeps the
/// answers found on the way (the function's and those of the functions
/// inside it), and is asked first, of the function and of each function
/// inside it: one known to be rebound makes this one so too, and one known
/// not to be holds nothing that rebinds this one's, so neither is walked
/// again.
pub fn rebound_in(function: &Function, known: &mut HashMap<u32, bool>) -> bool {
	if let Some(answer) = known.get(&function.span.start) {
		return *answer;
	}
	let mut finder = Finder {
		open: Vec::new(),
		rebound: HashSet::new(),
		seen: Vec::new(),
		known,
	};
	finder.visit_function(function, ScopeFlags::Function);
	let Finder { rebound, seen, .. } = finder;
	for start in seen {
		known.insert(start, rebound.contains(&start));
	}
	known.get(&function.span.start).copied().unwrap_or(true)
}

struct Finder<'k> {
	/// the functions around the node visited, innermost last
	open: Vec<u32>,
	rebound: HashSet<u32>,
	/// every function walked, the outermost first
	seen: Vec<u32>,
	/// the functions answered before, which are not walked again
	known: &'k HashMap<u32, bool>,
}

impl Finder<'_> {
	fn taint(&mut self) {
		for start in &self.open {
			self.rebound.insert(*start);
		}
	}
}

impl<'a> Visit<'a> for Finder<'_> {
	fn visit_function(&mut self, it: &Function<'a>, flags: ScopeFlags) {
		match self.known.get(&it.span.start) {
			// (something in it rebinds its `arguments`, so the functions
			// around it are rebound too)
			Some(true) => self.taint(),
			Some(false) => {}
			None => {
				self.seen.push(it.span.start);
				self.open.push(it.span.start);
				walk::walk_function(self, it, flags);
				self.open.pop();
			}
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
		/// every function of the tree, methods' too, in the walk's order
		struct Functions<'a, 'b>(&'b mut Vec<&'a Function<'a>>);
		impl<'a> Visit<'a> for Functions<'a, '_> {
			fn visit_function(&mut self, it: &Function<'a>, flags: ScopeFlags) {
				self.0.push(self.alloc(it));
				walk::walk_function(self, it, flags);
			}
		}
		let allocator = Allocator::default();
		let program = Parser::new(&allocator, source, SourceType::cjs()).parse().program;
		let whole = rebound(&program);
		let mut functions = Vec::new();
		Functions(&mut functions).visit_program(&program);
		assert!(!functions.is_empty(), "{source:?}");
		// in the walk's order, the reverse (every inner function before the
		// one around it), and the odd ones before the even ones
		let mut mixed: Vec<_> = functions.iter().copied().skip(1).step_by(2).collect();
		mixed.extend(functions.iter().copied().step_by(2));
		for order in [functions.clone(), functions.iter().rev().copied().collect(), mixed] {
			let mut known = HashMap::new();
			for function in order {
				let start = function.span.start;
				assert_eq!(rebound_in(function, &mut known), whole.contains(&start), "{source:?} at {start}");
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
			"function a() { function b() { eval(c); } return arguments[0]; } function d() { function e() { return arguments[0]; } return arguments[1]; }",
			"x = { 1: function (a) { return function () { return function () { arguments = 2; }; }; }, 2: function () { return arguments[0]; } };",
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
