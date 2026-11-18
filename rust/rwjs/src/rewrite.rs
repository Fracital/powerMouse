//! The parse and the driver: what a rewrite is given, what it answers, and
//! what goes around the walk (the text ahead of the script's own code, the
//! holder of its text, the routed source map). The walk itself is `walk`.
use edits::{Edit, Piece, Span as EditSpan, apply};
use oxc::allocator::Allocator;
use oxc::ast_visit::Visit;
use oxc::ast::ast::{Expression, Statement};
use oxc::parser::{ParseOptions, Parser, ParserReturn};
use oxc::span::SourceType;

use crate::config::Config;
use crate::early::{self, Mode, Verdict};
use crate::source::{Utf16Offsets, holder_statement, source_key};
use crate::walk::{Patterns, Walker};

/// What one rewrite depends on besides the configuration: handed over per
/// script (`FLAG_PARAMS` in the ABI)
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Params {
	/// the script's real URL: what a classic script's `import()` resolves
	/// against
	pub url: String,
	/// the key of the text this script's positions refer to, when it is not
	/// the script's own (a part of a split script)
	pub key: Option<String>,
	/// `[position, shift, ...]` ascending, in UTF-16 units: a position of
	/// this script at or past `position` stands `shift` further on in the
	/// kept text
	pub shifts: Vec<(u32, i64)>,
	/// what runs before the script's own code, after its directive prologue
	/// (the worker bootstrap, `import.meta.url`, the caller's preamble)
	pub pre: String,
}

impl Params {
	/// `url`, `key` and `shifts` (comma separated) on a line each, then the
	/// rest is `pre` as it is
	pub fn parse(text: &str) -> Result<Self, ()> {
		let mut lines = text.splitn(4, '\n');
		let url = lines.next().ok_or(())?.to_owned();
		let key = lines.next().ok_or(())?;
		let shifts_text = lines.next().ok_or(())?;
		let pre = lines.next().unwrap_or("").to_owned();
		let mut numbers = Vec::new();
		if !shifts_text.is_empty() {
			for number in shifts_text.split(',') {
				numbers.push(number.parse::<i64>().map_err(|_| ())?);
			}
		}
		if numbers.len() % 2 != 0 {
			return Err(());
		}
		let shifts = numbers
			.chunks(2)
			.map(|pair| (pair[0].clamp(0, i64::from(u32::MAX)) as u32, pair[1]))
			.collect();
		Ok(Self {
			url,
			key: (!key.is_empty()).then(|| key.to_owned()),
			shifts,
			pre,
		})
	}
}

pub struct Options<'c> {
	/// a module: strict, `import`/`export`, no directive prologue to keep
	pub module: bool,
	/// write the statement that hands the script's text to the access API
	/// when a function of it is marked (the rewriter runs where no page does)
	pub holder: bool,
	pub config: &'c Config,
	pub params: &'c Params,
}

pub struct Output {
	pub text: String,
	/// how many functions carry a mark
	pub marks: u32,
	/// the key the marks name, '' when there is none
	pub key: String,
}

/// The revision of this module, which it answers for `FLAG_REVISION`: raised
/// whenever what it answers changes for any input, or how it is asked does.
/// That is the output for any script, the status it declines one with, the
/// answer to a parse question, and the boundary itself (a flag, a status, the
/// layout of what crosses), so a cache of rewrites keyed on it never serves
/// an older module's text and the glue never drives a module it was not
/// written for (src/wasm/rewriter.ts holds the same number).
/// rust/host/parity.mjs --cases holds it to the outputs (cases.revision).
pub const REVISION: &str = "18";

/// Why the rewriter hands a script back to the JavaScript one
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decline {
	/// the parser could not make a program of it
	Parse,
	/// a shape this rewriter does not rewrite yet
	Shape,
	/// a script no browser runs: an early error, a V8 intrinsic, or syntax no
	/// browser has shipped yet (a decorator, an `accessor` field). The caller
	/// hands it back as it was, as the JavaScript rewriter does with what it
	/// cannot parse or print, and the browser refuses it as it does natively
	Invalid,
	/// the host could not route a URL of it
	Route,
	/// the edits did not nest: a bug in the walk
	Edits,
}

/// the host's routing of a URL the script names: `kind` 1 a static import
/// (the text is the attribute type's length in UTF-16 units, `:`, the type,
/// the specifier), 2 a source map
pub type Route<'h> = dyn FnMut(u32, &str) -> Option<String> + 'h;

pub const ROUTE_IMPORT: u32 = 1;
pub const ROUTE_SOURCE_MAP: u32 = 2;

const LINE_ENDS: [char; 4] = ['\n', '\r', '\u{2028}', '\u{2029}'];

/// where the first line that is no HTML close comment (`--> text`, behind
/// white space and comments that end on the line) starts
fn after_close_comments(source: &str) -> usize {
	let mut at = 0;
	loop {
		let rest = &source[at..];
		let end = rest.find(LINE_ENDS);
		let mut line = &rest[..end.unwrap_or(rest.len())];
		loop {
			line = line.trim_start();
			match line.strip_prefix("/*").and_then(|comment| comment.split_once("*/")) {
				Some((_, behind)) => line = behind,
				None => break,
			}
		}
		if !line.starts_with("-->") {
			return at;
		}
		match end {
			Some(end) => at += end + rest[end..].chars().next().map_or(1, char::len_utf8),
			None => return source.len(),
		}
	}
}

