// What an isolated world runs (docs/extensions.md "Isolated worlds"): an
// ISOLATED script's source as the world evaluates it, and an extension
// module a world imports as a description the world's loader links
// (src/extensions/runtime/world/modules.ts). The world's realm has no
// module loader of its own, so `import()` is the world's `$world$import`,
// `import.meta` its `$world$meta`, and a module's static imports and
// exports are taken out of its body into the description. Read with a
// tokenizer of JavaScript's lexical grammar (strings, templates, comments,
// regular expressions told from division by the token before), which is
// all these need: imports and exports are statements of a module's top
// level, which tokens alone tell.

interface Token {
	/** n: a name, s: a string, t: a template's part, p: a punctuator, o: other */
	kind: 'n' | 's' | 't' | 'p' | 'o';
	text: string;
	start: number;
	end: number;
	/** a line break before it */
	line: boolean;
}

/** the names after which a `/` starts a regular expression */
const BEFORE_EXPRESSION = new Set([
	'return',
	'typeof',
	'instanceof',
	'in',
	'of',
	'new',
	'delete',
	'void',
	'throw',
	'case',
	'do',
	'else',
	'yield',
	'await',
]);

const PUNCTUATORS = [
	'>>>=',
	'...',
	'===',
	'!==',
	'**=',
	'<<=',
	'>>=',
	'>>>',
	'&&=',
	'||=',
	'??=',
	'=>',
	'==',
	'!=',
	'<=',
	'>=',
	'&&',
	'||',
	'??',
	'?.',
	'++',
	'--',
	'+=',
	'-=',
	'*=',
	'/=',
	'%=',
	'&=',
	'|=',
	'^=',
	'**',
	'<<',
	'>>',
];

const isNameStart = (char: string) => /[\p{ID_Start}$_\\]/u.test(char);
const isNamePart = (char: string) => /[\p{ID_Continue}$\\‌‍]/u.test(char);

/** the tokens of `source` (comments and white space are none) */
export function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	/** the brace depths a template's substitution opened at */
	const templates: number[] = [];
	let braces = 0;
	let at = 0;
	let line = false;
	const length = source.length;
	const regexAllowed = () => {
		const last = tokens[tokens.length - 1];
		if (!last) return true;
		if (last.kind === 'n') return BEFORE_EXPRESSION.has(last.text);
		if (last.kind === 't') return last.text.endsWith('${');
		if (last.kind === 'p')
			return last.text !== ')' && last.text !== ']' && last.text !== '}';
		return false;
	};
	const push = (kind: Token['kind'], start: number) => {
		tokens.push({ kind, text: source.slice(start, at), start, end: at, line });
		line = false;
	};
	/** a template's characters from `at` to its end or a substitution */
	const template = (start: number) => {
		for (; at < length; at++) {
			const char = source[at];
			if (char === '\\') at++;
			else if (char === '`') {
				at++;
				break;
			} else if (char === '$' && source[at + 1] === '{') {
				at += 2;
				templates.push(braces);
				braces++;
				break;
			}
		}
		push('t', start);
	};
	while (at < length) {
		const char = source[at];
		const start = at;
		if (
			char === '\n' ||
			char === '\r' ||
			char === '\u2028' ||
			char === '\u2029'
		) {
			line = true;
			at++;
			continue;
		}
		if (/\s/.test(char)) {
			at++;
			continue;
		}
		if (char === '/' && source[at + 1] === '/') {
			while (at < length && !/[\n\r\u2028\u2029]/.test(source[at])) at++;
			continue;
		}
		if (char === '/' && source[at + 1] === '*') {
			const close = source.indexOf('*/', at + 2);
			const end = close < 0 ? length : close + 2;
			if (/[\n\r\u2028\u2029]/.test(source.slice(at, end))) line = true;
			at = end;
			continue;
		}
		if (char === '"' || char === "'") {
			for (at++; at < length; at++) {
				if (source[at] === '\\') at++;
				else if (source[at] === char) {
					at++;
					break;
				}
			}
			push('s', start);
			continue;
		}
		if (char === '`') {
			at++;
			template(start);
			continue;
		}
		if (
			char === '}' &&
			templates.length &&
			templates[templates.length - 1] === braces - 1
		) {
			templates.pop();
			braces--;
			at++;
			template(start);
			continue;
		}
		if (char === '/' && regexAllowed()) {
			let klass = false;
			for (at++; at < length; at++) {
				const next = source[at];
				if (next === '\\') at++;
				else if (next === '[') klass = true;
				else if (next === ']') klass = false;
				else if (next === '/' && !klass) {
					at++;
					break;
				} else if (next === '\n') break;
			}
			while (at < length && isNamePart(source[at])) at++;
			push('o', start);
			continue;
		}
		if (isNameStart(char) || char === '#') {
			at++;
			while (at < length && isNamePart(source[at])) at++;
			push('n', start);
			continue;
		}
		if (
			/[0-9]/.test(char) ||
			(char === '.' && /[0-9]/.test(source[at + 1] ?? ''))
		) {
			at++;
			while (at < length && /[\w.]/.test(source[at])) {
				if (/[eE]/.test(source[at]) && /[+-]/.test(source[at + 1] ?? '')) at++;
				at++;
			}
			push('o', start);
			continue;
		}
		if (
			char === '?' &&
			source[at + 1] === '.' &&
			/[0-9]/.test(source[at + 2] ?? '')
		) {
			at++;
			push('p', start);
			continue;
		}
		const punctuator = PUNCTUATORS.find((candidate) =>
			source.startsWith(candidate, at),
		);
		at += punctuator ? punctuator.length : 1;
		if (char === '{') braces++;
		else if (char === '}') braces--;
		push('p', start);
	}
	return tokens;
}

