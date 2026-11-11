import { generate } from '@javascript-obfuscator/escodegen';
import type { ESTree } from 'meriyah';
import { parse } from '../vendor/meriyah/meriyah.mjs';
import { AcornContext, AcornIterator, result } from './acornUtil';
import { builders as b } from './builders';
import { Config } from './config';
import {
	functionMark,
	holderStatement,
	keepSource,
	keepsSourcesHere,
	sourceKey,
} from './functionSource';
import { helperNames } from './helperNames';
import { provideRewriters } from './rewriters';
import { routeBinary } from './routeURL';
import { scriptLead } from './scriptLead';
import {
	isBareSpecifier,
	routeImport,
	UNDEFINABLE,
	type ScriptType,
} from './scriptRoutes';
import StompURL from './StompURL';
import { parsesInWasm, rewriteInWasm, unrewritten } from './wasm/rewriter';

export {
	ACCESS_KEY,
	BARE_SPECIFIER,
	CLIENT_KEY,
	GLOBAL_NAME,
	GLOBAL_PROXY,
	isBareSpecifier,
	postMessageMethod,
	PROVIDERS,
	rewriteImportMap,
	routeImport,
	routeJS,
	UNDEFINABLE,
	type ScriptType,
} from './scriptRoutes';
export { scriptLead };

// smaller range inside larger range = invalidates larger range
// smaller modifications called later in script

/**
 * Whether a member access short-circuits because an earlier link of its
 * chain is optional (`a?.b.location`): the spine of objects and callees down
 * to the chain's start. A nested ChainExpression is a parenthesised chain,
 * which ends the short-circuit (`(a?.b).location` throws on null).
 */
/** `x.postMessage`, `x['postMessage']` */
const isPostMessage = (member: any) =>
	member?.type === 'MemberExpression' &&
	(member.computed
		? member.property.type === 'Literal' &&
			member.property.value === 'postMessage'
		: member.property.type === 'Identifier' &&
			member.property.name === 'postMessage');

/** whether postMessageCall finds a call that posts, without building its parts */
function postsMessage(node: any): boolean {
	return isPostMessage(node.callee) && node.callee.object.type !== 'Super';
}

/**
 * A call that posts a message, `x.postMessage(...)`: the receiver, the
 * arguments and whether the chain is optional; null for any other call.
 * Every other way to a postMessage is a read of it (`x.postMessage.call(w,
 * m)`, `.bind(x)`, `var pm = x.postMessage`): see postRead.
 */
function postMessageCall(
	node: any,
): { target: any; args: any; optional: boolean } | null {
	const { callee } = node;
	// (`super.postMessage(m)` stays the class's own: `super` is no value to
	// hand the access API, and the postMessage the access API would call may
	// be the one the class overrides. A read of it is left alone too: see
	// routesMember)
	if (isPostMessage(callee) && callee.object.type === 'Super') return null;
	if (isPostMessage(callee))
		return {
			target: callee.object,
			args: argumentsArray(node.arguments),
			optional:
				!!node.optional || !!callee.optional || inOptionalChain(callee.object),
		};
	return null;
}

/** whether the chain goes on past this node (`a?.[k].x`, `a?.[k]()`) */
function continuesChain(ctx: AcornContext): boolean {
	const parent = ctx.parent?.node;
	return (
		(parent?.type === 'MemberExpression' && ctx.parentKey === 'object') ||
		(parent?.type === 'CallExpression' && ctx.parentKey === 'callee')
	);
}

function inOptionalChain(node: any): boolean {
	for (let current = node; current;) {
		if (current.optional) return true;
		if (current.type === 'MemberExpression') current = current.object;
		else if (current.type === 'CallExpression') current = current.callee;
		else return false;
	}
	return false;
}

/**
 * Whether evaluating an expression can do nothing observable: a key or
 * argument like this can be evaluated before the access API decides the
 * chain short-circuited. Anything else (a call, a member read, an await)
 * goes in the lazy form, where the browser's optional call skips it.
 */
function pure(node: any): boolean {
	switch (node?.type) {
		case 'Identifier':
		case 'Literal':
		case 'ThisExpression':
		case 'ArrowFunctionExpression':
		case 'FunctionExpression':
			return true;
		case 'TemplateLiteral':
			return node.expressions.length === 0;
		case 'ArrayExpression':
			return node.elements.every(
				(element: any) => element === null || pure(element),
			);
		case 'ObjectExpression':
			return node.properties.every(
				(property: any) =>
					property.type === 'Property' &&
					(!property.computed || pure(property.key)) &&
					pure(property.value),
			);
	}
	return false;
}

/** `callee?.(...args)`: an optional call, which skips its arguments */
function optionalCall(callee: any, args: any[]) {
	const call: any = b.callExpression(callee, args);
	call.optional = true;
	return call;
}

/**
 * `frames[0]`, `parent['1']`: a literal index read can land on a child window
 * of another proxied site (every one shares the real origin), so it goes
 * through the access API like a computed key. Only a read hands the page a
 * window: a call, a construction or a write through an index stays as it is.
 */
function indexRead(ctx: AcornContext): boolean {
	const key = ctx.node.property.value;
	if (
		typeof key === 'number'
			? !Number.isInteger(key) || key < 0
			: typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)
	)
		return false;
	const parent = ctx.parent?.node;
	return !(
		((parent?.type === 'CallExpression' || parent?.type === 'NewExpression') &&
			ctx.parentKey === 'callee') ||
		(parent?.type === 'TaggedTemplateExpression' && ctx.parentKey === 'tag') ||
		parent?.type === 'UpdateExpression' ||
		(parent?.type === 'AssignmentExpression' && ctx.parentKey === 'left')
	);
}

/**
 * Whether an expression's value is never an object the page was handed (a
 * primitive, or an object the expression itself makes), from its shape alone
 */
function madeHere(node: any): boolean {
	switch (node?.type) {
		case 'Literal':
		case 'TemplateLiteral':
		case 'BinaryExpression':
		case 'UnaryExpression':
		case 'UpdateExpression':
		case 'ArrayExpression':
		case 'ObjectExpression':
		case 'FunctionExpression':
		case 'ArrowFunctionExpression':
		case 'ClassExpression':
			return true;
		case 'ConditionalExpression':
			return madeHere(node.consequent) && madeHere(node.alternate);
		case 'SequenceExpression':
			return madeHere(node.expressions[node.expressions.length - 1]);
	}
	return false;
}

/**
 * `select[0] = option`, `select.options[0] = option`: an index write puts a
 * node into a select through the indexed setter of the element or of its
 * options, which is no function a hook could wrap, so the write goes
 * through the access API like a computed one (set2 lands the node as
 * `select.add` does). Only `=`, and only a value that may be a node: `m[0]
 * = a * b` stays as it is.
 */
function indexWrite(ctx: AcornContext): boolean {
	const key = ctx.node.property.value;
	if (
		typeof key === 'number'
			? !Number.isInteger(key) || key < 0
			: typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)
	)
		return false;
	const parent = ctx.parent?.node;
	return (
		parent?.type === 'AssignmentExpression' &&
		ctx.parentKey === 'left' &&
		parent.operator === '=' &&
		!madeHere(parent.right)
	);
}

/**
 * `x.postMessage` read, not called: `x.postMessage.bind(x)`, `var pm =
 * x.postMessage`, `f(x.postMessage)`. Another window's postMessage is a
 * function of that window's realm, and the browser names the realm of the
 * code that calls it as the message's source; the hook that stands for it
 * cannot tell who called, so the read hands the page a function of its own
 * realm (access API `get`). A call is `post`; a construction, a tag and a
 * write stay as they are.
 */
function postRead(ctx: AcornContext): boolean {
	if (!isPostMessage(ctx.node)) return false;
	const parent = ctx.parent?.node;
	return !(
		((parent?.type === 'CallExpression' || parent?.type === 'NewExpression') &&
			ctx.parentKey === 'callee') ||
		(parent?.type === 'TaggedTemplateExpression' && ctx.parentKey === 'tag') ||
		parent?.type === 'UpdateExpression' ||
		(parent?.type === 'AssignmentExpression' && ctx.parentKey === 'left')
	);
}

/**
 * Whether the rewriter routes a member read through the access API: a
 * computed key that is no literal, an unforgeable's name, an index or
 * `postMessage` (the two read anywhere but as a callee: `callee`)
 */
function routesMember(
	node: any,
	routed: readonly string[],
	callee = false,
): boolean {
	if (node.object.type === 'Super') return false;
	const { property } = node;
	if (!callee && isPostMessage(node)) return true;
	if (node.computed)
		return (
			property.type !== 'Literal' ||
			routed.includes(property.value) ||
			(!callee &&
				(typeof property.value === 'number'
					? Number.isInteger(property.value) && property.value >= 0
					: typeof property.value === 'string' &&
						/^(0|[1-9]\d*)$/.test(property.value)))
		);
	return property.type === 'Identifier' && routed.includes(property.name);
}

/**
 * Whether V8, naming `node` in an error's message (it prints the failing
 * callee or value back from the code: CallPrinter), would print a call of
 * the access API the rewriter puts in its place or in a part it prints
 * (`$s$j.get(...).foo is not a function` for `location.foo()`). Such an
 * operation is done by a helper, which fails with the page's expression.
 */
function printsHelper(node: any, routed: readonly string[]): boolean {
	// asked again for each call of a chain (`a.b().c().d()`): kept on the node
	const known = node?.[PRINTS_HELPER];
	if (known !== undefined) return known;
	const prints = printsHelperOf(node, routed);
	if (node && typeof node === 'object') node[PRINTS_HELPER] = prints;
	return prints;
}
const PRINTS_HELPER = Symbol('printsHelper');

function printsHelperOf(node: any, routed: readonly string[]): boolean {
	switch (node?.type) {
		case 'Identifier':
			return routed.includes(node.name);
		case 'MemberExpression':
			return (
				routesMember(node, routed) ||
				(node.object.type !== 'Super' && printsHelper(node.object, routed))
			);
		case 'CallExpression':
			return (
				postsMessage(node) ||
				(node.callee.type === 'MemberExpression' &&
					routesMember(node.callee, routed, true)) ||
				(!(node.callee.type === 'Identifier' && node.callee.name === 'eval') &&
					printsHelper(node.callee, routed))
			);
		case 'ChainExpression':
			return printsHelper(node.expression, routed);
		case 'TaggedTemplateExpression':
			return printsHelper(node.tag, routed);
		case 'BinaryExpression':
			// `k in o` is the access API's `has` (but for most literal keys)
			if (
				node.operator === 'in' &&
				node.left.type !== 'PrivateIdentifier' &&
				node.left.type !== 'Literal'
			)
				return true;
		// fallthrough
		case 'LogicalExpression':
			return (
				printsHelper(node.left, routed) || printsHelper(node.right, routed)
			);
		case 'UnaryExpression':
			return (
				!(
					(node.operator === 'typeof' || node.operator === 'delete') &&
					node.argument.type === 'Identifier'
				) && printsHelper(node.argument, routed)
			);
		case 'UpdateExpression':
		case 'AssignmentExpression': {
			const target = node.argument ?? node.left;
			return (
				(target.type === 'Identifier' && routed.includes(target.name)) ||
				(target.type === 'MemberExpression' &&
					(routesMember(target, routed) || printsHelper(target, routed)))
			);
		}
		case 'SequenceExpression':
			return node.expressions.some((child: any) => printsHelper(child, routed));
		case 'ArrayExpression':
			return node.elements.some((child: any) => printsHelper(child, routed));
		case 'SpreadElement':
			return printsHelper(node.argument, routed);
		case 'TemplateLiteral':
			return node.expressions.some((child: any) => printsHelper(child, routed));
	}
	return false;
}