/// The text the parser is handed for `source`, and what it made of it.
///
/// V8 compiles a call as the target of an assignment, an update or a
/// for-in/of head (`f() = 1`, `f() += 1`, `f()++`, `--f()`,
/// `for (f() in o)`), sloppy and strict, and throws a ReferenceError when
/// the target is reached, after the call and before the right side: annex
/// B's web compatibility, which pages have. oxc refuses it. So each such
/// target found is given, in a copy of the text, an operator of the same
/// length that assigns nothing (`f() , 1`, `f()  `, `for (f() ;; o)`), and
/// the copy is parsed again: every position is the source's, the walk reads
/// the source's own text, and the rewrite keeps the page's target as it
/// wrote it, for the browser to throw as it does natively. A target V8
/// refuses too (an optional call, `new f()`, `import(x)`, a tagged template,
/// a logical assignment, a pattern) is left to the parser's refusal.
fn parse_targets<'a>(
	allocator: &'a Allocator,
	source: &'a str,
	source_type: SourceType,
	options: &ParseOptions,
) -> (&'a str, ParserReturn<'a>, bool) {
	let mut text = source;
	let mut changed = false;
	for _ in 0..64 {
		let parsed = Parser::new(allocator, text, source_type).with_options(options.clone()).parse();
		if !parsed.fatal_error {
			return (text, parsed, changed);
		}
		let Some(span) = parsed
			.diagnostics
			.iter()
			.find(|diagnostic| diagnostic.message == "Cannot assign to this expression")
			.and_then(|diagnostic| diagnostic.labels.first())
			.map(|label| label.span())
		else {
			return (text, parsed, changed);
		};
		let Some(copy) = target_freed(allocator, text, span.start as usize, span.end as usize) else {
			return (text, parsed, changed);
		};
		text = allocator.alloc_str(&copy);
		changed = true;
	}
	let parsed = Parser::new(allocator, text, source_type).with_options(options.clone()).parse();
	(text, parsed, changed)
}

/// `text` with the operator that makes the call at `start..end` a target
/// turned into one of the same length that assigns nothing, or None when
/// the call is no target V8 compiles
fn target_freed(allocator: &Allocator, text: &str, start: usize, end: usize) -> Option<String> {
	// a plain call (V8 refuses an optional one, `new`, `import()`, a tag)
	// (asked as a script of the one statement: the parser the rewrite runs
	// already, no other entry of it in the module)
	let call = text.get(start..end)?;
	let alone = Parser::new(allocator, call, SourceType::cjs()).parse();
	if alone.fatal_error || alone.diagnostics.has_errors() || !alone.program.directives.is_empty() {
		return None;
	}
	let [Statement::ExpressionStatement(statement)] = alone.program.body.as_slice() else {
		return None;
	};
	let Expression::CallExpression(found) = &statement.expression else {
		return None;
	};
	if found.optional || matches!(found.callee, Expression::Super(_)) {
		return None;
	}
	let bytes = text.as_bytes();
	// (a parenthesized target: `(f()) = 1`)
	let mut opened = 0;
	let mut before = text[..start].trim_end();
	while let Some(rest) = before.strip_suffix('(') {
		opened += 1;
		before = rest.trim_end();
	}
	let mut after = skip_trivia(bytes, end);
	let mut closed = 0;
	while closed < opened && bytes.get(after) == Some(&b')') {
		closed += 1;
		after = skip_trivia(bytes, after + 1);
	}
	let rest = &text[after..];
	let mut copy = text.as_bytes().to_vec();
	let blank = |copy: &mut Vec<u8>, at: usize, length: usize, with: &[u8]| {
		for index in 0..length {
			copy[at + index] = *with.get(index).unwrap_or(&b' ');
		}
	};
	if rest.starts_with("++") || rest.starts_with("--") {
		blank(&mut copy, after, 2, b"");
	} else if let Some(operator) = ["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^="]
		.iter()
		.filter(|operator| rest.starts_with(**operator))
		.max_by_key(|operator| operator.len())
	{
		// (`==` and `=>` are no assignment, and `&&=`, `||=`, `??=` take no
		// call: V8 refuses them)
		if rest[operator.len()..].starts_with(['=', '>']) {
			return None;
		}
		blank(&mut copy, after, operator.len(), b",");
	} else if (rest.starts_with("in") || rest.starts_with("of"))
		&& !rest[2..].starts_with(|c: char| c.is_alphanumeric() || c == '_' || c == '$')
	{
		// the head of a for-in or for-of loop (not `for await`); a for-of
		// head may not start with `let`
		if rest.starts_with("of")
			&& call.starts_with("let")
			&& !call[3..].starts_with(|c: char| c.is_alphanumeric() || c == '_' || c == '$')
		{
			return None;
		}
		let mut head = text[..start].trim_end();
		for _ in 0..=closed {
			head = head.strip_suffix('(')?.trim_end();
		}
		if !head.ends_with("for") || head[..head.len() - 3].ends_with(|c: char| c.is_alphanumeric() || c == '_' || c == '$') {
			return None;
		}
		blank(&mut copy, after, 2, b";;");
	} else {
		let mut before = text[..start].trim_end();
		for _ in 0..closed {
			before = before.strip_suffix('(')?.trim_end();
		}
		if !(before.ends_with("++") || before.ends_with("--")) {
			return None;
		}
		blank(&mut copy, before.len() - 2, 2, b"");
	}
	String::from_utf8(copy).ok()
}

/// where the next token is from `at`: past white space and comments
fn skip_trivia(bytes: &[u8], mut at: usize) -> usize {
	loop {
		while at < bytes.len() && (bytes[at].is_ascii_whitespace()) {
			at += 1;
		}
		if bytes[at..].starts_with(b"//") {
			while at < bytes.len() && bytes[at] != b'\n' && bytes[at] != b'\r' {
				at += 1;
			}
		} else if bytes[at..].starts_with(b"/*") {
			match bytes[at + 2..].windows(2).position(|pair| pair == b"*/") {
				Some(found) => at += 2 + found + 2,
				None => return bytes.len(),
			}
		} else {
			return at;
		}
	}
}

/// Whether a browser compiles `source` as a classic script (`single`: one of
/// a single expression statement, with no `return` at its top level), for
/// the callers that ask no rewrite (src/rewriteJS.ts singleExpression,
/// src/rewriterLib.ts parsesAsScript): the parse, a regular expression's
/// pattern included, and the early errors. A `return` at the top level
/// passes unless `single`, as it does the JavaScript rewriter's parser
/// (`globalReturn`).
pub fn parses(source: &str, single: bool) -> bool {
	let allocator = Allocator::default();
	let source_type = SourceType::unambiguous()
		.with_javascript(true)
		.with_module(false)
		.with_script(true)
		.with_standard(true);
	let parse_options = ParseOptions {
		allow_return_outside_function: !single,
		parse_regular_expression: true,
		..ParseOptions::default()
	};
	let (text, parsed, _) = parse_targets(&allocator, source, source_type, &parse_options);
	if parsed.fatal_error || parsed.diagnostics.has_errors() {
		return false;
	}
	let program = parsed.program;
	let mode = Mode {
		module: false,
		lenient: false,
		top_return: !single,
	};
	if early::check(&program, text, mode) != Verdict::Compiles {
		return false;
	}
	if !single {
		return true;
	}
	match (program.directives.len(), program.body.as_slice()) {
		(1, []) => true,
		(0, [statement]) => matches!(statement, oxc::ast::ast::Statement::ExpressionStatement(_)),
		_ => false,
	}
}