/** edits of a source: ranges replaced by text */
type Edit = [start: number, end: number, text: string];

function applyEdits(source: string, edits: Edit[]): string {
	edits.sort((a, b) => a[0] - b[0]);
	let out = '';
	let at = 0;
	for (const [start, end, text] of edits) {
		out += source.slice(at, start) + text;
		at = end;
	}
	return out + source.slice(at);
}

/** a range blanked: its line breaks kept, so the code's lines stay where they were */
const blank = (source: string, start: number, end: number) =>
	source.slice(start, end).replace(/[^\n\r\u2028\u2029]/g, '');

/** whether the name at `index` is the `import` of an `import(...)` call or of `import.meta` */
function importAt(tokens: Token[], index: number): 'call' | 'meta' | null {
	const token = tokens[index];
	if (token.kind !== 'n' || token.text !== 'import') return null;
	const before = tokens[index - 1];
	// (a member named so, `a.import(`, or a method, `import() {`)
	if (
		before &&
		before.kind === 'p' &&
		(before.text === '.' || before.text === '?.')
	)
		return null;
	const next = tokens[index + 1];
	if (next?.text === '.' && tokens[index + 2]?.text === 'meta') return 'meta';
	if (next?.text !== '(') return null;
	let depth = 0;
	for (let at = index + 1; at < tokens.length; at++) {
		const text = tokens[at].kind === 'p' ? tokens[at].text : '';
		if (text === '(') depth++;
		else if (text === ')' && --depth === 0)
			return tokens[at + 1]?.text === '{' ? null : 'call';
	}
	return 'call';
}

/** an ISOLATED script's source as its world runs it: its `import()` the world's */
export function worldScript(source: string): string {
	if (!source.includes('import')) return source;
	const tokens = tokenize(source);
	const edits: Edit[] = [];
	for (let index = 0; index < tokens.length; index++)
		if (importAt(tokens, index) === 'call') {
			const token = tokens[index];
			edits.push([token.start, token.end, '$world$import']);
		}
	return applyEdits(source, edits);
}

/** what a string token says */
function stringValue(token: Token): string {
	try {
		return JSON.parse(
			token.text[0] === "'"
				? `"${token.text.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`
				: token.text,
		);
	} catch (error) {
		return token.text.slice(1, -1);
	}
}

/** a binding's name or a string's (`export { a as "b c" }`) */
const nameOf = (token: Token) =>
	token.kind === 's' ? stringValue(token) : token.text;

/**
 * An extension's module as the world's loader links it: a description
 * whose `i` are its static imports' specifiers, `b` its imported bindings,
 * `r` its re-exports, and `f` its body as a function of the world's
 * globals, which defines its exports, stops, then runs on
 * (src/extensions/runtime/world/modules.ts)
 */