/** marks an array of call arguments the rewriter made (`call2(o, k, [...a])`) */
const ARGUMENTS = Symbol('arguments');
const argumentsArray = (args: any[]) => {
	const array: any = b.arrayExpression(args);
	array[ARGUMENTS] = true;
	return array;
};

/**
 * Whether a node is a target an assignment pattern or a loop head writes
 * (`[x] = a`, `({ a: x = 1, ...x } = o)`, `for (x of a)`, `for ([x] of a)`),
 * as opposed to the whole left of a plain assignment or a binding of a
 * declaration, a parameter or a catch clause.
 */
function assignmentTarget(ctx: AcornContext): boolean {
	for (let current = ctx; current.parent; current = current.parent) {
		const { node } = current.parent;
		const key = current.parentKey;
		switch (node.type) {
			case 'ArrayPattern':
			case 'ObjectPattern':
			case 'RestElement':
				break;
			case 'Property':
				if (
					key !== 'value' ||
					current.parent.parent?.node.type !== 'ObjectPattern'
				)
					return false;
				break;
			case 'AssignmentPattern':
				if (key !== 'left') return false;
				break;
			case 'AssignmentExpression':
				return key === 'left' && current !== ctx;
			case 'ForInStatement':
			case 'ForOfStatement':
				return key === 'left';
			default:
				return false;
		}
	}
	return false;
}

/** `{ location }`, `{ location = v }` print from the key while shorthand */
function unshorthand(ctx: AcornContext) {
	let parent = ctx.parent;
	if (parent?.node.type === 'AssignmentPattern') parent = parent.parent;
	if (parent?.node.type === 'Property') parent.node.shorthand = false;
}

/** an expression the generator prints in parentheses wherever it stands */
const parenthesised = (node: any) => ({
	type: 'SequenceExpression',
	expressions: [node],
	range: node.range,
});

/**
 * Whether a destructuring assignment under `parent` could be printed as an
 * argument without parentheses. V8 refuses one that follows an array or
 * object literal in the same arguments (`f({ a: 1 }, [b] = c)`: "Invalid
 * destructuring assignment target"), so a page writes it in parentheses,
 * which the generator drops, and a call of the access API takes page
 * expressions as arguments that were none. As a statement, in a loop's head
 * or in a sequence it is never an argument.
 */
const unparenthesised = (parent: any, node: any) =>
	(node.left.type === 'ArrayPattern' || node.left.type === 'ObjectPattern') &&
	parent.type !== 'ExpressionStatement' &&
	parent.type !== 'ForStatement' &&
	parent.type !== 'SequenceExpression';

/**
 * Whether the page wrote a node in parentheses, which the parser drops: the
 * printer puts back only those, so a script V8 refuses for their absence
 * (`class A extends B++ {}`, `f({ a: 1 }, [b] = c)`) stays one it refuses
 */
function inParentheses(script: string, node: any): boolean {
	let at = (node.range?.[0] ?? 0) - 1;
	for (;;) {
		while (at >= 0 && /\s/.test(script[at])) at--;
		if (at > 0 && script[at] === '/' && script[at - 1] === '*') {
			const open = script.lastIndexOf('/*', at - 2);
			if (open < 0) return false;
			at = open - 1;
			continue;
		}
		return script[at] === '(';
	}
}

/** what `extends` takes without parentheses */
const HERITAGE = new Set([
	'Identifier',
	'MemberExpression',
	'CallExpression',
	'NewExpression',
	'ThisExpression',
	'Literal',
	'TemplateLiteral',
	'TaggedTemplateExpression',
	'ArrayExpression',
	'ObjectExpression',
	'FunctionExpression',
	'ClassExpression',
	'MetaProperty',
	'ChainExpression',
]);

/**
 * Whether an expression's text begins with a function or a class
 * expression that is part of something larger (a call of it, a member of
 * it): after `export default` that text is a declaration
 */
function startsDeclaration(node: any): boolean {
	for (let current = node, first = true; current; first = false)
		switch (current.type) {
			case 'FunctionExpression':
			case 'ClassExpression':
				return !first;
			case 'CallExpression':
				current = current.callee;
				break;
			case 'MemberExpression':
				current = current.object;
				break;
			case 'TaggedTemplateExpression':
				current = current.tag;
				break;
			case 'ChainExpression':
				current = current.expression;
				break;
			case 'BinaryExpression':
			case 'LogicalExpression':
			case 'AssignmentExpression':
				current = current.left;
				break;
			case 'ConditionalExpression':
				current = current.test;
				break;
			case 'SequenceExpression':
				current = current.expressions[0];
				break;
			case 'UpdateExpression':
				if (current.prefix) return false;
				current = current.argument;
				break;
			default:
				return false;
		}
	return false;
}

/** inside a function or a class static block: a `var` there is local */
function inFunction(ctx: AcornContext): boolean {
	for (let current = ctx.parent; current; current = current.parent)
		if (
			current.node.type === 'FunctionDeclaration' ||
			current.node.type === 'FunctionExpression' ||
			current.node.type === 'ArrowFunctionExpression' ||
			current.node.type === 'StaticBlock'
		)
			return true;
	return false;
}

const THIS = () => ({ type: 'ThisExpression' });
const cTarget = 't$t';
const cProp = 't$p';
const cValue = 't$v';

// A minified script is written back minified: indented and broken into
// lines it came back up to twice its size, which cost the worker and the
// page the time to write and read it, while its stack positions were on
// line 1 natively anyway. Code written to be read keeps one statement per
// line, so an error's line number still points near the page's own.
const COMPACT = { format: { compact: true } };
/** whether a script is printed compact: minified code comes back minified */
export const minified = (script: string) => {
	let lines = 1;
	for (
		let at = script.indexOf('\n');
		at !== -1;
		at = script.indexOf('\n', at + 1)
	)
		lines++;
	return script.length / lines > 200;
};

function generatePartial(script: string, ctx: AcornContext) {
	let result = ctx.node.range
		? script.slice(ctx.node.range[0], ctx.node.range[1])
		: generate(ctx.node, COMPACT);

	if (
		ctx.node.type.includes('Expression') &&
		ctx.parent?.node.type.includes('Expression')
	) {
		result = `(${result})`;
	}

	return result;
}

/** the `type` a static import's `with { ... }` names, if any */
function attributeType(node: { attributes?: unknown }): unknown {
	const attributes = Array.isArray(node.attributes) ? node.attributes : [];
	for (const attribute of attributes as {
		key?: { name?: string; value?: unknown };
		value?: { value?: unknown };
	}[]) {
		const key = attribute.key?.name ?? attribute.key?.value;
		if (key === 'type') return attribute.value?.value;
	}
	return undefined;
}