/// `source` rewritten, or why not (the caller falls back to the JavaScript
/// rewriter, which decides what to do with it)
pub fn rewrite(source: &str, options: &Options, route: &mut Route) -> Result<Output, Decline> {
	let allocator = Allocator::default();
	// a classic script's text is parsed as CommonJS, not a script: a browser
	// compiles a handler attribute's body and a direct eval's code as a
	// classic script's text (`lenient` below), where `new.target` may stand
	// at the top level as it may in a function. The JavaScript rewriter's
	// parser takes it so (meriyah's globalReturn); oxc allows top-level
	// `new.target` only for CommonJS, which otherwise parses as a script does
	// (top-level `return` too, already allowed below; top-level `await` stays
	// an identifier, as in a script). A script element with top-level
	// `new.target` is refused by the browser either way, with or without the
	// rewrite the walk makes of the rest.
	let source_type = SourceType::unambiguous()
		.with_javascript(true)
		.with_module(options.module)
		.with_commonjs(!options.module)
		.with_standard(true);
	let parse_options = ParseOptions {
		// a classic script may `return` at its top level in a browser
		// (meriyah's globalReturn), and V8 intrinsics parse
		allow_return_outside_function: true,
		allow_v8_intrinsics: true,
		preserve_parens: true,
		// (a pattern is asked of the regular expression parser by the
		// walk, src/pattern.rs: one V8 refuses is a parse error here, the
		// JavaScript rewriter decides, and the literal reaches V8 as
		// written)
		..ParseOptions::default()
	};
	// (`text` is what the parser read: `source`, or a copy of it with the
	// same positions, parse_targets)
	let (text, parsed, freed) = parse_targets(&allocator, source, source_type, &parse_options);
	if parsed.fatal_error || parsed.diagnostics.has_errors() {
		return Err(Decline::Parse);
	}
	let program = parsed.program;
	// a classic script's text may be a handler's body or a direct eval's
	// code, where more may stand at the top level than in a script element
	let mode = Mode {
		module: options.module,
		lenient: !options.module,
		top_return: !options.module,
	};
	let offsets = Utf16Offsets::new(source);
	// the rewrite's walk drives the early-error check (src/early.rs): one
	// walk of the tree for both
	let mut walker = Walker::new(source, text, &program, options, &offsets, route, mode, &allocator);
	walker.visit_program(&program);
	// a walk that declined may have left a part unwalked: the check then
	// walks the tree on its own, as it does for the parse questions, and the
	// patterns are read on their own
	let (verdict, bad_pattern) = match walker.declined() {
		Some(_) => {
			let mut patterns = Patterns {
				src: source,
				allocator: &allocator,
				bad: false,
			};
			patterns.visit_program(&program);
			(early::check(&program, text, mode), patterns.bad)
		}
		None => (walker.verdict(), walker.bad_pattern()),
	};
	// (as the parser answers when it parses the patterns itself: the
	// crate's tests hold it to that)
	#[cfg(test)]
	{
		let parsed = Parser::new(&allocator, text, source_type)
			.with_options(ParseOptions {
				allow_return_outside_function: true,
				allow_v8_intrinsics: true,
				preserve_parens: true,
				parse_regular_expression: true,
				..ParseOptions::default()
			})
			.parse();
		let refused = parsed.fatal_error || parsed.diagnostics.has_errors();
		if refused != bad_pattern {
			tests::DIFFER.with(|differ| {
				differ.borrow_mut().push(format!("{source:?}: walk's patterns {bad_pattern}, parser {refused}"))
			});
		}
	}
	if bad_pattern {
		return Err(Decline::Parse);
	}
	// (the two walks answer alike: the crate's tests hold every recorded
	// text to it, in every place it is tried)
	#[cfg(test)]
	if walker.declined().is_none() {
		let alone = early::check(&program, text, mode);
		if verdict != alone {
			tests::DIFFER.with(|differ| differ.borrow_mut().push(format!("{source:?}: walk {verdict:?}, alone {alone:?}")));
		}
	}
	match verdict {
		Verdict::Compiles => {}
		Verdict::Refused => return Err(Decline::Invalid),
		// syntax no browser runs today (a decorator, an `accessor` field,
		// `import.defer()`): the caller hands it back, and the browser refuses
		// it as it does natively. The JavaScript rewriter cannot print it
		// either (escodegen has no such node), so it hands it back the same
		// way. Were it `Decline::Shape` the caller would run the JavaScript
		// rewriter on it, which a wasm-only build does not have; and were the
		// script handed back as it is the day a browser ships the syntax, it
		// would run unrewritten, which the caller's fallback guards against
		// (src/wasm/rewriter.ts, an early-error end the browser refuses).
		Verdict::Unshipped => return Err(Decline::Invalid),
	}

	// the two comments DevTools reads keep their place; a source map's URL
	// resolves against the routed script, so it is routed too
	for comment in &program.comments {
		let content = comment.content_span();
		let text = &source[content.start as usize..content.end as usize];
		let Some((name, value)) = devtools_comment(text) else {
			continue;
		};
		if name != "sourceMappingURL" || is_data_url(value) {
			continue;
		}
		if let Some(routed) = walker.route(ROUTE_SOURCE_MAP, value) {
			let start = content.start + (value.as_ptr() as usize - text.as_ptr() as usize) as u32;
			walker.push(Edit::replace(
				EditSpan::new(start, start + value.len() as u32),
				vec![Piece::Text(routed)],
			));
		}
	}

	let (mut edits, marks, key, declined) = walker.finish();
	if let Some(why) = declined {
		return Err(why);
	}

	// the text ahead of the script's own code stays behind the directive
	// prologue (anything before it would make `'use strict'` a plain
	// expression) and behind a hashbang
	let mut pre = options.params.pre.clone();
	let key = key.or_else(|| options.params.key.clone());
	if options.holder && marks > 0 {
		let key = key.clone().unwrap_or_else(|| source_key(source));
		if let Some(holder) = holder_statement(&options.config.api, &key, source) {
			pre.push_str(&holder);
		}
	}
	if !pre.is_empty() {
		let directive = if options.module { None } else { program.directives.last() };
		match directive {
			Some(directive) => {
				let span = directive.span;
				if !source[..span.end as usize].ends_with(';') {
					pre.insert(0, ';');
				}
				edits.push(Edit::wrap(
					EditSpan::new(span.start, span.end),
					Vec::new(),
					vec![Piece::Text(pre)],
				));
			}
			None => {
				let mut at = program.hashbang.as_ref().map_or(0, |hashbang| hashbang.span.end);
				if at > 0 {
					pre.insert(0, '\n');
				} else if !options.module {
					// `--> text` is a comment only where its line starts: the
					// text goes behind such lines, not ahead of the first
					at = after_close_comments(source) as u32;
					if at > 0 && !source[..at as usize].ends_with(LINE_ENDS) {
						pre.insert(0, '\n');
					}
				}
				edits.push(Edit::insert(at, vec![Piece::Text(pre)], -1));
			}
		}
	}

	let text = apply(source, edits).map_err(|_| Decline::Edits)?;
	// a call kept as a target must still be a call the browser takes as
	// one (the walk may have made a direct eval of it a conditional)
	if freed {
		let check = Allocator::default();
		let (_, reparsed, _) = parse_targets(&check, &text, source_type, &parse_options);
		if reparsed.fatal_error || reparsed.diagnostics.has_errors() {
			return Err(Decline::Parse);
		}
	}
	Ok(Output {
		text,
		marks,
		key: if marks > 0 { key.unwrap_or_else(|| source_key(source)) } else { String::new() },
	})
}