export function worldModule(source: string, url: string): string {
	const tokens = tokenize(source);
	const specifiers: string[] = [];
	const bindings: [number, string, string][] = [];
	const reexports: [number, string, string | null][] = [];
	/** exported name -> the local binding */
	const exports = new Map<string, string>();
	const edits: Edit[] = [];
	const dependency = (specifier: string) => {
		const known = specifiers.indexOf(specifier);
		if (known >= 0) return known;
		specifiers.push(specifier);
		return specifiers.length - 1;
	};
	let depth = 0;
	let index = 0;
	/** the end of the statement whose tokens start at `from` (its `;`, or where a line break ends it) */
	const statementEnd = (from: number): number => {
		let level = 0;
		for (let at = from; at < tokens.length; at++) {
			const token = tokens[at];
			const text = token.kind === 'p' ? token.text : '';
			if (text === '(' || text === '[' || text === '{') level++;
			else if (text === ')' || text === ']' || text === '}') {
				if (level === 0) return at - 1;
				level--;
			} else if (text === ';' && level === 0) return at;
			else if (level === 0 && at > from && token.line) {
				const last = tokens[at - 1];
				const ends =
					last.kind === 's' ||
					last.kind === 'o' ||
					(last.kind === 't' && last.text.endsWith('`')) ||
					(last.kind === 'n' && !BEFORE_EXPRESSION.has(last.text)) ||
					(last.kind === 'p' &&
						(last.text === ')' || last.text === ']' || last.text === '}'));
				const continues =
					token.kind === 'p' &&
					!['{', '!', '~', '++', '--'].includes(token.text) &&
					token.text !== '}';
				if (ends && !continues) return at - 1;
			}
		}
		return tokens.length - 1;
	};
	/** skip a `with { type: 'json' }` (or `assert`) after a specifier */
	const attributesEnd = (at: number): number => {
		const next = tokens[at + 1];
		if (
			next?.kind === 'n' &&
			(next.text === 'with' || next.text === 'assert') &&
			tokens[at + 2]?.text === '{'
		) {
			let level = 0;
			for (let end = at + 2; end < tokens.length; end++) {
				if (tokens[end].text === '{') level++;
				else if (tokens[end].text === '}' && --level === 0) return end;
			}
		}
		return at;
	};
	const remove = (from: number, to: number) => {
		const last =
			tokens[to + 1]?.text === ';' && tokens[to].text !== ';' ? to + 1 : to;
		edits.push([
			tokens[from].start,
			tokens[last].end,
			blank(source, tokens[from].start, tokens[last].end),
		]);
		return last;
	};
	/** `{ a, b as c, default as d }` from `open`: [name, alias] pairs, and the `}` */
	const braced = (open: number): [[string, string][], number] => {
		const pairs: [string, string][] = [];
		let at = open + 1;
		while (at < tokens.length && tokens[at].text !== '}') {
			const name = nameOf(tokens[at]);
			let alias = name;
			if (tokens[at + 1]?.text === 'as') {
				alias = nameOf(tokens[at + 2]);
				at += 2;
			}
			pairs.push([name, alias]);
			at++;
			if (tokens[at]?.text === ',') at++;
		}
		return [pairs, at];
	};
	/** the names a declaration's binding pattern declares, from `at` to `end` */
	const declared = (from: number, end: number): string[] => {
		const names: string[] = [];
		let level = 0;
		let skipping = false;
		let skipLevel = 0;
		for (let at = from; at <= end; at++) {
			const token = tokens[at];
			const text = token.kind === 'p' ? token.text : '';
			if (text === '(' || text === '[' || text === '{') {
				level++;
				continue;
			}
			if (text === ')' || text === ']' || text === '}') {
				level--;
				if (skipping && level < skipLevel) skipping = false;
				continue;
			}
			if (skipping) {
				if (text === ',' && level === skipLevel) skipping = false;
				continue;
			}
			if (text === '=') {
				skipping = true;
				skipLevel = level;
				continue;
			}
			if (token.kind === 'n' && tokens[at + 1]?.text !== ':') {
				const before = tokens[at - 1];
				if (
					before?.text === '...' ||
					!before ||
					before.kind === 'p' ||
					before.kind === 'n'
				)
					names.push(token.text);
			}
		}
		return names;
	};
	for (; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.kind === 'p') {
			if (token.text === '{' || token.text === '(' || token.text === '[')
				depth++;
			else if (token.text === '}' || token.text === ')' || token.text === ']')
				depth--;
			continue;
		}
		if (token.kind === 't') {
			// a template's substitution opens a level its next part closes
			if (token.text.endsWith('${')) depth++;
			if (!token.text.startsWith('`')) depth--;
			continue;
		}
		if (token.kind !== 'n') continue;
		const use = importAt(tokens, index);
		if (use === 'call') {
			edits.push([token.start, token.end, '$world$import']);
			continue;
		}
		if (use === 'meta') {
			edits.push([token.start, tokens[index + 2].end, '$world$meta']);
			index += 2;
			continue;
		}
		const before = tokens[index - 1];
		// (a declaration is all an `import` or `export` of the top level can
		// be, but a member's name)
		if (
			depth !== 0 ||
			(before?.kind === 'p' && (before.text === '.' || before.text === '?.'))
		)
			continue;
		if (token.text === 'import') {
			const next = tokens[index + 1];
			if (!next) continue;
			if (next.kind === 's') {
				dependency(stringValue(next));
				index = remove(index, attributesEnd(index + 1));
				continue;
			}
			// import a, { b as c }, * as d from 'x'
			let at = index + 1;
			const locals: [string, string][] = [];
			while (at < tokens.length && tokens[at].text !== 'from') {
				const part = tokens[at];
				if (part.text === '{') {
					const [pairs, close] = braced(at);
					locals.push(...pairs);
					at = close + 1;
				} else if (part.text === '*') {
					locals.push(['*', tokens[at + 2].text]);
					at += 3;
				} else if (part.text === ',') at++;
				else {
					locals.push(['default', part.text]);
					at++;
				}
			}
			const from = tokens[at + 1];
			if (!from || from.kind !== 's') continue;
			const dep = dependency(stringValue(from));
			for (const [name, local] of locals) bindings.push([dep, name, local]);
			index = remove(index, attributesEnd(at + 1));
			continue;
		}
		if (token.text !== 'export') continue;
		const next = tokens[index + 1];
		if (!next) continue;
		if (next.text === '*') {
			// export * from 'x', export * as y from 'x'
			let at = index + 2;
			let exported: string | null = null;
			if (tokens[at]?.text === 'as') {
				exported = nameOf(tokens[at + 1]);
				at += 2;
			}
			const from = tokens[at + 1];
			if (!from || from.kind !== 's') continue;
			reexports.push([dependency(stringValue(from)), '*', exported]);
			index = remove(index, attributesEnd(at + 1));
			continue;
		}
		if (next.text === '{') {
			const [pairs, close] = braced(index + 1);
			if (tokens[close + 1]?.text === 'from') {
				const dep = dependency(stringValue(tokens[close + 2]));
				for (const [name, alias] of pairs) reexports.push([dep, name, alias]);
				index = remove(index, attributesEnd(close + 2));
			} else {
				for (const [name, alias] of pairs) exports.set(alias, name);
				index = remove(index, close);
			}
			continue;
		}
		if (next.text === 'default') {
			const what = tokens[index + 2];
			const isAsync =
				what?.text === 'async' &&
				tokens[index + 3]?.text === 'function' &&
				!tokens[index + 3].line;
			const declaration = isAsync ? tokens[index + 3] : what;
			if (
				declaration &&
				(declaration.text === 'function' || declaration.text === 'class')
			) {
				let at = (isAsync ? index + 3 : index + 2) + 1;
				if (tokens[at]?.text === '*') at++;
				const named =
					tokens[at]?.kind === 'n' && tokens[at].text !== 'extends'
						? tokens[at].text
						: null;
				if (named) {
					exports.set('default', named);
					edits.push([token.start, next.end, '']);
				} else if (declaration.text === 'function') {
					// (an anonymous one is still hoisted, as a declaration is)
					exports.set('default', '$world$default');
					edits.push([token.start, next.end, '']);
					edits.push([
						tokens[at - 1].end,
						tokens[at - 1].end,
						' $world$default',
					]);
				} else {
					exports.set('default', '$world$default');
					edits.push([token.start, next.end, 'const $world$default =']);
				}
				index += 1;
				continue;
			}
			exports.set('default', '$world$default');
			edits.push([token.start, next.end, 'const $world$default =']);
			index += 1;
			continue;
		}
		if (
			next.text === 'function' ||
			next.text === 'class' ||
			(next.text === 'async' && tokens[index + 2]?.text === 'function')
		) {
			let at = index + (next.text === 'async' ? 3 : 2);
			if (tokens[at]?.text === '*') at++;
			exports.set(tokens[at].text, tokens[at].text);
			edits.push([token.start, token.end, '']);
			continue;
		}
		if (next.text === 'const' || next.text === 'let' || next.text === 'var') {
			const end = statementEnd(index + 2);
			for (const name of declared(index + 2, end)) exports.set(name, name);
			edits.push([token.start, token.end, '']);
			continue;
		}
	}
	const body = applyEdits(source, edits);
	const getters = [...exports]
		.map(([exported, local]) => `${JSON.stringify(exported)}: () => ${local}`)
		.join(', ');
	const head = `$world$export({ ${getters} }); yield;`;
	const parameters =
		'chrome, window, self, globalThis, document, location, top, parent, frames, $world$import, $world$meta, $world$export, $world$scope';
	const run = `return async function* () { 'use strict'; ${head}\n${body}\n};`;
	const fn = bindings.length
		? `(function (${parameters}) { with ($world$scope) { ${run} } })`
		: `(function (${parameters}) { ${run} })`;
	return `({ i: ${JSON.stringify(specifiers)}, b: ${JSON.stringify(bindings)}, r: ${JSON.stringify(reexports)}, f: ${fn} })\n//# sourceURL=${url.replace(/\s/g, '%20')}`;
}
