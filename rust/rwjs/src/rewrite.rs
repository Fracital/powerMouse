//! The parse and the driver: what a rewrite is given, what it answers, and
//! what goes around the walk (the text ahead of the script's own code, the
//! holder of its text, the routed source map). The walk itself is `walk`.
use edits::{Edit, Piece, Span as EditSpan, apply};
use oxc::allocator::Allocator;
use oxc::ast_visit::Visit;
use oxc::parser::{ParseOptions, Parser};
use oxc::span::SourceType;

use crate::config::Config;
use crate::source::{Utf16Offsets, holder_statement, source_key};
use crate::walk::Walker;

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

/// The revision of what this rewriter writes, which the module answers for
/// `FLAG_REVISION`: raised whenever the output for any script changes, so a
/// cache of rewrites keyed on it never serves an older module's text.
/// rust/host/parity.mjs --cases holds it to the outputs (cases.revision).
pub const REVISION: &str = "2";

/// Why the rewriter hands a script back to the JavaScript one
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decline {
	/// the parser could not make a program of it
	Parse,
	/// a shape this rewriter does not rewrite yet
	Shape,
	/// a script no browser runs (a V8 intrinsic, `"use strict"` under a
	/// parameter pattern): the caller hands it back as it was, as the
	/// JavaScript rewriter does with what it cannot parse
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

/// Whether `source` parses as a classic script (`single`: one of a single
/// expression statement, with no `return` at its top level), for the
/// callers that ask the parser alone (src/rewriteJS.ts singleExpression,
/// src/rewriterLib.ts parsesAsScript)
pub fn parses(source: &str, single: bool) -> bool {
	let allocator = Allocator::default();
	let source_type = SourceType::unambiguous()
		.with_javascript(true)
		.with_module(false)
		.with_script(true)
		.with_standard(true);
	let parsed = Parser::new(&allocator, source, source_type)
		.with_options(ParseOptions {
			allow_return_outside_function: !single,
			..ParseOptions::default()
		})
		.parse();
	if parsed.fatal_error || parsed.diagnostics.has_errors() {
		return false;
	}
	if !single {
		return true;
	}
	let program = parsed.program;
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
	let source_type = SourceType::unambiguous()
		.with_javascript(true)
		.with_module(options.module)
		.with_script(!options.module)
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
		return Err(Decline::Parse);
	}
	let program = parsed.program;
	let offsets = Utf16Offsets::new(source);
	let mut walker = Walker::new(source, options, &offsets, route);
	walker.visit_program(&program);

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
		if let Some(holder) = holder_statement(&options.config.names.access, &key, source) {
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
mod tests {
	use super::*;

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
		assert_eq!(plain("x = location;"), "x = $s$j.get(location, \"location\");");
		assert_eq!(plain("({ top })"), "({ top: $s$j.get(top, \"top\") })");
		assert_eq!(plain("typeof top; a.top;"), "typeof top; $s$j.get2(a, \"top\", \"(a.top)\");");
		assert_eq!(plain("return[location]"), "return[$s$j.get(location, \"location\")]");
	}

	#[test]
	fn member_reads() {
		assert_eq!(plain("x = o[k];"), "x = $s$j.get2(o, k, \"(o[k])\");");
		assert_eq!(plain("return o[k];"), "return $s$j.get2(o, k, \"o[k]\");");
		assert_eq!(
			plain("f(location.href)"),
			"f($s$j.get(location, \"location\").href)"
		);
		assert_eq!(
			plain("x = a[b][c]"),
			"x = $s$j.get2($s$j.get2(a, b, \"(a[b])\"), c, \"(a[b][c])\")"
		);
		assert_eq!(plain("return\"abc\"[i]"), "return $s$j.get2(\"abc\", i, \"\\\"abc\\\"[i]\")");
		assert_eq!(plain("x = o['a'] + o[0]"), "x = o['a'] + $s$j.get2(o, 0, \"(o[0])\")");
	}

	#[test]
	fn optional_chains() {
		assert_eq!(plain("x = a?.[k]"), "x = $s$j.get2(a, k, \"(a?.[k])\", true)");
		assert_eq!(plain("x = a?.[k].x"), "x = $s$j.lazy(a)?.(k).x");
		assert_eq!(
			plain("x = a?.b[k].x"),
			"x = $s$j.get2(a?.b, k, \"(a?.b[k])\", true)?.x"
		);
		assert_eq!(plain("x = a?.b[k()]"), "x = $s$j.lazy(a?.b)?.(k())");
	}

	#[test]
	fn calls() {
		assert_eq!(plain("o[k](a)"), "$s$j.call2(o, k, [a], \"o[k](0)\")");
		assert_eq!(
			plain("o[k](f())"),
			"$s$j.call2(o, k, [f()], \"o[k](0)\")"
		);
		assert_eq!(
			plain("location.reload()"),
			"$s$j.call2(location, \"reload\", [], \"location.reload()\")".replace("location,", "$s$j.get(location, \"location\"),")
		);
		assert_eq!(plain("top(1)"), "$s$j.fcall($s$j.get(top, \"top\"), [1], \"top(0)\")");
		assert_eq!(
			plain("a?.[k](f())"),
			"$s$j.method(a, true, false, \"a?.[k](0)\")?.(k)?.(f())"
		);
		assert_eq!(plain("new o[k]"), "$s$j.new2(o, k, [], \"new (o[k])()\")");
		assert_eq!(
			plain("new top"),
			"$s$j.fnew($s$j.get(top, \"top\"), [], \"new (top)()\")"
		);
	}

	#[test]
	fn writes() {
		assert_eq!(
			plain("location = u"),
			"$s$j.set1(location, \"location\", (t$t, t$p, t$v) => t$t[t$p] = t$v, t$v => location = t$v, u, \"(location = u)\")"
		);
		assert_eq!(
			plain("o[k] += v"),
			"$s$j.set2(o, k, (t$t, t$p, t$v) => t$t[t$p] += t$v, v, \"(o[k] += v)\")"
		);
		assert_eq!(
			plain("o[k]++"),
			"$s$j.set2(o, k, (t$t, t$p, t$v) => t$t[t$p]++, undefined, \"(o[k]++)\")"
		);
		assert_eq!(
			plain("o[k]++\n(f)()"),
			"$s$j.set2(o, k, (t$t, t$p, t$v) => t$t[t$p]++, undefined, \"(o[k]++)\");\n(f)()"
		);
		assert_eq!(
			plain("[location] = a"),
			"[$s$j.ref1(location, t$v => location = t$v).value] = a"
		);
	}

	#[test]
	fn the_rest() {
		assert_eq!(plain("k in o"), "$s$j.has(k, o)");
		assert_eq!(plain("'k' in o; debugger"), "'k' in o; ;");
		assert_eq!(
			plain("import(u)"),
			"$s$j.import(\"https://a.example/x.js\", u)"
		);
		assert_eq!(
			plain("w.postMessage(m, '*')"),
			"$s$j.post(w, [m, '*'], false, \"w.postMessage(0, 0)\")"
		);
		// the `;` that keeps a statement's opening parenthesis from being the
		// call of the one before stands ahead of the whole statement
		assert_eq!(plain("x\neval(c)"), "x\n;($s$j.isEval(eval) ? eval($s$j.evalScope(c)) : eval(c))");
		assert!(plain("x\neval(c)[b]").starts_with("x\n$s$j.get2(($s$j.isEval(eval) ?"));
		assert!(plain("x\neval(c).top").starts_with("x\n$s$j.get2(($s$j.isEval(eval) ?"));
		assert!(plain("x\neval(c).top = 1").starts_with("x\n$s$j.set2(($s$j.isEval(eval) ?"));
		assert!(plain("x\neval(c).postMessage(m)").starts_with("x\n$s$j.post(($s$j.isEval(eval) ?"));
		assert!(plain("x\neval(c)(top)").starts_with("x\n;($s$j.isEval(eval) ?"));
		assert!(plain("x\neval(c), top").starts_with("x\n;($s$j.isEval(eval) ?"));
		assert_eq!(
			plain("x = eval(c)"),
			"x = ($s$j.isEval(eval) ? eval($s$j.evalScope(c)) : eval(c))"
		);
		assert_eq!(
			plain("const { top: t } = o"),
			"const { top: t } = $s$j.pattern(o, {\"top\":true}, \"{ top: t } = o\")"
		);
		assert_eq!(
			plain("var location = u;"),
			"{var $s$jl0 = u;$s$j.set1(location, \"location\", (t$t, t$p, t$v) => t$t[t$p] = t$v, t$v => location = t$v, $s$jl0, \"(location=$s$jl0)\");}"
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
		assert_eq!(out("'use strict'\nlocation", &mut route), "'use strict';PRE;\n$s$j.get(location, \"location\")");
		assert_eq!(out("location", &mut route), "PRE;$s$j.get(location, \"location\")");
		assert_eq!(
			out("--> a\n /* b */ --> c\nlocation", &mut route),
			"--> a\n /* b */ --> c\nPRE;$s$j.get(location, \"location\")"
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