/// `# sourceURL=x` or `# sourceMappingURL=x` (`@` too), as a comment's text
fn devtools_comment(text: &str) -> Option<(&str, &str)> {
	let text = text.trim_matches(js_whitespace);
	let rest = text.strip_prefix('#').or_else(|| text.strip_prefix('@'))?;
	let rest = rest.trim_start_matches(js_whitespace);
	let (name, rest) = ["sourceMappingURL", "sourceURL"]
		.iter()
		.find_map(|name| rest.strip_prefix(name).map(|rest| (*name, rest)))?;
	let rest = rest.strip_prefix('=')?;
	let end = rest.find(js_whitespace).unwrap_or(rest.len());
	(end > 0).then(|| (name, &rest[..end]))
}

fn is_data_url(value: &str) -> bool {
	value.len() >= 5 && value.as_bytes()[..5].eq_ignore_ascii_case(b"data:")
}

pub fn js_whitespace(c: char) -> bool {
	c.is_whitespace() || c == '\u{feff}'
}

#[cfg(test)]
pub(crate) mod tests {
	use super::*;

	thread_local! {
		/// the scripts whose verdict the rewrite's walk and the check's own
		/// walk answer differently (none)
		pub(crate) static DIFFER: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
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
		let mut route = |kind: u32, text: &str| Some(format!("/routed/{kind}/{text}"));
		rewrite(source, &options, &mut route).map(|output| output.text)
	}

	/// the output without the function marks
	fn plain(source: &str) -> String {
		let out = run(source, false).unwrap();
		let mut plain = String::new();
		let mut rest = out.as_str();
		while let Some(at) = rest.find("/*") {
			let end = at + rest[at..].find("*/").unwrap() + 2;
			let inner = &rest[at + 2..end - 2];
			plain.push_str(&rest[..at]);
			if inner.matches('.').count() != 2 || inner.contains(' ') {
				plain.push_str(&rest[at..end]);
			}
			rest = &rest[end..];
		}
		plain + rest
	}

	#[test]
	fn scripts_and_modules_parse() {
		assert!(run("const x = 1;", false).is_ok());
		assert!(run("return 1;", false).is_ok());
		assert!(run("import a from './a.js'; export const b = a;", true).is_ok());
	}

	#[test]
	fn what_does_not_parse_is_declined() {
		assert_eq!(run("const = ;", false), Err(Decline::Parse));
		assert_eq!(run("import a from './a.js';", false), Err(Decline::Parse));
		assert_eq!(run("%DebugPrint(1)", false), Err(Decline::Invalid));
		assert_eq!(
			run("function f({ top: t }) { 'use strict'; }", false),
			Err(Decline::Invalid)
		);
		assert!(parses("a.b()", true) && parses("'use strict'", true));
		assert!(!parses("a; b", true) && !parses("return 1", true) && !parses("if (a) b", true));
		assert!(parses("return 1", false) && !parses("const = ;", false));
	}

	#[test]
	fn untouched_bytes_are_identical() {
		let source = "/* c */ const x = 1n; // d\nfoo(`a${x}`, /re/g)\n";
		assert_eq!(run(source, false).unwrap(), source);
	}

	#[test]
	fn identifier_reads() {
		assert_eq!(plain("x = location;"), "x = 0..$s$j.get(location, \"location\");");
		assert_eq!(plain("({ top })"), "({ top: 0..$s$j.get(top, \"top\") })");
		assert_eq!(plain("typeof top; a.top;"), "typeof top; 0..$s$j.get2(a, \"top\", \"(a.top)\");");
		assert_eq!(plain("return[location]"), "return[0..$s$j.get(location, \"location\")]");
	}

	#[test]
	fn member_reads() {
		assert_eq!(plain("x = o[k];"), "x = 0..$s$j.get2(o, k, \"(o[k])\");");
		assert_eq!(plain("return o[k];"), "return 0..$s$j.get2(o, k, \"o[k]\");");
		assert_eq!(
			plain("f(location.href)"),
			"f(0..$s$j.get(location, \"location\").href)"
		);
		assert_eq!(
			plain("x = a[b][c]"),
			"x = 0..$s$j.get2(0..$s$j.get2(a, b, \"(a[b])\"), c, \"(a[b][c])\")"
		);
		assert_eq!(plain("return\"abc\"[i]"), "return 0..$s$j.get2(\"abc\", i, \"\\\"abc\\\"[i]\")");
		assert_eq!(plain("x = o['a'] + o[0]"), "x = o['a'] + 0..$s$j.get2(o, 0, \"(o[0])\")");
	}