export function modifyJS(
	script: string,
	url: StompURL,
	config: Config,
	type: ScriptType = 'generic',
	/** code the caller needs to run first (an inline script's currentScript restore): placed after the directive prologue */
	preamble = '',
	/**
	 * print compact (true) or readable (false) whatever the script looks like:
	 * a part of a larger script (splitRewrite) is printed as the whole would be
	 */
	compact?: boolean,
	/** where the text its functions read back as is kept (a part of a split script, a javascript: URL) */
	source?: ScriptSource,
	/** told which backend rewrote the script, where the wasm one was asked (the request log's `rewriteBy`) */
	told?: RewrittenBy,
) {
	// the wasm backend answers where this thread holds the module; what it
	// declines (a script its parser refuses, a shape it leaves alone) is
	// rewritten here. A part of a split script is this rewriter's: its
	// output is stitched into the whole by what the printer makes of it
	if (config.rewriter === 'wasm' && compact === undefined) {
		const output = rewriteInWasm(
			script,
			url,
			config,
			type,
			() => scriptLead(url, config, type, preamble),
			source,
		);
		if (told) told.by = output === null ? 'js' : 'wasm';
		if (output !== null) return output;
	}
	const names = helperNames(config);
	// the names a read of must go through the access API: the unforgeables,
	// and the client's global, which holds the real windows (the access API
	// answers nothing for it, so a page that learned the name cannot read it)
	const routed = [...UNDEFINABLE, names.client];
	const helperKeys = [
		names.access,
		names.client,
		names.globalProxy,
		names.globalName,
	];
	/** `$s$j.name(...args)` */
	const access = (name: string, args: any[]) =>
		b.callExpression(
			b.memberExpression(b.identifier(names.access), b.identifier(name)),
			args,
		);
	/** the page's text of an expression, for a helper to name it in an error */
	const sourceOf = (node: any): string =>
		node.range
			? script.slice(node.range[0], node.range[1])
			: generate(node, COMPACT);
	/**
	 * A call's or construction's text for a helper's error: what it calls,
	 * as written, and its arguments as placeholders (only where a spread
	 * stands matters to the message), so a function written in the
	 * arguments is not written into the output twice
	 */
	const callText = (node: any): string => {
		const { callee } = node;
		const plain =
			node.type === 'CallExpression' &&
			(callee.type === 'MemberExpression' ||
				callee.type === 'Identifier' ||
				callee.type === 'CallExpression' ||
				callee.type === 'ChainExpression' ||
				callee.type === 'ThisExpression');
		const head = plain ? sourceOf(callee) : `(${sourceOf(callee)})`;
		const args = node.arguments
			.map((argument: any) =>
				argument.type === 'SpreadElement' ? '...0' : '0',
			)
			.join(', ');
		return `${node.type === 'NewExpression' ? 'new ' : ''}${head}${node.optional ? '?.' : ''}(${args})`;
	};
	/**
	 * The text of a destructuring (`{ a } = o`), for the error its source
	 * throws when null or undefined (a destructured parameter's is the
	 * declaration hoistParamPatterns made, from the parameter it named)
	 */
	const destructured = (ctx: AcornContext) =>
		b.literal(generatePartial(script, ctx));
	/** a pattern whose source is a helper's value (`const [a] = location`) */
	const checksSource = (pattern: any, source: any) =>
		(pattern.type === 'ObjectPattern' || pattern.type === 'ArrayPattern') &&
		printsHelper(source, routed);
	/**
	 * That source, checked by the access API before the pattern reads it
	 * (`shape`: a declaration's array pattern, 'array', or an assignment's,
	 * 'assign')
	 */
	const sourceCheck = (pattern: any, source: any, text: any, shape: string) =>
		pattern.type === 'ArrayPattern'
			? access('iter', [
					result(source),
					b.literal(shape),
					b.literal(sourceOf(source)),
				])
			: access('coerce', [result(source), text]);
	try {
		const isModule = type === 'genericModule' || type === 'workerModule';

		// comments are dropped with the rest of the formatting, except the two
		// DevTools reads: `//# sourceURL=` names the script (eval'd code, stack
		// frames), `//# sourceMappingURL=` points at its map, which resolves
		// against the routed script URL, so it is routed too (a data: map is
		// kept as it is)
		const comments: ESTree.Comment[] = [];
		const tree = parse(script, {
			module: isModule,
			next: true,
			ranges: true,
			globalReturn: true,
			webcompat: true,
			onComment: comments,
		});
		// the directive prologue (`'use strict'`) must stay the first thing the
		// engine sees: anything before it (the worker bootstrap, a caller's
		// preamble) would make it a plain expression and lose strict mode. A
		// module is strict regardless, so its body is left as it is.
		let prologue = '';
		if (!isModule) {
			const body = tree.body as any[];
			let count = 0;
			// (a directive is a statement that is a string token and nothing
			// else, which the parser marks: `('use strict');` is an expression,
			// and printed without its parentheses it would turn a sloppy
			// script strict. One written with an escape is printed as written:
			// `'use\x20strict'` is no "use strict", and its value is)
			while (
				count < body.length &&
				body[count].type === 'ExpressionStatement' &&
				typeof body[count].directive === 'string'
			)
				count++;
			prologue = body
				.splice(0, count)
				.map(({ directive, expression }) =>
					directive === expression.value
						? `${JSON.stringify(expression.value)};`
						: `${script.slice(expression.range[0], expression.range[1])};`,
				)
				.join('');
		}
		const trailer = comments
			.map((comment) =>
				/^[#@]\s*(sourceURL|sourceMappingURL)=(\S+)/.exec(comment.value.trim()),
			)
			.filter((match): match is RegExpExecArray => match !== null)
			.map(([, name, value]) => {
				if (name === 'sourceMappingURL' && !/^data:/i.test(value))
					try {
						value = routeBinary(
							new StompURL(new URL(value, url.toString()), url),
						);
					} catch (error) {
						// not a URL: left as written
					}
				return `\n//# ${name}=${value}`;
			})
			.join('');

		// destructured parameters become plain ones with the pattern moved into
		// the body, where the main pass wraps its source like any declaration
		// (the functions of the page's, children first, for their marks)
		const functions: any[] = [];
		prepareTree(tree, names.access, routed, functions, script);

		for (const ctx of new AcornIterator(tree)) {
			typeLoop: switch (ctx.node.type) {
				case 'DebuggerStatement':
					// a proxied site's anti-debugging trap, not the user's breakpoint
					ctx.replaceWith(b.emptyStatement());
					break;
				case 'BinaryExpression':
					// `key in o`: the helpers live on the window, where natively
					// nothing has their names, so the access API answers an `in`
					// whose key is one or may be one (any key but a literal)
					if (
						ctx.node.operator === 'in' &&
						ctx.node.left.type !== 'PrivateIdentifier' &&
						(ctx.node.left.type !== 'Literal' ||
							helperKeys.includes(ctx.node.left.value))
					)
						ctx.replaceWith(
							b.callExpression(
								b.memberExpression(
									b.identifier(names.access),
									b.identifier('has'),
								),
								[result(ctx.node.left), result(ctx.node.right)],
							),
						);
					break;
				case 'ImportExpression': {
					// todo: add tompc$.import(meta, url)
					const base = isModule
						? b.memberExpression(
								b.metaProperty(b.identifier('import'), b.identifier('meta')),
								b.identifier('url'),
							)
						: // a classic script resolves against its own URL, which
							// only the rewriter knows
							b.literal(url.toString());
					const options = (ctx.node as { options?: any }).options;
					if (!options) {
						ctx.replaceWith(
							b.callExpression(
								b.memberExpression(
									b.identifier(names.access),
									b.identifier('import'),
								),
								[base, result(ctx.node.source)],
							),
						);
						break;
					}
					// `import(url, { with: { type: 'json' } })`: the options pick the
					// route and the browser checks them, so the import stays the
					// page's own, given the routed URL: the specifier first, then
					// the options, as natively. (Written as a call of `import`: the
					// generator would drop an import expression's options)
					ctx.replaceWith(
						b.callExpression(
							b.arrowFunctionExpression(
								[b.identifier('s'), b.identifier('o')],
								// its rejection names the route: `imported` hands it back
								// naming the page's URL
								b.callExpression(
									b.memberExpression(
										b.identifier(names.access),
										b.identifier('imported'),
									),
									[
										b.callExpression(b.identifier('import'), [
											b.callExpression(
												b.memberExpression(
													b.identifier(names.access),
													b.identifier('importRoute'),
												),
												[base, b.identifier('s'), b.identifier('o')],
											),
											b.identifier('o'),
										]),
									],
								),
							),
							// (both are the page's expressions, rewritten like any)
							[result(ctx.node.source), result(options)],
						),
					);
					break;
				}
				case 'VariableDeclarator':
					// `const { top: t } = o`, `const { a: { top } } = o`: the pattern
					// reads `o.top` without a member expression to rewrite, so the
					// source is wrapped and the reads resolve through it, at every
					// depth the pattern names an unforgeable
					// (and a pattern whose source is a helper's value checks it
					// first, so an error names the page's expression)
					{
						const { id, init } = ctx.node;
						if (!init || isPatternCall(init, names.access)) break;
						const source = destructured(ctx);
						const spec = patternSpec(id, routed);
						// (the pattern is visited too: its computed keys and its
						// defaults are the page's expressions)
						if (spec)
							ctx.replaceWith(
								b.variableDeclarator(
									result(id),
									iterates(spec)
										? patternCall(
												sourceCheck(id, init, source, 'array'),
												spec,
												names.access,
											)
										: patternCall(result(init), spec, names.access, source),
								),
							);
						else if (checksSource(id, init))
							ctx.replaceWith(
								b.variableDeclarator(
									result(id),
									sourceCheck(id, init, source, 'array'),
								),
							);
					}
					break;
				case 'AssignmentExpression':
					{
						const { left, right } = ctx.node;
						const spec = patternSpec(left, routed);
						if (spec)
							ctx.replaceWith(
								b.assignmentExpression(
									'=',
									// visited too: a location target and the defaults
									// (`({ location = top } = o)`) are rewritten there
									result(left),
									iterates(spec)
										? patternCall(
												sourceCheck(left, right, destructured(ctx), 'assign'),
												spec,
												names.access,
											)
										: patternCall(
												result(right),
												spec,
												names.access,
												destructured(ctx),
											),
								),
							);
						else if (ctx.node.operator === '=' && checksSource(left, right))
							ctx.replaceWith(
								b.assignmentExpression(
									'=',
									result(left),
									sourceCheck(left, right, destructured(ctx), 'assign'),
								),
							);
					}
					break;
				case 'ImportDeclaration':
				case 'ExportAllDeclaration':
				case 'ExportNamedDeclaration':
					// a bare specifier (`import x from "react"`) is the import
					// map's to resolve: leave it, or `new URL` throws and the whole
					// module is lost. A module worker's static imports run before
					// its own body, which loads the client: each is a worker module
					// too, so whichever runs first loads it, and none runs unhooked
					if (ctx.node.source && !isBareSpecifier(ctx.node.source.value))
						ctx.node.source = b.literal(
							routeImport(
								new StompURL(
									new URL(ctx.node.source.value, url.toString()),
									url,
								),
								url,
								config,
								type === 'workerModule' ? 'workerModule' : 'genericModule',
								attributeType(ctx.node as { attributes?: unknown }),
							),
						);
					break;
				case 'VariableDeclaration':
					{
						// `var location = v` and `var { location } = o` in a classic
						// script outside any function (in a block, an `if`, a loop
						// head too) assign the window's location (the var declares
						// nothing new there): bound to a temporary and assigned, so
						// the assignment routes like `location = v`
						if (isModule || ctx.node.kind !== 'var' || inFunction(ctx)) break;
						// `for (var location of a)`: no initialiser, each value is
						// assigned at the top of the body
						const loop =
							(ctx.parent?.node.type === 'ForInStatement' ||
								ctx.parent?.node.type === 'ForOfStatement') &&
							ctx.parentKey === 'left'
								? ctx.parent
								: null;
						const assignments: any[] = [];
						const temp = () =>
							b.identifier(`${names.access}l${assignments.length}`);
						const rebind = (node: any): any => {
							if (node?.type === 'Identifier' && node.name === 'location') {
								const id = temp();
								// the identifier is marked a result so the Identifier case
								// turns this assignment into the routed set like any other
								assignments.push(
									b.expressionStatement(
										b.assignmentExpression(
											'=',
											result(b.identifier('location')),
											b.identifier(id.name),
										),
									),
								);
								return id;
							}
							if (node?.type === 'ObjectPattern')
								for (const property of node.properties)
									if (property.type === 'Property') {
										const before = assignments.length;
										const value = rebind(property.value);
										// `{ location = v }` rebinds inside the default
										if (assignments.length !== before)
											property.shorthand = false;
										property.value = value;
									} else rebind(property);
							if (node?.type === 'ArrayPattern')
								node.elements = node.elements.map((element: any) =>
									element ? rebind(element) : element,
								);
							if (node?.type === 'AssignmentPattern')
								node.left = rebind(node.left);
							// `var [...location] = a`, `var {...location} = o`
							if (node?.type === 'RestElement')
								node.argument = rebind(node.argument);
							return node;
						};
						for (const declarator of ctx.node.declarations)
							if (declarator.init || loop)
								declarator.id = rebind(declarator.id);
						if (!assignments.length) break;
						// the declaration is visited again (its initialisers, the
						// pattern's source, are rewritten like any expression)
						if (loop) {
							const { node } = loop;
							node.left = result(node.left);
							node.right = result(node.right);
							node.body = b.blockStatement([...assignments, result(node.body)]);
							loop.replaceWith(node);
						} else if (ctx.parent?.node.type === 'ForStatement') {
							// `for (var location = v; ...)` takes a declaration list,
							// so the assignments are one more declarator
							const id = temp();
							ctx.node.declarations.forEach(result);
							ctx.node.declarations.push(
								b.variableDeclarator(
									id,
									b.sequenceExpression(
										assignments.map((statement) => statement.expression),
									),
								),
							);
							ctx.replaceWith(ctx.node);
						} else
							ctx.replaceWith(
								b.blockStatement([result(ctx.node), ...assignments]),
							);
					}
					break;
				case 'WithStatement':
					// `with (parent) { postMessage(m) }`: the name resolves on the
					// window in the head, and the call posts to it from this realm.
					// No member is written that a read could be routed through, so
					// a scope goes inside the head's that answers that one name
					// (access API `scope`: nothing when the head is no window of
					// another realm). Only for a body that says the name. The two
					// come from one call made before the head is entered, where
					// the helper's name is still this realm's.
					if (refersTo(ctx.node.body, 'postMessage')) {
						const scopes = b.identifier(`${names.access}w`);
						const part = (index: number) =>
							b.memberExpression(scopes, b.literal(index), true);
						ctx.replaceWith(
							b.blockStatement([
								b.variableDeclaration('const', [
									b.variableDeclarator(
										scopes,
										access('scope', [result(ctx.node.object)]),
									),
								]),
								{
									type: 'WithStatement',
									object: part(0),
									body: {
										type: 'WithStatement',
										object: part(1),
										body: result(ctx.node.body),
									},
								},
							]),
						);
					}
					break;
				case 'CallExpression':
					{
						const { callee } = ctx.node;

						// a message posted to a window goes out from the caller's
						// realm (access API `post`), or the receiver's wrapper would
						// be the incumbent the browser names as the source
						const post = postMessageCall(ctx.node);
						// `w?.postMessage(f())`: nothing is posted, nor f called, when
						// w is nullish
						if (
							post?.optional &&
							!ctx.node.arguments.every((argument: any) => pure(argument))
						) {
							ctx.replaceWith(
								optionalCall(
									b.callExpression(
										b.memberExpression(
											b.identifier(names.access),
											b.identifier('poster'),
										),
										[result(post.target), b.literal(callText(ctx.node))],
									),
									ctx.node.arguments.map((argument: any) => result(argument)),
								),
							);
							break typeLoop;
						}
						// (the call's text names it in the error a postMessage that is
						// no function throws)
						if (post) {
							ctx.replaceWith(
								b.callExpression(
									b.memberExpression(
										b.identifier(names.access),
										b.identifier('post'),
									),
									[
										result(post.target),
										result(post.args),
										b.literal(post.optional),
										b.literal(callText(ctx.node)),
									],
								),
							);
							break typeLoop;
						}

						if (
							callee.type === 'Identifier' &&
							callee.name === 'eval' &&
							ctx.node.arguments.length
						) {
							/* May be a JS eval function!
							eval will only inherit the scope if the following is met:
							the keyword (not property or function) eval is called
							the keyword doesnt reference a variable named eval
							*/

							// transform eval(...) into eval(...tompc$.eval.eval_scope(eval, ...['code',{note:"eval is possibly a var"}]))
							ctx.replaceWith(
								b.conditionalExpression(
									b.callExpression(
										b.memberExpression(
											b.identifier(names.access),
											b.identifier('isEval'),
										),
										[b.identifier('eval')],
									),
									b.callExpression(b.identifier('eval'), [
										b.callExpression(
											b.memberExpression(
												b.identifier(names.access),
												b.identifier('evalScope'),
											),
											ctx.node.arguments.map((arg: unknown) => result(arg)),
										),
									]),
									// the arguments stand a second time, as copies: a node
									// the walk meets twice is rewritten once at most, and
									// one its own replacement reuses (`top`) not at all,
									// which left `eval(top.x)` reading the real top here
									b.callExpression(
										b.identifier('eval'),
										ctx.node.arguments.map((arg: unknown) => {
											const copy = copyNode(arg);
											prepareTree(
												copy,
												names.access,
												routed,
												functions,
												script,
											);
											return result(copy);
										}),
									),
								),
							);
							break typeLoop;
						}

						// a call V8 would name with a helper's call in its message
						// when it fails (`location.foo()`, `o[k].x()`, `top()`): the
						// call is the access API's, which fails naming the page's
						// expression. A member call reads its method before its
						// arguments: when they can do something, in the lazy form
						const args = ctx.node.arguments;
						const partial = () => b.literal(callText(ctx.node));
						if (
							callee.type === 'MemberExpression' &&
							callee.object.type !== 'Super' &&
							callee.property.type !== 'PrivateIdentifier' &&
							!routesMember(callee, routed, true) &&
							printsHelper(callee.object, routed)
						) {
							const chained =
								!!callee.optional || inOptionalChain(callee.object);
							const key = callee.computed
								? result(callee.property)
								: b.literal(callee.property.name);
							const object = callee.object;
							if (
								!chained &&
								!ctx.node.optional &&
								args.every((argument: any) => pure(argument))
							)
								ctx.replaceWith(
									// `o[k].m(a)`: the read and the call in one helper
									object.type === 'MemberExpression' &&
										routesMember(object, routed)
										? access('call3', [
												result(object.object),
												object.computed
													? result(object.property)
													: b.literal(object.property.name),
												key,
												result(argumentsArray(args)),
												partial(),
											])
										: access('call2', [
												result(object),
												key,
												result(argumentsArray(args)),
												partial(),
											]),
								);
							else {
								const lazy = optionalCall(
									optionalCall(
										access('method', [
											result(callee.object),
											b.literal(chained),
											b.literal(!!ctx.node.optional),
											partial(),
										]),
										[key],
									),
									args.map((argument: any) => result(argument)),
								);
								// a call that was in no optional chain may have what a chain
								// cannot: a member of it assigned (`o[k].m(f()).x = 1`), a
								// tag, a `new`. The lazy form is then a chain of its own,
								// which the generator puts in parentheses
								const alone =
									!chained &&
									!ctx.node.optional &&
									(continuesChain(ctx) ||
										ctx.parent?.node.type === 'TaggedTemplateExpression' ||
										ctx.parent?.node.type === 'NewExpression');
								ctx.replaceWith(
									alone ? { type: 'ChainExpression', expression: lazy } : lazy,
								);
							}
							break typeLoop;
						}
						if (
							callee.type !== 'MemberExpression' &&
							!ctx.node.optional &&
							printsHelper(callee, routed)
						)
							ctx.replaceWith(
								access('fcall', [
									result(callee),
									result(argumentsArray(args)),
									partial(),
								]),
							);
					}
					break;
				case 'NewExpression': {
					// `new location.x()`, `new top()`: as a call above (a member's
					// constructor is read before the arguments: only plain ones)
					const { callee } = ctx.node;
					const args = ctx.node.arguments;
					if (
						callee.type === 'MemberExpression' &&
						callee.object.type !== 'Super' &&
						callee.property.type !== 'PrivateIdentifier' &&
						!routesMember(callee, routed, true) &&
						printsHelper(callee.object, routed) &&
						args.every((argument: any) => pure(argument))
					)
						ctx.replaceWith(
							access('new2', [
								result(callee.object),
								callee.computed
									? result(callee.property)
									: b.literal(callee.property.name),
								result(argumentsArray(args)),
								b.literal(callText(ctx.node)),
							]),
						);
					else if (
						callee.type !== 'MemberExpression' &&
						printsHelper(callee, routed)
					)
						ctx.replaceWith(
							access('fnew', [
								result(callee),
								result(argumentsArray(args)),
								b.literal(callText(ctx.node)),
							]),
						);
					break;
				}
				case 'SpreadElement':
					// `[...location]`, `f(...o[k])`: iterated by the access API
					// first, which fails as the page's expression would
					if (
						printsHelper(ctx.node.argument, routed) &&
						(ctx.parent?.node.type === 'ArrayExpression' ||
							ctx.parent?.node.type === 'CallExpression' ||
							ctx.parent?.node.type === 'NewExpression')
					)
						ctx.replaceWith({
							type: 'SpreadElement',
							argument: access('iter', [
								result(ctx.node.argument),
								b.literal(
									ctx.parent.node.type !== 'ArrayExpression' ||
										ctx.parent.node[ARGUMENTS]
										? 'args'
										: 'spread',
								),
								b.literal(sourceOf(ctx.node.argument)),
							]),
						});
					break;
				case 'ForOfStatement':
					if (!ctx.node.await && printsHelper(ctx.node.right, routed))
						ctx.replaceWith({
							...ctx.node,
							left: result(ctx.node.left),
							right: access('iter', [
								result(ctx.node.right),
								b.literal('of'),
								b.literal(sourceOf(ctx.node.right)),
							]),
							body: result(ctx.node.body),
						});
					break;
				case 'Identifier':
					{
						// `[location] = a`, `({ location } = o)`, `for (location of
						// a)`: a reference no set1 call can stand for, so it becomes
						// the member `$s$j.ref1(location, setter).value`, whose write
						// routes like `location = v` (bindings are left below)
						// (so does `eval`, whose write the access API stores as the eval
						// itself: `[eval] = [saved]` stored the stand-in a read answers,
						// and every `eval(code)` after it was no direct eval)
						if (
							(ctx.node.name === 'location' || ctx.node.name === 'eval') &&
							assignmentTarget(ctx)
						) {
							const { name, range } = ctx.node;
							// (as the page wrote it: respell)
							const written = () =>
								Object.assign(b.identifier(name), { range });
							unshorthand(ctx);
							ctx.replaceWith(
								b.memberExpression(
									b.callExpression(
										b.memberExpression(
											b.identifier(names.access),
											b.identifier('ref1'),
										),
										[
											written(),
											b.arrowFunctionExpression(
												[b.identifier(cValue)],
												b.assignmentExpression(
													'=',
													written(),
													b.identifier(cValue),
												),
											),
											...(name === 'eval' ? [b.literal('eval')] : []),
										],
									),
									b.identifier('value'),
								),
							);
							break;
						}
						// binding positions and names: rewriting these turns a valid
						// script into a SyntaxError (`class A { top = 1 }`,
						// `catch (location)`, `break top`) or changes its meaning
						// (`typeof top` must not throw in a worker; `delete top` is
						// strict code's early error, and eval code is strict by a
						// caller no rewrite sees, so the name stays for V8 to refuse)
						// (a computed key is an expression like any other, in a
						// literal, a class, a pattern or a member the rewriter
						// leaves as it is: `{ [location]: 1 }`, `delete o[location]`
						// named the key with the real location's URL. So is what a
						// class extends)
						switch (ctx.parent?.node.type) {
							case 'ArrayPattern':
							case 'ObjectPattern':
							case 'LabeledStatement':
							case 'BreakStatement':
							case 'ContinueStatement':
							case 'CatchClause':
							case 'RestElement':
							case 'ExportSpecifier':
							case 'ImportSpecifier':
							case 'ImportDefaultSpecifier':
							case 'ImportNamespaceSpecifier':
								break typeLoop;
							case 'ClassDeclaration':
							case 'ClassExpression':
								if (ctx.parentKey === 'id') break typeLoop;
								break;
							case 'MethodDefinition':
							case 'PropertyDefinition':
								if (ctx.parentKey === 'key' && !ctx.parent.node.computed)
									break typeLoop;
								break;
							case 'UnaryExpression':
								if (
									ctx.parent.node.operator === 'typeof' ||
									ctx.parent.node.operator === 'delete'
								)
									break typeLoop;
								break;
							case 'ForInStatement':
							case 'ForOfStatement':
								// an assignment target, not an expression
								if (ctx.parentKey === 'left') break typeLoop;
								break;
							case 'MemberExpression':
								if (ctx.parentKey === 'property' && !ctx.parent.node.computed)
									break typeLoop;
								break;
							case 'VariableDeclarator':
								if (ctx.parentKey === 'id') break typeLoop;
								break;
							case 'Property':
								if (ctx.parentKey === 'key') {
									if (!ctx.parent.node.computed) break typeLoop;
									break;
								}
								// `const { g: location } = o` binds; `{ location }` in an
								// object literal reads (handled below)
								if (ctx.parent.parent?.node.type === 'ObjectPattern')
									break typeLoop;
								break;
							case 'FunctionDeclaration':
							case 'FunctionExpression':
								if (ctx.parentKey === 'id') break typeLoop;
							// fallthrough
							case 'ArrowFunctionExpression':
								if (ctx.parentKey === 'params') break typeLoop;
								break;
							case 'AssignmentPattern':
								if (ctx.parentKey === 'left') break typeLoop;
								break;
						}
						if (!routed.includes(ctx.node.name)) break;

						if (
							ctx.parent?.node.type === 'UpdateExpression' ||
							(ctx.parent?.node.type === 'AssignmentExpression' &&
								ctx.parentKey === 'left')
						) {
							ctx.parent.replaceWith(
								b.callExpression(
									b.memberExpression(
										b.identifier(names.access),
										b.identifier('set1'),
									),
									[
										ctx.node,
										b.literal(ctx.node.name),
										// return what the intended value is
										b.arrowFunctionExpression(
											[
												b.identifier(cTarget),
												b.identifier(cProp),
												b.identifier(cValue),
											],
											ctx.parent.node!.type === 'UpdateExpression'
												? b.updateExpression(
														ctx.parent.node.operator,
														b.memberExpression(
															b.identifier(cTarget),
															b.identifier(cProp),
															true,
														),
														ctx.parent.node.prefix,
													)
												: b.assignmentExpression(
														ctx.parent.node.operator,
														b.memberExpression(
															b.identifier(cTarget),
															b.identifier(cProp),
															true,
														),
														b.identifier(cValue),
													),
										),
										// set
										b.arrowFunctionExpression(
											[b.identifier(cValue)],
											b.assignmentExpression(
												'=',
												ctx.node,
												b.identifier(cValue),
											),
										),
										// the value is the page's expression, rewritten like
										// any (`location = top`, `location = f(() => top)`)
										ctx.parent!.node.type === 'UpdateExpression'
											? b.identifier('undefined')
											: result(ctx.parent.node.right),
										b.literal(generatePartial(script, ctx.parent)),
									],
								),
							);
						} else {
							// `{ location }` prints from the key when shorthand, which
							// would silently drop the rewrite of the value
							if (
								ctx.parent?.node.type === 'Property' &&
								ctx.parentKey === 'value'
							)
								ctx.parent.node.shorthand = false;

							ctx.replaceWith(
								b.callExpression(
									b.memberExpression(
										b.identifier(names.access),
										b.identifier('get'),
									),
									[ctx.node, b.literal(ctx.node.name)],
								),
							);
						}
					}
					break;
				case 'MemberExpression':
					{
						// `super.top` reads the home object's prototype with `this` as
						// the receiver: the window's own getter when both are the
						// window (`{ __proto__: window, f() { return super.top } }`
						// called on the window), and `super.eval(code)` is the real
						// eval. `super` is no value a helper could take, so the member
						// stays where it is and the helper is handed what it read, or
						// arrows that read and write it (an arrow keeps `super` and
						// `this`). Only for a name the access API answers for, or a
						// key that may be one
						if (ctx.node.object.type === 'Super') {
							const { property, computed } = ctx.node;
							const name = !computed
								? property.name
								: property.type === 'Literal'
									? String(property.value)
									: null;
							if (name !== null && !routed.includes(name)) break typeLoop;
							const parent = ctx.parent?.node;
							// (a tag keeps its `this`; `delete super.x` throws)
							if (
								(parent?.type === 'TaggedTemplateExpression' &&
									ctx.parentKey === 'tag') ||
								(parent?.type === 'UnaryExpression' &&
									parent.operator === 'delete')
							)
								break typeLoop;
							const member = (key: any) =>
								b.memberExpression(ctx.node.object, key, true);
							const key =
								name !== null
									? b.literal(name)
									: access('key', [result(property)]);
							// `t$p => super[t$p]` and `(t$p, t$v) => super[t$p] = t$v`
							const reads = () =>
								b.arrowFunctionExpression(
									[b.identifier(cProp)],
									member(b.identifier(cProp)),
								);
							const writes = () =>
								b.arrowFunctionExpression(
									[b.identifier(cProp), b.identifier(cValue)],
									b.assignmentExpression(
										'=',
										member(b.identifier(cProp)),
										b.identifier(cValue),
									),
								);
							// the value: `$s$j.get(super.top, 'top')`, or for a key
							// known only when it runs
							// `(t$p => $s$j.get(super[t$p], t$p))($s$j.key(k))`
							const read = () =>
								name !== null
									? access('get', [ctx.node, b.literal(name)])
									: b.callExpression(
											b.arrowFunctionExpression(
												[b.identifier(cProp)],
												access('get', [
													member(b.identifier(cProp)),
													b.identifier(cProp),
												]),
											),
											[key],
										);
							if (assignmentTarget(ctx)) {
								// `[super.location] = a`, `for (super[k] of a)`
								unshorthand(ctx);
								ctx.replaceWith(
									b.memberExpression(
										access('sref', [key, THIS(), reads(), writes()]),
										b.identifier('value'),
									),
								);
							} else if (
								parent?.type === 'UpdateExpression' ||
								(parent?.type === 'AssignmentExpression' &&
									ctx.parentKey === 'left')
							) {
								const target = b.memberExpression(
									b.identifier(cTarget),
									b.identifier(cProp),
									true,
								);
								ctx.parent!.replaceWith(
									access('sset', [
										key,
										THIS(),
										reads(),
										writes(),
										b.arrowFunctionExpression(
											[
												b.identifier(cTarget),
												b.identifier(cProp),
												b.identifier(cValue),
											],
											parent.type === 'UpdateExpression'
												? b.updateExpression(
														parent.operator,
														target,
														parent.prefix,
													)
												: b.assignmentExpression(
														parent.operator,
														target,
														b.identifier(cValue),
													),
										),
										parent.type === 'UpdateExpression'
											? b.identifier('undefined')
											: result(parent.right),
									]),
								);
							} else if (
								parent?.type === 'CallExpression' &&
								ctx.parentKey === 'callee'
							) {
								// `super.eval(code)`, `super[k](...)`: what was read,
								// called with the method's `this`
								const method = access('smethod', [
									read(),
									THIS(),
									b.literal(callText(parent)),
									...(parent.optional ? [b.literal(true)] : []),
								]);
								const args = parent.arguments.map((argument: any) =>
									result(argument),
								);
								ctx.parent!.replaceWith(
									parent.optional
										? optionalCall(method, args)
										: b.callExpression(method, args),
								);
							} else ctx.replaceWith(read());
							break typeLoop;
						}
						// `[top.location] = a`, `for (frames[0].location of a)`: a
						// pattern or loop head target is a reference, never a get2
						// call; a location there becomes `$s$j.ref2(o, k).value`,
						// whose write routes like set2, anything else stays as is
						// (so does `eval`, which a write stores as the eval itself,
						// and a key known only when it runs, which may be either:
						// `[window[k]] = [url]` navigated as the page wrote it)
						if (assignmentTarget(ctx)) {
							const { property } = ctx.node;
							const computed = ctx.node.computed && property.type !== 'Literal';
							const key = ctx.node.computed
								? property.type === 'Literal' && property.value
								: property.name;
							if (computed || key === 'location' || key === 'eval') {
								unshorthand(ctx);
								ctx.replaceWith(
									b.memberExpression(
										b.callExpression(
											b.memberExpression(
												b.identifier(names.access),
												b.identifier('ref2'),
											),
											[
												result(ctx.node.object),
												computed ? result(property) : b.literal(key),
											],
										),
										b.identifier('value'),
									),
								);
							}
							break typeLoop;
						}
						switch (ctx.parent?.node.type) {
							case 'ArrayPattern':
							case 'ObjectPattern':
								break typeLoop;
							case 'UnaryExpression':
								if (ctx.parent?.node.operator === 'delete') break typeLoop;
								break;
						}

						if (ctx.node.computed) {
							if (ctx.node.property.type === 'Literal') {
								if (
									!routed.includes(ctx.node.property.value) &&
									!indexRead(ctx) &&
									!postRead(ctx) &&
									!indexWrite(ctx)
								) {
									break typeLoop;
								}
							}
						} else
							switch (ctx.node.property.type) {
								case 'Identifier':
									if (
										!routed.includes(ctx.node.property.name) &&
										!postRead(ctx)
									) {
										break typeLoop;
									}

									break;
								case 'Literal':
									if (!routed.includes(ctx.node.property.value)) {
										break typeLoop;
									}

									break;
							}

						// if not computed (object.property), make property a string
						// computed is object[property]

						let propertyArgument;
						// this link, or an earlier one of the same chain, is optional
						const chained =
							ctx.node.optional || inOptionalChain(ctx.node.object);

						// TODO: run property_argument through rewriter
						// object[location[location]]
						if (ctx.node.computed) {
							propertyArgument = result(ctx.node.property);
						} else if (ctx.node.property.type === 'Identifier') {
							propertyArgument = b.literal(ctx.node.property.name);
						} else {
							break;
						}

						if (
							ctx.parent?.node.type === 'NewExpression' &&
							ctx.parentKey === 'callee'
						) {
							ctx.parent!.replaceWith(
								b.callExpression(
									b.memberExpression(
										b.identifier(names.access),
										b.identifier('new2'),
									),
									[
										result(ctx.node.object),
										propertyArgument,
										result(argumentsArray(ctx.parent!.node.arguments)),
										b.literal(callText(ctx.parent!.node)),
									],
								),
							);
						} else if (
							ctx.parent?.node.type === 'CallExpression' &&
							ctx.parentKey === 'callee' &&
							((chained && !pure(propertyArgument)) ||
								((chained || ctx.parent.node.optional) &&
									!ctx.parent.node.arguments.every((argument: any) =>
										pure(argument),
									)) ||
								// a?.[k]().x: only a nullish `a` skips the rest of the
								// chain, which goes on in the lazy form's own chain
								(ctx.node.optional && continuesChain(ctx.parent)))
						) {
							// a?.b[k()](f()) / a[k]?.(f()): the key and the arguments are
							// evaluated only past the links that can short-circuit
							ctx.parent!.replaceWith(
								optionalCall(
									optionalCall(
										b.callExpression(
											b.memberExpression(
												b.identifier(names.access),
												b.identifier('method'),
											),
											[
												result(ctx.node.object),
												b.literal(chained),
												b.literal(!!ctx.parent!.node.optional),
												b.literal(callText(ctx.parent!.node)),
											],
										),
										[propertyArgument],
									),
									ctx.parent!.node.arguments.map((argument: any) =>
										result(argument),
									),
								),
							);
						} else if (
							ctx.parent?.node.type === 'CallExpression' &&
							ctx.parentKey === 'callee'
						) {
							// the rest of the chain past the call short-circuits too
							const call = ctx.parent;
							if (chained && continuesChain(call))
								call.parent!.node.optional = true;
							// which links short-circuit: 1 the object's, 2 the call's
							const links =
								(chained ? 1 : 0) | (ctx.parent!.node.optional ? 2 : 0);
							ctx.parent!.replaceWith(
								b.callExpression(
									b.memberExpression(
										b.identifier(names.access),
										b.identifier('call2'),
									),
									[
										result(ctx.node.object),
										propertyArgument,
										result(argumentsArray(ctx.parent!.node.arguments)),
										b.literal(callText(ctx.parent!.node)),
										...(links ? [b.literal(links)] : []),
									],
								),
							);
						} else if (
							ctx.parent?.node.type === 'UpdateExpression' ||
							(ctx.parent?.node.type === 'AssignmentExpression' &&
								ctx.parentKey === 'left')
						) {
							ctx.parent!.replaceWith(
								b.callExpression(
									b.memberExpression(
										b.identifier(names.access),
										b.identifier('set2'),
									),
									[
										// the object may itself be an unforgeable (`top.location = x`):
										// rewrite it like get2/call2 do, or set2 receives the real top
										result(ctx.node.object),
										propertyArgument,
										b.arrowFunctionExpression(
											[
												b.identifier(cTarget),
												b.identifier(cProp),
												b.identifier(cValue),
											],
											ctx.parent?.node.type === 'UpdateExpression'
												? b.updateExpression(
														ctx.parent!.node.operator,
														b.memberExpression(
															b.identifier(cTarget),
															b.identifier(cProp),
															true,
														),
														ctx.parent!.node.prefix,
													)
												: b.assignmentExpression(
														ctx.parent!.node.operator,
														b.memberExpression(
															b.identifier(cTarget),
															b.identifier(cProp),
															true,
														),
														b.identifier(cValue),
													),
										),
										// the value is rewritten like any expression: `o[k] = top`
										// or `o[k] = location.href` must not hand set2 the real one
										ctx.parent?.node.type === 'UpdateExpression'
											? b.identifier('undefined')
											: result(ctx.parent!.node.right),
										b.literal(generatePartial(script, ctx.parent!)),
									],
								),
							);
						} else if (
							(chained && !pure(propertyArgument)) ||
							(ctx.node.optional && continuesChain(ctx))
						) {
							// a?.b[k()]: the key is evaluated only past the links that can
							// short-circuit, and the rest of the chain follows in it (a?.[k].x:
							// a nullish `a` skips it, an undefined a[k] throws reading x)
							ctx.replaceWith(
								optionalCall(
									b.callExpression(
										b.memberExpression(
											b.identifier(names.access),
											b.identifier('lazy'),
										),
										[result(ctx.node.object)],
									),
									[propertyArgument],
								),
							);
						} else {
							// a?.[k] or a?.b.location: get2 short-circuits on a nullish
							// object, and the rest of the chain must keep
							// short-circuiting on undefined
							if (chained && ctx.parent) {
								const parent = ctx.parent.node;
								if (
									(parent.type === 'MemberExpression' &&
										ctx.parentKey === 'object') ||
									(parent.type === 'CallExpression' &&
										ctx.parentKey === 'callee')
								)
									parent.optional = true;
							}

							ctx.replaceWith(
								b.callExpression(
									b.memberExpression(
										b.identifier(names.access),
										b.identifier('get2'),
									),
									[
										result(ctx.node.object),
										propertyArgument,
										b.literal(generatePartial(script, ctx)),
										...(chained ? [b.literal(true)] : []),
									],
								),
							);
						}
					}
					break;
			}
		}

		// every function of the page's is marked with where it stands in the
		// text, which is kept for it (src/functionSource.ts)
		const format = (compact ?? minified(script)) ? COMPACT : undefined;
		const text = source?.text === undefined ? script : source.text;
		let key = source?.key;
		const shifts = source?.shifts ?? [];
		const at = (position: number) => {
			let shift = 0;
			for (let i = 0; i < shifts.length && position >= shifts[i]!; i += 2)
				shift = shifts[i + 1]!;
			return position + shift;
		};
		// (before the marks, which print a function's name with its own; only
		// a script that escapes an ASCII letter, a digit, `$` or `_` can
		// have a name it matters for, a keyword's or `eval`'s)
		if (ASCII_ESCAPE.test(script)) respell(tree, script);
		let marks = 0;
		try {
			marks = markFunctions(
				functions,
				script,
				(start, end) =>
					functionMark((key ??= sourceKey(script)), at(start), at(end)),
				(node) => generate(node, format),
			);
		} catch (error) {
			// a mark that could not be placed: those placed read back, the
			// rest show the rewritten code
		}
		let holder = '';
		// (the part of a split script that keeps the text writes it whether
		// or not functions of its own were marked, as the whole would)
		if (text !== null && (marks || source?.text !== undefined)) {
			key ??= sourceKey(script);
			if (keepsSourcesHere()) keepSource(key, text);
			else if (source?.embed !== false)
				holder = holderStatement(names.access, key, text) ?? '';
		}

		return (
			prologue +
			scriptLead(url, config, type, preamble) +
			holder +
			generate(tree, format) +
			trailer
		);
	} catch (error) {
		// (a part of a split script comes back as it went, which the caller
		// tells and rewrites the whole instead)
		if (compact !== undefined)
			return unrewritten(script, url, config, String(error));
		return cannotRewrite(script, url, config, type, String(error));
	}
}

/**
 * Whether the browser this runs in refuses `script` (of `type`) as it
 * compiles it, asked of its own engine without running anything: as a
 * function's body (a classic script's: the body takes what a script does,
 * a leading `#!` line aside, and `return` and `new.target` besides), or as
 * a strict async function's (a module's, when it names neither `import`
 * nor `export`, which no function body takes). False when it may take it:
 * the engine cannot be asked (a policy that forbids compiling strings), or
 * the script writes `eval` or `arguments` with an escape, where the answer
 * may not be the script's (V8 13.7 and before take the name in strict code
 * they compile lazily, and a function's body is compiled otherwise than a
 * script).
 */
function refusedHere(script: string, type: ScriptType): boolean {
	if (escapesEval(script)) return false;
	const body = script.replace(/^#![^\n\r\u2028\u2029]*/, '');
	const module = type === 'genericModule' || type === 'workerModule';
	if (module && /\b(?:import|export)\b/.test(body)) return false;
	try {
		new Function(
			module ? `'use strict'; return async function () {\n${body}\n};` : body,
		);
		return false;
	} catch (error) {
		return (error as Error)?.name === 'SyntaxError';
	}
}

/** an escape of an ASCII letter, digit, `$` or `_` */
const ASCII_ESCAPE =
	/\\u(?:00|\{0*)(?:2[4]|3[0-9]|[46][1-9a-fA-F]|[57][0-9aA]|5[fF])\}?/;

/** a name with an escape in its text, decoded */
const decoded = (written: string) =>
	written.replace(
		/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/g,
		(_, braced, plain) => {
			// (one past the last code point is no name's)
			const point = parseInt(braced ?? plain, 16);
			return point > 0x10ffff ? '\\' : String.fromCodePoint(point);
		},
	);

/** whether `script` writes `eval` or `arguments` with an escape (as a name or anywhere) */
function escapesEval(script: string): boolean {
	if (!script.includes('\\u')) return false;
	for (const [word] of script.matchAll(
		/(?:[\w$]|\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4}))+/g,
	))
		if (word.includes('\\') && /^(?:eval|arguments)$/.test(decoded(word)))
			return true;
	return false;
}

