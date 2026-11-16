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
//! function and every function around it out: more than needed, and a
//! question asked once per script.
use std::collections::HashSet;

use oxc::ast::ast::*;
use oxc::ast_visit::{Visit, walk};
use oxc::syntax::scope::ScopeFlags;

use crate::shape::unparen;

/// The starts of the functions (not arrows: an arrow's `arguments` is the
/// function's around it) whose `arguments` something in reach may rebind
pub fn rebound(program: &Program) -> HashSet<u32> {
	let mut finder = Finder {
		open: Vec::new(),
		rebound: HashSet::new(),
	};
	finder.visit_program(program);
	finder.rebound
}

struct Finder {
	/// the functions around the node visited, innermost last
	open: Vec<u32>,
	rebound: HashSet<u32>,
}

impl Finder {
	fn taint(&mut self) {
		for start in &self.open {
			self.rebound.insert(*start);
		}
	}
}

impl<'a> Visit<'a> for Finder {
	fn visit_function(&mut self, it: &Function<'a>, flags: ScopeFlags) {
		self.open.push(it.span.start);
		walk::walk_function(self, it, flags);
		self.open.pop();
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