	#[test]
	fn own_arguments() {
		// a function's own arguments object, read by a computed key
		assert_eq!(
			plain("function f() { return arguments[i]; }"),
			"function f() { return 0..$s$j.arg(arguments, i, \"arguments[i]\"); }"
		);
		assert_eq!(
			plain("function f() { return () => arguments[0]; }"),
			"function f() { return () => 0..$s$j.arg(arguments, 0, \"(arguments[0])\"); }"
		);
		// none of a script's top, an initializer's, or one that may be rebound
		assert_eq!(plain("x = arguments[i];"), "x = 0..$s$j.get2(arguments, i, \"(arguments[i])\");");
		assert_eq!(
			plain("function f(arguments) { return arguments[i]; }"),
			"function f(arguments) { return 0..$s$j.get2(arguments, i, \"arguments[i]\"); }"
		);
		assert_eq!(
			plain("function f() { with (o) return arguments[i]; }"),
			"function f() { with (o) return 0..$s$j.get2(arguments, i, \"arguments[i]\"); }"
		);
		assert_eq!(
			plain("function f() { return arguments?.[i]; }"),
			"function f() { return 0..$s$j.get2(arguments, i, \"(arguments?.[i])\", true); }"
		);
		assert_eq!(
			plain("function f() { return arguments.top; }"),
			"function f() { return 0..$s$j.get2(arguments, \"top\", \"arguments.top\"); }"
		);
	}

	#[test]
	fn object_spreads() {
		// what may be a window is looked at by the access API first
		assert_eq!(plain("x = { ...o }"), "x = { ...0..$s$j.spread(o) }");
		assert_eq!(
			plain("x = { a, ...this, ...f(), ...o.p, ...(p || {}) }"),
			"x = { a, ...0..$s$j.spread(this), ...0..$s$j.spread(f()), ...0..$s$j.spread(o.p), ...0..$s$j.spread((p || {})) }"
		);
		// its argument is rewritten as it was
		assert_eq!(
			plain("x = { ...top, ...o[k] }"),
			"x = { ...0..$s$j.spread(0..$s$j.get(top, \"top\")), ...0..$s$j.spread(0..$s$j.get2(o, k, \"o[k]\")) }"
		);
		// what is no window for certain is left as it is
		assert_eq!(
			plain("x = { ...{ a }, ...[b], ...(c ? { d } : {}), ...(e && { f }), ...'g', ...!h }"),
			"x = { ...{ a }, ...[b], ...(c ? { d } : {}), ...(e && { f }), ...'g', ...!h }"
		);
		// an array's spread and a call's are iterated, as they were
		assert_eq!(plain("x = [...o]; f(...o)"), "x = [...o]; f(...o)");
	}

	#[test]
	fn object_rests() {
		// a rest or an index key: the source is looked at, marked
		assert_eq!(
			plain("const { ...r } = o;"),
			"const { ...r } = 0..$s$j.pattern(o, {\"...\":true}, \"{ ...r } = o\");"
		);
		assert_eq!(
			plain("const { a, 0: b, ...r } = o;"),
			"const { a, 0: b, ...r } = 0..$s$j.pattern(o, {\"...\":true}, \"{ a, 0: b, ...r } = o\");"
		);
		assert_eq!(
			plain("({ ...r } = o);"),
			"({ ...r } = 0..$s$j.pattern(o, {\"...\":true}, \"({ ...r } = o)\"));"
		);
		// with an unforgeable's name, the whole spec as before
		assert_eq!(
			plain("const { top, ...r } = o;"),
			"const { top, ...r } = 0..$s$j.pattern(o, {\"top\":true}, \"{ top, ...r } = o\");"
		);
		// none: a plain key, an index that is no index
		assert_eq!(plain("const { a, '01': b } = o;"), "const { a, '01': b } = o;");
	}

	#[test]
	fn optional_chains() {
		assert_eq!(plain("x = a?.[k]"), "x = 0..$s$j.get2(a, k, \"(a?.[k])\", true)");
		assert_eq!(plain("x = a?.[k].x"), "x = 0..$s$j.lazy(a)?.(k).x");
		assert_eq!(
			plain("x = a?.b[k].x"),
			"x = 0..$s$j.get2(a?.b, k, \"(a?.b[k])\", true)?.x"
		);
		assert_eq!(plain("x = a?.b[k()]"), "x = 0..$s$j.lazy(a?.b)?.(k())");
	}

	#[test]
	fn calls() {
		assert_eq!(plain("o[k](a)"), "0..$s$j.call2(o, k, [a], \"o[k](0)\")");
		assert_eq!(plain("o[k](f())"), "0..$s$j.fn2(o, k, \"o[k](0)\")(f())");
		assert_eq!(
			plain("location.reload()"),
			"0..$s$j.call2(location, \"reload\", [], \"location.reload()\")".replace("location,", "0..$s$j.get(location, \"location\"),")
		);
		assert_eq!(plain("top(1)"), "0..$s$j.fcall(0..$s$j.get(top, \"top\"), [1], \"top(0)\")");
		assert_eq!(
			plain("a?.[k](f())"),
			"0..$s$j.method(a, true, false, \"a?.[k](0)\")?.(k)?.(f())"
		);
		assert_eq!(plain("new o[k]"), "0..$s$j.new2(o, k, [], \"new (o[k])()\")");
		assert_eq!(
			plain("new top"),
			"0..$s$j.fnew(0..$s$j.get(top, \"top\"), [], \"new (top)()\")"
		);
	}

	#[test]
	fn post_message_reads() {
		// a call is `post`; every other way to the function is a read of it
		assert_eq!(
			plain("w.postMessage.call(v, m)"),
			"0..$s$j.call3(w, \"postMessage\", \"call\", [v, m], \"w.postMessage.call(0, 0)\")"
		);
		assert!(plain("x = w.postMessage").starts_with("x = 0..$s$j.get2(w, \"postMessage\", "));
		assert!(plain("f(w['postMessage'])").starts_with("f(0..$s$j.get2(w, 'postMessage', "));
		for kept in [
			"w.postMessage = f",
			"w.postMessage++",
			"new w.postMessage()",
			"delete w.postMessage",
			"w.postMessage`t`",
			"class A extends B { m() { return super.postMessage } }",
			"class A extends B { m() { super.postMessage.call(this, m) } }",
		] {
			assert_eq!(plain(kept), kept);
		}
		assert_eq!(
			plain("var { postMessage: pm } = parent"),
			"var { postMessage: pm } = 0..$s$j.pattern(parent, {\"postMessage\":true}, \"{ postMessage: pm } = parent\")"
		);
	}