/**
 * The end written after a script this rewriter cannot rewrite and the
 * browser may run: a private name no class declares, an early error in
 * every kind of script, after all of the page's code. The browser
 * refuses the whole before any of it runs, with the page's own error
 * where the page's code has one, and STomp's name in the message where it
 * has none.
 */
export const UNREWRITTEN_END =
	'\n;this.#STomp_could_not_rewrite_this_script;\n';

/**
 * What a script this rewriter cannot rewrite (its parser refuses it, or
 * the rewrite failed) is answered with. One the browser refuses goes as it
 * came, and the page reads the browser's own SyntaxError. One it would run
 * must not run unrewritten, where its code would reach the real globals:
 * it goes with an end no browser compiles (UNREWRITTEN_END).
 */
export function cannotRewrite(
	script: string,
	url: StompURL,
	config: Config,
	type: ScriptType,
	why: string,
): string {
	const output = unrewritten(script, url, config, why);
	if (output !== script || refusedHere(script, type)) return output;
	return script + UNREWRITTEN_END;
}

/**
 * Each name of the page's the tree prints as the page wrote it, where it
 * was written with an escape (`\u0065val`, `l\u0065t`): printed plain
 * it is another token, a keyword or a name strict code refuses, and the
 * printed script a SyntaxError where the page's ran (`for (l\u0065t of
 * a);`, and V8 13.7 and before take an escaped `eval` in strict code they
 * compile lazily).
 */
