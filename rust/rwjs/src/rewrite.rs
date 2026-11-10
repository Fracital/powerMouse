//! The parse and the walk. For now the walk makes no edit: the output is
//! the input whenever oxc accepts it, which is the parse parity stage of
//! docs/rust-plan.md (oxc and meriyah must agree on what parses before any
//! rewrite can be trusted to the wasm backend; rust/host/parity.mjs
//! measures it).
use edits::Edit;
use oxc::allocator::Allocator;
use oxc::parser::{ParseOptions, Parser};
use oxc::span::SourceType;

/// the edits of `source`, or Err when it does not parse (the caller falls
/// back to the JavaScript rewriter, which decides what to do with it)
pub fn rewrite(source: &str, module: bool) -> Result<Vec<Edit>, ()> {
	let allocator = Allocator::default();
	let source_type = SourceType::unambiguous()
		.with_javascript(true)
		.with_module(module)
		.with_script(!module)
		.with_standard(true);
	let parsed = Parser::new(&allocator, source, source_type)
		.with_options(ParseOptions {
			// a classic script may `return` at its top level in a browser
			// (meriyah's globalReturn), and V8 intrinsics parse
			allow_return_outside_function: true,
			allow_v8_intrinsics: true,
			preserve_parens: true,
			..ParseOptions::default()
		})
		.parse();
	if parsed.fatal_error || parsed.diagnostics.has_errors() {
		return Err(());
	}
	Ok(Vec::new())
}

#[cfg(test)]
mod tests {
	use super::rewrite;

	#[test]
	fn scripts_and_modules_parse() {
		assert!(rewrite("const x = location.href;", false).is_ok());
		assert!(rewrite("return 1;", false).is_ok());
		assert!(rewrite("import a from './a.js'; export const b = a;", true).is_ok());
		assert!(rewrite("%DebugPrint(1)", false).is_ok());
	}

	#[test]
	fn what_does_not_parse_is_declined() {
		assert!(rewrite("const = ;", false).is_err());
		assert!(rewrite("import a from './a.js';", false).is_err());
		assert!(rewrite("\u{fc}ber stra\u{df}e", false).is_err());
	}
}