	#[test]
	fn with_scopes() {
		assert_eq!(
			plain("with (o) postMessage(m)"),
			"with (0..$s$j.scope(o)) with (0..$s$j.scoped()) postMessage(m)"
		);
		assert_eq!(
			plain("with (a, b) { postMessage }"),
			"with (0..$s$j.scope((a, b))) with (0..$s$j.scoped()) { postMessage }"
		);
		assert_eq!(plain("with (o) o.postMessage = 1"), "with (o) o.postMessage = 1");
		assert_eq!(plain("with (o) ({ postMessage: 1 })"), "with (o) ({ postMessage: 1 })");
	}

	#[test]
	fn index_writes() {
		assert_eq!(
			plain("s[0] = o"),
			"0..$s$j.set2(s, 0, (t$t, t$p, t$v) => t$t[t$p] = t$v, o, \"(s[0] = o)\")"
		);
		assert_eq!(
			plain("s.options['1'] = (o)"),
			"0..$s$j.set2(s.options, '1', (t$t, t$p, t$v) => t$t[t$p] = t$v, (o), \"(s.options['1'] = (o))\")"
		);
		// a value made where it is written is no node
		for kept in [
			"m[0] = a * b",
			"m[0] = (1)",
			"m[0] = `t`",
			"m[0] = [a]",
			"m[0] = {}",
			"m[0] = () => a",
			"m[0] = a ? 1 : (2)",
			"m[0] = (a, -b)",
			"m[0] += o",
			"m[0.5] = o",
			"m['01'] = o",
		] {
			assert_eq!(plain(kept), kept);
		}
	}

	#[test]
	fn writes() {
		assert_eq!(
			plain("location = u"),
			"0..$s$j.set1(location, \"location\", (t$t, t$p, t$v) => t$t[t$p] = t$v, t$v => location = t$v, u, \"(location = u)\")"
		);
		assert_eq!(
			plain("o[k] += v"),
			"0..$s$j.set2(o, k, (t$t, t$p, t$v) => t$t[t$p] += t$v, v, \"(o[k] += v)\")"
		);
		assert_eq!(
			plain("o[k]++"),
			"0..$s$j.set2(o, k, (t$t, t$p, t$v) => t$t[t$p]++, undefined, \"(o[k]++)\")"
		);
		assert_eq!(
			plain("o[k]++\n(f)()"),
			"0..$s$j.set2(o, k, (t$t, t$p, t$v) => t$t[t$p]++, undefined, \"(o[k]++)\");\n(f)()"
		);
		assert_eq!(
			plain("[location] = a"),
			"[0..$s$j.ref1(location, t$v => location = t$v).value] = a"
		);
	}

	#[test]
	fn the_rest() {
		assert_eq!(plain("k in o"), "0..$s$j.has(k, o)");
		assert_eq!(plain("'k' in o; debugger"), "'k' in o; ;");
		assert_eq!(
			plain("import(u)"),
			"0..$s$j.import(\"https://a.example/x.js\", u)"
		);
		assert_eq!(
			plain("w.postMessage(m, '*')"),
			"0..$s$j.post(w, [m, '*'], 1, \"w.postMessage(0, 0)\")"
		);
		// the `;` that keeps a statement's opening parenthesis from being the
		// call of the one before stands ahead of the whole statement
		assert_eq!(plain("x\neval(c)"), "x\n;(0..$s$j.isEval(eval) ? eval(0..$s$j.evalScope(c)) : eval(c))");
		assert!(plain("x\neval(c)[b]").starts_with("x\n0..$s$j.get2((0..$s$j.isEval(eval) ?"));
		assert!(plain("x\neval(c).top").starts_with("x\n0..$s$j.get2((0..$s$j.isEval(eval) ?"));
		assert!(plain("x\neval(c).top = 1").starts_with("x\n0..$s$j.set2((0..$s$j.isEval(eval) ?"));
		assert!(plain("x\neval(c).postMessage(m)").starts_with("x\n0..$s$j.post((0..$s$j.isEval(eval) ?"));
		assert!(plain("x\neval(c)(top)").starts_with("x\n;(0..$s$j.isEval(eval) ?"));
		assert!(plain("x\neval(c), top").starts_with("x\n;(0..$s$j.isEval(eval) ?"));
		assert_eq!(
			plain("x = eval(c)"),
			"x = (0..$s$j.isEval(eval) ? eval(0..$s$j.evalScope(c)) : eval(c))"
		);
		assert_eq!(
			plain("const { top: t } = o"),
			"const { top: t } = 0..$s$j.pattern(o, {\"top\":true}, \"{ top: t } = o\")"
		);
		assert_eq!(
			plain("var location = u;"),
			"{var $s$jl0 = u;0..$s$j.set1(location, \"location\", (t$t, t$p, t$v) => t$t[t$p] = t$v, t$v => location = t$v, $s$jl0, \"(location=$s$jl0)\");}"
		);
	}