function respell(tree: any, script: string) {
	// (a tree: a node the rewrite placed twice is respelled once)
	const walk = (node: any) => {
		if (node === null || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		if (node.type === 'Identifier' && Array.isArray(node.range)) {
			const written = script.slice(node.range[0], node.range[1]);
			if (
				written !== node.name &&
				written.includes('\\') &&
				decoded(written) === node.name
			)
				node.name = written;
			return;
		}
		for (const key in node)
			if (key !== 'range' && key !== 'loc') walk(node[key]);
	};
	walk(tree);
}

/**
 * What a pattern reads without a member expression to rewrite, at any
 * depth; the runtime `pattern()` wraps the source so those reads resolve
 * like member reads. Null when the pattern reads nothing of the kind.
 *
 * - An object pattern that names an unforgeable or destructures a key
 *   further: `{ top }` gives `{ top: true }`, `{ a: { location: l } }`
 *   gives `{ a: { location: true } }`.
 * - An object pattern with a computed key, which may name anything: the
 *   source is wrapped (`{}` when nothing else is named), and when a
 *   computed key's value is destructured further the properties are told
 *   apart by their order, not their keys:
 *   `{ a, [k]: { top } }` gives `{ '{}': [0, { top: true }] }`.
 * - An array pattern with such a pattern among its elements, by index:
 *   `[a, { top }]` gives `{ '[]': [0, { top: true }] }`. A rest element
 *   that is such a pattern becomes a plain last element, which the wrapped
 *   source answers with the rest as an array (wrapped in turn):
 *   `[a, ...[{ top }]]` is printed `[a, [{ top }]]` with
 *   `{ '[]': [0, [{ '[]': [{ top: true }] }]] }`, the rest's spec in an
 *   array of its own.
 */
type PatternSpec = {
	[key: string]: true | PatternSpec | (0 | PatternSpec | [PatternSpec])[];
};

function patternSpec(
	pattern: any,
	routed: readonly string[] = UNDEFINABLE,
): PatternSpec | null {
	if (pattern?.type === 'ArrayPattern') {
		const specs: (0 | PatternSpec | [PatternSpec])[] = [];
		let used = 0;
		pattern.elements.forEach((element: any, index: number) => {
			let spec: PatternSpec | [PatternSpec] | null = null;
			if (element?.type === 'RestElement') {
				const rest = patternSpec(element.argument, routed);
				if (rest) {
					// (the mark is an own property: a copy of the node keeps it)
					element.argument.restOfPattern = true;
					pattern.elements[index] = element.argument;
					spec = [rest];
				}
			} else if (element?.restOfPattern) {
				spec = [patternSpec(element, routed)!];
			} else if (element)
				spec = patternSpec(
					element.type === 'AssignmentPattern' ? element.left : element,
					routed,
				);
			specs.push(spec ?? 0);
			if (spec) used = index + 1;
		});
		return used ? { '[]': specs.slice(0, used) } : null;
	}
	if (pattern?.type !== 'ObjectPattern') return null;
	const spec: PatternSpec = {};
	let any = false;
	// by position, when a computed key's value is destructured further
	const positions: (0 | PatternSpec)[] = [];
	let positional = false;
	for (const property of pattern.properties) {
		if (property.type !== 'Property') continue;
		const value =
			property.value.type === 'AssignmentPattern'
				? property.value.left
				: property.value;
		const nested = patternSpec(value, routed);
		positions.push(nested ?? 0);
		// a computed key may name anything (the client's global too): the
		// source is wrapped, so the read resolves like a computed member read
		if (property.computed) {
			any = true;
			if (nested) positional = true;
			continue;
		}
		const key = property.key;
		const name =
			key.type === 'Identifier'
				? key.name
				: key.type === 'Literal'
					? String(key.value)
					: '';
		if (nested) {
			spec[name] = nested;
			any = true;
		} else if (routed.includes(name) || name === 'postMessage') {
			// (`{ postMessage } = parent` reads another window's postMessage:
			// see postRead)
			spec[name] = true;
			any = true;
		}
	}
	if (positional) return { '{}': positions };
	return any ? spec : null;
}

function specLiteral(spec: PatternSpec): any {
	const list = (items: (0 | PatternSpec | [PatternSpec])[]): any =>
		b.arrayExpression(
			items.map((item) =>
				item === 0
					? b.literal(0)
					: Array.isArray(item)
						? b.arrayExpression([specLiteral(item[0])])
						: specLiteral(item),
			),
		);
	return b.objectExpression(
		Object.entries(spec).map(([key, value]) =>
			b.property(
				'init',
				b.literal(key),
				value === true
					? b.literal(true)
					: Array.isArray(value)
						? list(value)
						: specLiteral(value),
			),
		),
	);
}

/** whether the spec is an array pattern's (its source is iterated) */
const iterates = (spec: PatternSpec) => Array.isArray(spec['[]']);

/**
 * `$s$j.pattern(source, spec, text)`: `text` is the destructuring's source,
 * for the error a null or undefined source throws (an array pattern's
 * source is checked by `$s$j.iter` first, so it has none)
 */
function patternCall(
	source: any,
	spec: PatternSpec,
	access: string,
	text?: any,
): any {
	return b.callExpression(
		b.memberExpression(b.identifier(access), b.identifier('pattern')),
		text ? [source, specLiteral(spec), text] : [source, specLiteral(spec)],
	);
}

function isPatternCall(node: any, access: string): boolean {
	return (
		node.type === 'CallExpression' &&
		node.callee.type === 'MemberExpression' &&
		node.callee.object.type === 'Identifier' &&
		node.callee.object.name === access &&
		node.callee.property.type === 'Identifier' &&
		node.callee.property.name === 'pattern'
	);
}

/**
 * Whether `test` holds for a child node of an ESTree node, tried in source
 * order. A plain loop, not a generator: the rewriter runs this on every node
 * of a script, and a generator per node was a tenth of a large rewrite.
 */
function someChild(node: any, test: (child: any) => boolean): boolean {
	for (const key in node) {
		if (key === 'range' || key === 'loc') continue;
		const value = node[key];
		if (typeof value !== 'object' || value === null) continue;
		if (Array.isArray(value)) {
			for (let i = 0; i < value.length; i++) {
				const item = value[i];
				if (item && typeof item.type === 'string' && test(item)) return true;
			}
		} else if (typeof value.type === 'string' && test(value)) return true;
	}
	return false;
}

/** the names a binding pattern introduces */
function boundNames(pattern: any, names: string[] = []): string[] {
	switch (pattern?.type) {
		case 'Identifier':
			names.push(pattern.name);
			break;
		case 'ObjectPattern':
			for (const property of pattern.properties)
				boundNames(
					property.type === 'RestElement' ? property.argument : property.value,
					names,
				);
			break;
		case 'ArrayPattern':
			for (const element of pattern.elements) boundNames(element, names);
			break;
		case 'AssignmentPattern':
			boundNames(pattern.left, names);
			break;
		case 'RestElement':
			boundNames(pattern.argument, names);
			break;
	}
	return names;
}

function mentions(node: any, names: string[]): boolean {
	if (node.type === 'Identifier' && names.includes(node.name)) return true;
	if (someChild(node, (child) => mentions(child, names))) return true;
	return false;
}

/**
 * Whether code under `node` may read or call the bare name: an identifier
 * anywhere but where it only names a property (`o.name`, `{ name: 1 }`, a
 * class member's key)
 */
function refersTo(node: any, name: string): boolean {
	if (node.type === 'Identifier') return node.name === name;
	return someChild(
		node,
		(child) =>
			!(
				!node.computed &&
				((node.type === 'MemberExpression' && child === node.property) ||
					((node.type === 'Property' ||
						node.type === 'MethodDefinition' ||
						node.type === 'PropertyDefinition') &&
						child === node.key &&
						child !== node.value))
			) && refersTo(child, name),
	);
}

/** a tree of its own with the same nodes (the walk's marks, which are symbols, stay behind) */
function copyNode(node: any): any {
	if (Array.isArray(node)) return node.map(copyNode);
	if (!node || typeof node !== 'object' || node instanceof RegExp) return node;
	const copy: any = {};
	for (const key in node) copy[key] = copyNode(node[key]);
	return copy;
}

/**
 * `function f({ top: t }) {}`: a parameter pattern has no source expression
 * to wrap, so the parameter becomes a plain one and the pattern a `var`
 * declaration at the top of the body (after the directive prologue), whose
 * source the main pass wraps. `var` matches a parameter's scoping; the
 * default value stays on the parameter. Left alone when a later parameter
 * refers to a name the pattern binds. (`'use strict'` cannot appear in such
 * a function, but other directives can, so the prologue is skipped.)
 */
/**
 * The pass over the whole tree before the main walk: destructured
 * parameters hoisted, and every BigInt literal given its text. Escodegen
 * prints a BigInt only from its `raw` text, which this parse does not keep:
 * it printed 0n as 0, a Number, so arithmetic with BigInts threw and a large
 * one lost its value. This pass reaches a literal the main walk does not (one
 * a replacement reuses, `location = 7n`); the text is the value in decimal.
 */
function prepareTree(
	node: any,
	access: string,
	routed: readonly string[],
	functions: any[],
	script: string,
) {
	if (
		node.type === 'Literal' &&
		typeof node.bigint === 'string' &&
		node.raw === undefined
	) {
		node.raw = `${node.bigint}n`;
		return;
	}
	hoistParamPatterns(node, access, routed, functions, script);
}

/**
 * The statements at the top of a program or a function body that are a
 * string and nothing else, printed so that each stays what it was. The
 * generator prints such a statement as the string's value in quotes, which
 * is a directive where it stands first: `('use strict');`, an expression,
 * would come out a directive and turn sloppy code strict (assignments to
 * undeclared names throw, `this` is undefined in a called function), and so
 * would `'use\x20strict';`, a directive that is not "use strict" for its
 * escape. The first keeps its parentheses and the second its text. (Past
 * the first statement that is no directive nothing is one.)
 */
function keepDirectives(body: any[], script: string) {
	for (const statement of body) {
		if (statement.type !== 'ExpressionStatement') return;
		const { expression } = statement;
		if (expression.type !== 'Literal' || typeof expression.value !== 'string')
			return;
		const text = script.slice(expression.range[0], expression.range[1]);
		if (typeof statement.directive !== 'string') {
			statement.expression = rawNode(`(${text})`);
			return;
		}
		if (statement.directive !== expression.value)
			statement.expression = rawNode(text);
	}
}

function hoistParamPatterns(
	node: any,
	access: string,
	routed: readonly string[],
	functions: any[],
	script: string,
) {
	const PARAM_TEMP = `${access}a`;
	// the children first, in source order (a plain loop: this runs on every
	// node of the script)
	for (const key in node) {
		if (key === 'range' || key === 'loc') continue;
		const value = node[key];
		if (typeof value !== 'object' || value === null) continue;
		if (Array.isArray(value)) {
			for (let i = 0; i < value.length; i++) {
				const item = value[i];
				if (item && typeof item.type === 'string') {
					prepareTree(item, access, routed, functions, script);
					if (
						item.type === 'AssignmentExpression' &&
						unparenthesised(node, item) &&
						// (a call's own argument keeps the parentheses the page
						// wrote; any other place may become an argument)
						((node.type !== 'CallExpression' &&
							node.type !== 'NewExpression') ||
							inParentheses(script, item))
					)
						value[i] = parenthesised(item);
				}
			}
		} else if (typeof value.type === 'string') {
			prepareTree(value, access, routed, functions, script);
			if (value.type === 'AssignmentExpression' && unparenthesised(node, value))
				node[key] = parenthesised(value);
		}
	}
	if (MARKED.has(node.type)) functions.push(node);

	if (node.type === 'Program') keepDirectives(node.body, script);
	hoistHeadPatterns(node, access, routed);
	// what the generator prints without the parentheses it needs: a sequence
	// of the one expression is printed in them.
	// `export default (function () {})();`: bare, `function` begins a
	// declaration and the module does not parse
	if (
		node.type === 'ExportDefaultDeclaration' &&
		startsDeclaration(node.declaration)
	)
		node.declaration = {
			type: 'SequenceExpression',
			expressions: [node.declaration],
		};
	// `class A extends (await f()) {}`, `extends (a || b)`: what a class
	// extends is a call, a member or a primary expression, or stands in
	// parentheses
	if (
		(node.type === 'ClassDeclaration' || node.type === 'ClassExpression') &&
		node.superClass &&
		!HERITAGE.has(node.superClass.type) &&
		inParentheses(script, node.superClass)
	)
		node.superClass = {
			type: 'SequenceExpression',
			expressions: [node.superClass],
		};
	if (
		node.type !== 'FunctionDeclaration' &&
		node.type !== 'FunctionExpression' &&
		node.type !== 'ArrowFunctionExpression'
	)
		return;
	if (node.body.type === 'BlockStatement')
		keepDirectives(node.body.body, script);

	const hoisted: any[] = [];
	// the names the hoisted patterns bind: a later parameter that mentions
	// one (`({ top: t }, u = t) => u`) is evaluated after them, in the body
	const names: string[] = [];
	node.params = node.params.map((param: any, index: number) => {
		const temp = b.identifier(`${PARAM_TEMP}${index}`);
		const from = b.identifier(temp.name);
		// `(...[{ top: t }]) => t`: the rest is an array of the arguments
		if (param.type === 'RestElement') {
			if (
				!patternSpec(param.argument, routed) &&
				!(names.length && mentions(param.argument, names))
			)
				return param;
			boundNames(param.argument, names);
			hoisted.push(b.variableDeclarator(param.argument, from));
			return { type: 'RestElement', argument: temp };
		}
		const isDefault = param.type === 'AssignmentPattern';
		const target = isDefault ? param.left : param;
		if (patternSpec(target, routed)) {
			// its default stays on the parameter, unless it mentions a name
			// hoisted before it
			if (!isDefault || !(names.length && mentions(param.right, names))) {
				boundNames(target, names);
				hoisted.push(b.variableDeclarator(target, from));
				return isDefault ? b.assignmentPattern(temp, param.right) : temp;
			}
		} else if (!(names.length && mentions(param, names))) return param;
		boundNames(target, names);
		if (!isDefault) {
			hoisted.push(b.variableDeclarator(target, from));
			return temp;
		}
		// `u = t`: the default is taken in the body, where `t` is bound; the
		// parameter keeps a default so the function's length is what it was
		const unset = () => ({
			type: 'UnaryExpression',
			operator: 'void',
			prefix: true,
			argument: b.literal(0),
		});
		hoisted.push(
			b.variableDeclarator(
				target,
				b.conditionalExpression(
					{
						type: 'BinaryExpression',
						operator: '===',
						left: from,
						right: unset(),
					},
					param.right,
					b.identifier(temp.name),
				),
			),
		);
		return b.assignmentPattern(temp, unset());
	});
	if (!hoisted.length) return;

	if (node.body.type !== 'BlockStatement') {
		node.body = b.blockStatement([b.returnStatement(node.body)]);
		// meriyah's flag for an expression-bodied arrow; the generator prints
		// a block in parentheses while it is set
		node.expression = false;
	}
	const body = node.body.body;
	let at = 0;
	while (
		at < body.length &&
		body[at].type === 'ExpressionStatement' &&
		typeof body[at].directive === 'string'
	)
		at++;
	body.splice(at, 0, b.variableDeclaration('var', hoisted));
}

/**
 * `for (const { top: t } of a)`, `for ({ top: t } of a)`,
 * `catch ({ top: t })`: a pattern with no source expression to wrap, like a
 * parameter's. The head binds a plain name and the pattern moves to the top
 * of the body as a declaration (or the assignment it was) from that name,
 * whose source the main pass wraps. (`for ... in` hands out strings.)
 */
function hoistHeadPatterns(
	node: any,
	access: string,
	routed: readonly string[],
) {
	if (node.type === 'CatchClause') {
		if (!node.param || !patternSpec(node.param, routed)) return;
		const temp = `${access}c`;
		// (a name the pattern binds cannot be declared again in the block, so
		// the block is the pattern's own scope too)
		node.body.body.unshift(
			b.variableDeclaration('let', [
				b.variableDeclarator(node.param, b.identifier(temp)),
			]),
		);
		node.param = b.identifier(temp);
		return;
	}
	if (node.type !== 'ForOfStatement') return;
	const temp = `${access}f`;
	const { left } = node;
	let first;
	if (left.type === 'VariableDeclaration') {
		const [declarator] = left.declarations;
		if (!patternSpec(declarator.id, routed)) return;
		first = b.variableDeclaration(left.kind, [
			b.variableDeclarator(declarator.id, b.identifier(temp)),
		]);
	} else {
		if (!patternSpec(left, routed)) return;
		first = b.expressionStatement(
			b.assignmentExpression('=', left, b.identifier(temp)),
		);
	}
	// (the temporary is the loop's own: nothing of the page's can name it)
	node.left = b.variableDeclaration('const', [
		b.variableDeclarator(b.identifier(temp)),
	]);
	// the body stays a statement of its own: a block may declare a name the
	// head binds
	node.body = b.blockStatement([first, node.body]);
}

/**
 * Where the text a script's functions read back as is kept
 * (src/functionSource.ts). A whole script needs none of it: its own text is
 * kept, by its own key.
 */
/**
 * Which backend rewrote a script under `rewriter: 'wasm'`: the module, or
 * the JavaScript rewriter (the module declined the script, or the thread
 * holds none). Unset when the module was not asked.
 */
export interface RewrittenBy {
	by?: 'wasm' | 'js';
}

export interface ScriptSource {
	/** the key of the text this script's positions refer to */
	key?: string;
	/** the text kept: null when another part of a split script keeps it */
	text?: string | null;
	/**
	 * `[position, shift, ...]`, ascending: a position of this script at or
	 * past `position` stands `shift` further on in the text (a part of a
	 * split script)
	 */
	shifts?: number[];
	/** false: never written into the output (a javascript: URL's body) */
	embed?: boolean;
}

/** a node escodegen prints as `raw`, as it is (it prints a BigInt literal from its raw text) */
const rawNode = (raw: string) => ({
	type: 'Literal',
	value: 0,
	bigint: '',
	raw,
});
/** an identifier (or #private name) printed with `suffix` after it */
const suffixed = (node: any, suffix: string) => ({
	type: node.type,
	name: node.name + suffix,
});

/**
 * Mark the first binding name of a parameter, or the first after which
 * nothing but punctuation and quoted keys comes before it. 'empty': the
 * pattern binds nothing (`{}`), 'none': its first part could hold a
 * function (a computed key), and the parameter is marked as a whole.
 */
function markSlot(
	container: any,
	key: string | number,
	mark: string,
): 'marked' | 'empty' | 'none' {
	const node = container[key];
	switch (node?.type) {
		case 'Identifier':
			container[key] = suffixed(node, mark);
			return 'marked';
		case 'AssignmentPattern': {
			const left = markSlot(node, 'left', mark);
			return left === 'empty' ? 'none' : left;
		}
		case 'RestElement':
			return markSlot(node, 'argument', mark);
		case 'ArrayPattern':
			for (let i = 0; i < node.elements.length; i++) {
				if (!node.elements[i]) continue;
				const element = markSlot(node.elements, i, mark);
				if (element !== 'empty') return element;
			}
			return 'empty';
		case 'ObjectPattern':
			for (const property of node.properties) {
				if (property.type === 'RestElement') {
					const rest = markSlot(property, 'argument', mark);
					if (rest !== 'empty') return rest;
					continue;
				}
				if (property.computed) return 'none';
				// a shorthand prints its key, or its default's target
				if (property.shorthand)
					return property.value?.type === 'AssignmentPattern'
						? markSlot(property.value, 'left', mark)
						: markSlot(property, 'key', mark);
				if (property.key.type === 'Identifier')
					return markSlot(property, 'key', mark);
				// a quoted or numeric key: the value is next
				const value = markSlot(property, 'value', mark);
				if (value !== 'empty') return value;
			}
			return 'empty';
	}
	return 'none';
}

/** the position after `static` and what follows it up to the method's own source */
function afterStatic(script: string, start: number): number {
	let at = start + 'static'.length;
	for (;;) {
		if (script.startsWith('/*', at)) {
			const end = script.indexOf('*/', at + 2);
			if (end === -1) return at;
			at = end + 2;
		} else if (script.startsWith('//', at)) {
			const end = script.slice(at).search(/[\n\r\u2028\u2029]/);
			if (end === -1) return at;
			at += end;
		} else if (/\s/.test(script[at] ?? '')) at++;
		else return at;
	}
}

/** the nodes the pre-pass collects for markFunctions */
const MARKED = new Set([
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression',
	'ClassDeclaration',
	'ClassExpression',
	'MethodDefinition',
	'Property',
]);

/**
 * Mark every function of the page's (one with a source range: what the
 * rewriter made has none) in the rewritten tree, right after the first
 * token of its source, before anything that could hold a function: a
 * function or class after its name, or after `function` / `class` (an
 * anonymous one prints the mark as its name), an arrow after its first
 * parameter's first name (the mark in parentheses standing for no
 * parameters), a method, getter or setter after its key (inside the
 * brackets of a computed one). `functions` are the ones the pre-pass
 * found, children first (the rewrite keeps every function where it was,
 * inside the same functions), so a part printed ahead of time (a computed
 * key, a parameter pattern) carries the marks of its own functions. The
 * count of marks.
 */
function markFunctions(
	functions: any[],
	script: string,
	markOf: (start: number, end: number) => string,
	print: (node: any) => string,
): number {
	let count = 0;
	const isMethod = (node: any) =>
		node.type === 'MethodDefinition' ||
		(node.type === 'Property' &&
			(node.method || node.kind === 'get' || node.kind === 'set'));
	// a method's function is the method's: its source is the method's
	const methodValues = new WeakSet<object>();
	for (const node of functions)
		if (isMethod(node)) methodValues.add(node.value);
	for (const node of functions) {
		if (!node.range) continue;
		switch (node.type) {
			case 'FunctionDeclaration':
			case 'FunctionExpression':
			case 'ClassDeclaration':
			case 'ClassExpression':
				if (methodValues.has(node)) continue;
				node.id = suffixed(
					node.id ?? { type: 'Identifier', name: '' },
					markOf(node.range[0], node.range[1]),
				);
				count++;
				continue;
			case 'ArrowFunctionExpression': {
				const mark = markOf(node.range[0], node.range[1]);
				count++;
				if (!node.params.length) {
					node.params = [{ type: 'Identifier', name: `(${mark})` }];
					continue;
				}
				let slot: ReturnType<typeof markSlot> = 'empty';
				for (let i = 0; i < node.params.length && slot === 'empty'; i++)
					slot = markSlot(node.params, i, mark);
				// no name to mark before anything that could hold a function:
				// the first parameter printed whole after the mark (any before
				// a computed key binds nothing)
				if (slot !== 'marked')
					node.params[0] = rawNode(mark + print(node.params[0]));
				continue;
			}
			case 'MethodDefinition':
			case 'Property': {
				if (!isMethod(node) || node.kind === 'constructor') continue;
				// a static method's source starts after `static`
				const mark = markOf(
					node.static ? afterStatic(script, node.range[0]) : node.range[0],
					node.range[1],
				);
				count++;
				const { key } = node;
				if (node.computed) {
					const printed = print(key);
					node.key = rawNode(
						mark +
							(key.type === 'SequenceExpression' ? `(${printed})` : printed),
					);
				} else if (
					key.type === 'Identifier' ||
					key.type === 'PrivateIdentifier'
				)
					node.key = suffixed(key, mark);
				else node.key = rawNode(print(key) + mark);
				continue;
			}
		}
	}
	return count;
}

/** whether `code` parses as a script of one expression statement (a javascript: URL's body) */
export function singleExpression(code: string): boolean {
	// the module's parser where this thread holds it
	const answered = parsesInWasm(code, true);
	if (answered !== null) return answered;
	try {
		const program = parse(code, { next: true });
		return (
			program.body.length === 1 &&
			program.body[0].type === 'ExpressionStatement'
		);
	} catch (error) {
		return false;
	}
}

provideRewriters({ modifyJS, singleExpression });