	#[test]
	fn the_holes() {
		// a lazy member call with what a chain cannot have on it stands in
		// parentheses
		assert_eq!(
			plain("o[k].m(f()).v = 1"),
			"(0..$s$j.method(0..$s$j.get2(o, k, \"(o[k])\"), false, false, \"o[k].m(0)\")?.(\"m\")?.(f())).v = 1"
		);
		// a post's method read for `.call` or `.apply` is a read of it, made
		// where the page wrote it
		assert_eq!(
			plain("f().postMessage.call(w, m)"),
			"0..$s$j.call3(f(), \"postMessage\", \"call\", [w, m], \"f().postMessage.call(0, 0)\")"
		);
		assert_eq!(
			plain("x.postMessage.apply(w, [1], g())"),
			"0..$s$j.method(0..$s$j.get2(x, \"postMessage\", \"(x.postMessage)\"), false, false, \"x.postMessage.apply(0, 0, 0)\")?.(\"apply\")?.(w, [1], g())"
		);
		// super's members
		assert_eq!(plain("o = { m() { super.top } }"), "o = { m() { 0..$s$j.get(super.top, \"top\") } }");
		assert_eq!(
			plain("o = { m() { super[k] } }"),
			"o = { m() { (t$p => 0..$s$j.get(super[t$p], t$p))(0..$s$j.key((this, k))) } }"
		);
		assert_eq!(
			plain("o = { m() { super.eval(c) } }"),
			"o = { m() { 0..$s$j.smethod(0..$s$j.get(super.eval, \"eval\"), this, \"super.eval(0)\")(c) } }"
		);
		assert_eq!(
			plain("o = { m() { super.location = u } }"),
			"o = { m() { 0..$s$j.sset(\"location\", this, t$p => super[t$p], (t$p, t$v) => super[t$p] = t$v, (t$t, t$p, t$v) => t$t[t$p] = t$v, u) } }"
		);
		assert_eq!(
			plain("o = { m() { [super[k]] = a } }"),
			"o = { m() { [0..$s$j.sref((this, k), this, t$p => super[t$p], (t$p, t$v) => super[t$p] = t$v).value] = a } }"
		);
		assert_eq!(plain("o = { m() { super.x; super.top`t` } }"), "o = { m() { super.x; super.top`t` } }");
		// computed keys, heritage, a target whose key is known when it runs
		assert_eq!(plain("({ [top]: 1 })"), "({ [0..$s$j.get(top, \"top\")]: 1 })");
		assert_eq!(plain("class A extends top {}"), "class A extends 0..$s$j.get(top, \"top\") {}");
		assert_eq!(
			plain("[o[k]] = a"),
			"[0..$s$j.ref2(o, k, (t$t, t$p, t$v) => t$t[t$p] = t$v).value] = a"
		);
		// what a replacement stands around
		assert_eq!(
			plain("import(top)"),
			"0..$s$j.import(\"https://a.example/x.js\", 0..$s$j.get(top, \"top\"))"
		);
		// patterns wherever they stand
		assert_eq!(
			plain("const [{ top: t }] = a"),
			"const [{ top: t }] = 0..$s$j.pattern(0..$s$j.iter(a, \"array\", \"a\"), {\"[]\":[{\"top\":true}]})"
		);
		assert_eq!(
			plain("const [x, ...[{ top: t }]] = a"),
			"const [x, [{ top: t }]] = 0..$s$j.pattern(0..$s$j.iter(a, \"array\", \"a\"), {\"[]\":[0,[{\"[]\":[{\"top\":true}]}]]})"
		);
		assert_eq!(
			plain("const { [k]: { top: t }, a } = o"),
			"const { [k]: { top: t }, a } = 0..$s$j.pattern(o, {\"{}\":[{\"top\":true},0]}, \"{ [k]: { top: t }, a } = o\")"
		);
		assert_eq!(
			plain("for (const { top: t } of a) f(t)"),
			"for (const $s$jf of a) {const { top: t } = 0..$s$j.pattern($s$jf, {\"top\":true}, \"{ top: t }=$s$jf\");f(t)}"
		);
		// minified: no space between the head's pattern and `of`, or between
		// `of` and what it iterates (discord.com/login's web bundle)
		assert_eq!(
			plain("for(const{location:t}of a)f(t)"),
			"for(const $s$jf of a){const {location:t} = 0..$s$j.pattern($s$jf, {\"location\":true}, \"{location:t}=$s$jf\");f(t)}"
		);
		for source in [
			"for(const{location:t,applicationId:n}of nR.Ay.values()){g(t,n)}",
			"for(let{top:t}of a)f(t)",
			"for(var[{location:l}]of a)f(l)",
			"for({top:t}of a)f(t)",
			"for([{location:l}]of a)f(l)",
		] {
			let out = plain(source);
			assert!(!out.contains("$s$jfof"), "{source} -> {out}");
		}
		assert_eq!(
			plain("try {} catch ({ top: t }) {}"),
			"try {} catch ($s$jc) {let { top: t } = 0..$s$j.pattern($s$jc, {\"top\":true}, \"{ top: t }=$s$jc\");}"
		);
		assert_eq!(
			plain("function f({ top: t }, b = t) {}"),
			"function f($s$ja0, $s$ja1 = void 0, ...{ $s$jp0: { top: t } = 0..$s$j.pattern($s$ja0, {\"top\":true}, \"{ top: t }=$s$ja0\"), $s$jp1: b = $s$ja1 === void 0 ? t : $s$ja1 }) {}"
		);
		// `eval` as a pattern's target is a reference whose write keeps it the eval
		assert_eq!(plain("[eval] = [e]"), "[0..$s$j.ref1(eval, t$v => eval = t$v, \"eval\").value] = [e]");
		assert_eq!(
			plain("({ eval } = o)"),
			"({ eval: 0..$s$j.ref1(eval, t$v => eval = t$v, \"eval\").value } = 0..$s$j.pattern(o, {\"eval\":true}, \"({ eval } = o)\"))"
		);
		assert_eq!(plain("[location] = a"), "[0..$s$j.ref1(location, t$v => location = t$v).value] = a");
		// a parenthesised string stays an expression
		assert_eq!(plain("('use strict'); top"), "('use strict'); 0..$s$j.get(top, \"top\")");
	}

	#[test]
	fn calls_as_targets() {
		// V8 compiles a call as a target and throws when it is reached: the
		// page's target is kept, its own parts rewritten
		for case in ["f(top) = 1", "f() += top", "f()++; --g()", "for (f() in o) top; for (g() of o);", "(f()) = 1; f() /* c */ = 1", "'use strict'; f() = 1"] {
			assert!(run(case, false).is_ok(), "{case}");
		}
		assert_eq!(plain("f(top) = 1"), "f(0..$s$j.get(top, \"top\")) = 1");
		assert_eq!(plain("f() += top"), "f() += 0..$s$j.get(top, \"top\")");
		assert_eq!(plain("f()++; --g()"), "f()++; --g()");
		assert_eq!(plain("for (f() in o) top; for (g() of o);"), "for (f() in o) 0..$s$j.get(top, \"top\"); for (g() of o);");
		assert_eq!(plain("(f()) = 1; f() /* c */ = 1"), "(f()) = 1; f() /* c */ = 1");
		assert_eq!(plain("'use strict'; f() = 1"), "'use strict'; f() = 1");
		// what V8 refuses stays refused
		for refused in ["f?.() = 1", "new f() = 1", "f()`t` = 1", "f() &&= 1", "[f()] = a", "({ a: f() } = a)", "for (let() of a);", "(f() = 1) => 0"] {
			assert!(run(refused, false).is_err(), "{refused}");
		}
	}

	#[test]
	fn parameter_patterns_bind_in_the_parameters() {
		// bound in a rest the list ends with, when the function is called
		assert_eq!(
			plain("function* g({ top: t }, u = t, v) {}"),
			"function* g($s$ja0, $s$ja1 = void 0, v, ...{ $s$jp0: { top: t } = 0..$s$j.pattern($s$ja0, {\"top\":true}, \"{ top: t }=$s$ja0\"), $s$jp1: u = $s$ja1 === void 0 ? t : $s$ja1 }) {}"
		);
		assert_eq!(
			plain("({ location }, ) => location"),
			"($s$ja0,  ...{ $s$jp0: { location } = 0..$s$j.pattern($s$ja0, {\"location\":true}, \"{ location }=$s$ja0\") }) => 0..$s$j.get(location, \"location\")"
		);
		// a list with a rest of its own, and a setter's, bind at the top of the body
		assert_eq!(
			plain("function f({ top: t }, ...r) {}"),
			"function f($s$ja0, ...r) {var { top: t } = 0..$s$j.pattern($s$ja0, {\"top\":true}, \"{ top: t }=$s$ja0\");}"
		);
		assert_eq!(
			plain("o = { set x({ top: t }) {} }"),
			"o = { set x($s$ja0) {var { top: t } = 0..$s$j.pattern($s$ja0, {\"top\":true}, \"{ top: t }=$s$ja0\");} }"
		);
	}

	#[test]
	fn evaluation_order() {
		// a compound or logical write whose value does work: the operator
		// itself reads the reference, evaluates the value (or does not), writes
		assert_eq!(
			plain("o[k] ||= f()"),
			"0..$s$j.ref2(o, k, (t$t, t$p, t$v) => t$t[t$p] = t$v).value ||= f()"
		);
		assert_eq!(
			plain("x = (o.top) += g()"),
			"x = (0..$s$j.ref2(o, \"top\", (t$t, t$p, t$v) => t$t[t$p] = t$v).value) += g()"
		);
		assert_eq!(
			plain("location ??= f()"),
			"0..$s$j.ref1(location, t$v => location = t$v).value ??= f()"
		);
		assert_eq!(
			plain("o = { m() { super[k] += f() } }"),
			"o = { m() { 0..$s$j.sref((this, k), this, t$p => super[t$p], (t$p, t$v) => super[t$p] = t$v).value += f() } }"
		);
		// (one whose value does none keeps the one helper)
		assert!(plain("o[k] ||= 1").starts_with("0..$s$j.set2(o, k, "));
		assert!(plain("o[k] = f()").starts_with("0..$s$j.set2(o, k, "));
		// a call whose arguments do work reads its method first
		assert_eq!(plain("o[k](f(), 1)"), "0..$s$j.fn2(o, k, \"o[k](0, 0)\")(f(), 1)");
		assert_eq!(plain("(o[k])(a.b)"), "0..$s$j.fn2(o, k, \"o[k](0)\")(a.b)");
		assert_eq!(
			plain("new o[k](f())"),
			"0..$s$j.fnew(0..$s$j.get2(o, k, \"(o[k])\"), [f()], \"new (o[k])(0)\")"
		);
		assert_eq!(
			plain("w.postMessage(f())"),
			"0..$s$j.poster(w, \"w.postMessage(0)\", 1)(f())"
		);
		assert_eq!(
			plain("w?.postMessage(f())"),
			"0..$s$j.poster(w, \"w?.postMessage(0)\", 2)?.(f())"
		);
		// a tag is called on its object
		assert_eq!(plain("o[k]`a${1}`"), "0..$s$j.fn2(o, k, \"o[k]()\")`a${1}`");
		assert_eq!(
			plain("new o[k]`a`"),
			"0..$s$j.fnew(0..$s$j.fn2(o, k, \"o[k]()\")`a`, [], \"new (o[k]`a`)()\")"
		);
		// `delete` of a chain's member deletes it, and an optional call of
		// eval is no direct eval
		assert_eq!(plain("delete o?.[k]; delete o?.a[k]"), "delete o?.[k]; delete o?.a[k]");
		assert_eq!(plain("eval?.(c)"), "0..$s$j.get(eval, \"eval\")?.(c)");
		assert_eq!(
			plain("eval(...a)"),
			"(0..$s$j.isEval(eval) ? eval(0..$s$j.evalScope(...a)) : eval(...a))"
		);
		// the value of a pattern assignment is its source
		assert_eq!(
			plain("r = ({ top: t } = o)"),
			"r = (0..$s$j.source({ top: t } = 0..$s$j.pattern(o, {\"top\":true}, \"({ top: t } = o)\")))"
		);
		assert_eq!(
			plain("({ top: t } = o)"),
			"({ top: t } = 0..$s$j.pattern(o, {\"top\":true}, \"({ top: t } = o)\"))"
		);
	}

	#[test]
	fn modules_route_their_imports() {
		assert_eq!(
			run("import a from './a.js'; import b from 'b';", true).unwrap(),
			"import a from \"/routed/1/0:./a.js\"; import b from 'b';"
		);
	}

	#[test]
	fn the_preamble_follows_the_prologue() {
		let config = Config::default();
		let params = Params {
			pre: "PRE;".into(),
			..Params::default()
		};
		let options = Options {
			module: false,
			holder: false,
			config: &config,
			params: &params,
		};
		let mut route = |_: u32, _: &str| None;
		let out = |source: &str, route: &mut Route| rewrite(source, &options, route).unwrap().text;
		assert_eq!(out("'use strict'\nlocation", &mut route), "'use strict';PRE;\n0..$s$j.get(location, \"location\")");
		assert_eq!(out("location", &mut route), "PRE;0..$s$j.get(location, \"location\")");
		assert_eq!(
			out("--> a\n /* b */ --> c\nlocation", &mut route),
			"--> a\n /* b */ --> c\nPRE;0..$s$j.get(location, \"location\")"
		);
		assert_eq!(out("--> a", &mut route), "--> a\nPRE;");
		assert_eq!(out("a-->b", &mut route), "PRE;a-->b");
	}

	#[test]
	fn params_parse() {
		let params = Params::parse("https://a/x.js\nabc\n10,5,20,-3\nline one\nline two").unwrap();
		assert_eq!(params.url, "https://a/x.js");
		assert_eq!(params.key.as_deref(), Some("abc"));
		assert_eq!(params.shifts, vec![(10, 5), (20, -3)]);
		assert_eq!(params.pre, "line one\nline two");
		assert!(Params::parse("u\n\n\n").unwrap().key.is_none());
		assert!(Params::parse("u\n\n1\n").is_err());
	}
}
