import { generate } from '@javascript-obfuscator/escodegen';
import { builders as b } from 'ast-types';
import { parse } from 'meriyah';
import type { ESTree } from 'meriyah';
import { AcornContext, AcornIterator, result } from './acornUtil';
import { Config } from './config';
import {
	functionMark,
	holderStatement,
	keepSource,
	keepsSourcesHere,
	sourceKey,
} from './functionSource';
import { DEFAULT_NAMES, helperNames } from './helperNames';
import {
	createDataURI,
	injectWorkerJS,
	parseDataURI,
	routeBinary,
	routeURL,
} from './routeURL';
import StompURL from './StompURL';

// the default helper names; the rewriter and the inject read a config's own
// (src/helperNames.ts), these are for code that has none to hand (tests)
export const ACCESS_KEY = DEFAULT_NAMES.access;
export const GLOBAL_PROXY = DEFAULT_NAMES.globalProxy;
export const GLOBAL_NAME = DEFAULT_NAMES.globalName;
export const CLIENT_KEY = DEFAULT_NAMES.client;

// smaller range inside larger range = invalidates larger range
// smaller modifications called later in script

export const PROVIDERS = ['window', 'document'];
export const UNDEFINABLE = ['eval', 'location', 'top'];

/**
 * Whether a member access short-circuits because an earlier link of its
 * chain is optional (`a?.b.location`): the spine of objects and callees down
 * to the chain's start. A nested ChainExpression is a parenthesised chain,
 * which ends the short-circuit (`(a?.b).location` throws on null).
 */
/**
 * The function a rewritten `x.postMessage(...)` calls, read the way the
 * original call reads it: a null or undefined receiver throws the TypeError
 * the property read would have thrown (`fetch_tests_from_window(null)` after
 * a blocked `window.open`), not one from inside the access API's apply, and
 * so does a postMessage that is not callable. With `optional` (`x?.post...`)
 * a missing receiver or method answers undefined instead.
 */
export function postMessageMethod(
	target: any,
	optional = false,
): ((...args: any[]) => any) | undefined {
	if (target === null || target === undefined) {
		if (optional) return undefined;
		throw new TypeError(
			`Cannot read properties of ${target} (reading 'postMessage')`,
		);
	}
	const method = target.postMessage;
	if (optional && (method === null || method === undefined)) return undefined;
	if (typeof method !== 'function')
		throw new TypeError('postMessage is not a function');
	return method;
}

/**
 * A call that posts a message: `x.postMessage(...)`, `x.postMessage.call(w,
 * ...)`, `x.postMessage.apply(w, args)` and `Reflect.apply(x.postMessage, w,
 * args)`. The receiver, the arguments (an array expression or the array
 * given) and whether the chain is optional; null for any other call.
 */
function postMessageCall(
	node: any,
): { target: any; args: any; optional: boolean } | null {
	const isPostMessage = (member: any) =>
		member?.type === 'MemberExpression' &&
		(member.computed
			? member.property.type === 'Literal' &&
				member.property.value === 'postMessage'
			: member.property.type === 'Identifier' &&
				member.property.name === 'postMessage');
	const { callee } = node;
	if (isPostMessage(callee))
		return {
			target: callee.object,
			args: b.arrayExpression(node.arguments),
			optional:
				!!node.optional || !!callee.optional || inOptionalChain(callee.object),
		};
	if (
		callee?.type === 'MemberExpression' &&
		!callee.computed &&
		callee.property.type === 'Identifier' &&
		(callee.property.name === 'call' || callee.property.name === 'apply') &&
		isPostMessage(callee.object) &&
		!node.arguments.some((argument: any) => argument.type === 'SpreadElement')
	) {
		const [target = b.identifier('undefined'), ...rest] = node.arguments;
		return {
			target,
			args:
				callee.property.name === 'call'
					? b.arrayExpression(rest)
					: (rest[0] ?? b.arrayExpression([])),
			optional: false,
		};
	}
	if (
		callee?.type === 'MemberExpression' &&
		!callee.computed &&
		callee.object.type === 'Identifier' &&
		callee.object.name === 'Reflect' &&
		callee.property.type === 'Identifier' &&
		callee.property.name === 'apply' &&
		node.arguments.length >= 2 &&
		isPostMessage(node.arguments[0]) &&
		!node.arguments.some((argument: any) => argument.type === 'SpreadElement')
	)
		return {
			target: node.arguments[1],
			args: node.arguments[2] ?? b.arrayExpression([]),
			optional: false,
		};
	return null;
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

export type ScriptType =
	'generic' | 'genericModule' | 'worker' | 'workerModule';

/**
 * The route of a module an import loads, by its `with { type }`: a JSON
 * module is no script and goes as it is (its body is the module, and its
 * MIME type the browser checks); a CSS module is a stylesheet, its url()s
 * routed; anything else is a module script, rewritten
 */
export function routeImport(
	resource: StompURL,
	base: StompURL,
	config: Config,
	type: ScriptType,
	moduleType: unknown,
): string {
	if (moduleType === 'json') return routeBinary(resource);
	if (moduleType === 'css') return routeURL('css', resource);
	return routeJS(resource, base, config, type);
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

export function routeJS(
	resource: StompURL,
	url: StompURL,
	config: Config,
	type: ScriptType = 'generic',
) {
	if (resource.url.protocol === 'data:') {
		const { mime, data, attributes } = parseDataURI(
			// the data is everything after `data:` but the fragment: a `?` in it
			// is data too, which the URL parser filed under `search`
			resource.url.pathname + resource.url.search,
		);
		return createDataURI({
			mime,
			data: modifyJS(data, url, config, type),
			attributes,
		});
	}

	return routeURL('js:' + type, resource);
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
) {
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
	try {
		const isModule = type === 'genericModule' || type === 'workerModule';
		const isWorker = type === 'workerModule' || type === 'worker';

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
			while (
				count < body.length &&
				body[count].type === 'ExpressionStatement' &&
				body[count].expression?.type === 'Literal' &&
				typeof body[count].expression.value === 'string' &&
				!body[count].expression.regex
			)
				count++;
			prologue = body
				.splice(0, count)
				.map(
					(statement) =>
						`${statement.expression.raw ?? JSON.stringify(statement.expression.value)};`,
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
		prepareTree(tree, names.access, routed, functions);

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
								[base, ctx.node.source],
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
							[ctx.node.source, options],
						),
					);
					break;
				}
				case 'VariableDeclarator':
					// `const { top: t } = o`, `const { a: { top } } = o`: the pattern
					// reads `o.top` without a member expression to rewrite, so the
					// source is wrapped and the reads resolve through it, at every
					// depth the pattern names an unforgeable
					{
						const spec =
							ctx.node.init && !isPatternCall(ctx.node.init, names.access)
								? patternSpec(ctx.node.id, routed)
								: null;
						if (spec)
							ctx.replaceWith(
								b.variableDeclarator(
									ctx.node.id,
									patternCall(result(ctx.node.init), spec, names.access),
								),
							);
					}
					break;
				case 'AssignmentExpression':
					{
						const spec = patternSpec(ctx.node.left, routed);
						if (spec)
							ctx.replaceWith(
								b.assignmentExpression(
									'=',
									// visited too: a location target and the defaults
									// (`({ location = top } = o)`) are rewritten there
									result(ctx.node.left),
									patternCall(result(ctx.node.right), spec, names.access),
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
										[result(post.target)],
									),
									ctx.node.arguments.map((argument: any) => result(argument)),
								),
							);
							break typeLoop;
						}
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
										...(post.optional ? [b.literal(true)] : []),
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
									b.callExpression(
										b.identifier('eval'),
										ctx.node.arguments.map((arg: unknown) => result(arg)),
									),
								),
							);
						}
					}
					break;
				case 'Identifier':
					{
						// `[location] = a`, `({ location } = o)`, `for (location of
						// a)`: a reference no set1 call can stand for, so it becomes
						// the member `$s$j.ref1(location, setter).value`, whose write
						// routes like `location = v` (bindings are left below)
						if (ctx.node.name === 'location' && assignmentTarget(ctx)) {
							unshorthand(ctx);
							ctx.replaceWith(
								b.memberExpression(
									b.callExpression(
										b.memberExpression(
											b.identifier(names.access),
											b.identifier('ref1'),
										),
										[
											b.identifier('location'),
											b.arrowFunctionExpression(
												[b.identifier(cValue)],
												b.assignmentExpression(
													'=',
													b.identifier('location'),
													b.identifier(cValue),
												),
											),
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
						// (`typeof top` must not throw in a worker)
						switch (ctx.parent?.node.type) {
							case 'ArrayPattern':
							case 'ObjectPattern':
							case 'LabeledStatement':
							case 'BreakStatement':
							case 'ContinueStatement':
							case 'MethodDefinition':
							case 'ClassDeclaration':
							case 'ClassExpression':
							case 'CatchClause':
							case 'RestElement':
							case 'ExportSpecifier':
							case 'ImportSpecifier':
							case 'ImportDefaultSpecifier':
							case 'ImportNamespaceSpecifier':
								break typeLoop;
							case 'PropertyDefinition':
								if (ctx.parentKey === 'key') break typeLoop;
								break;
							case 'UnaryExpression':
								if (ctx.parent.node.operator === 'typeof') break typeLoop;
								break;
							case 'ForInStatement':
							case 'ForOfStatement':
								// an assignment target, not an expression
								if (ctx.parentKey === 'left') break typeLoop;
								break;
							case 'MemberExpression':
								if (ctx.parentKey === 'property') break typeLoop;
								break;
							case 'VariableDeclarator':
								if (ctx.parentKey === 'id') break typeLoop;
								break;
							case 'Property':
								if (ctx.parentKey === 'key') break typeLoop;
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
										ctx.parent!.node.type === 'UpdateExpression'
											? b.identifier('undefined')
											: ctx.parent.node.right,
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
						// `super.location` reads the prototype chain, never the window,
						// and `super` is not a value a helper could take
						if (ctx.node.object.type === 'Super') break typeLoop;
						// `[top.location] = a`, `for (frames[0].location of a)`: a
						// pattern or loop head target is a reference, never a get2
						// call; a location there becomes `$s$j.ref2(o, k).value`,
						// whose write routes like set2, anything else stays as is
						if (assignmentTarget(ctx)) {
							const key = ctx.node.computed
								? ctx.node.property.type === 'Literal' &&
									ctx.node.property.value
								: ctx.node.property.name;
							if (key === 'location') {
								unshorthand(ctx);
								ctx.replaceWith(
									b.memberExpression(
										b.callExpression(
											b.memberExpression(
												b.identifier(names.access),
												b.identifier('ref2'),
											),
											[result(ctx.node.object), b.literal(key)],
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
							if (ctx.node.object.type === 'Super') {
								break typeLoop;
							}

							if (ctx.node.property.type === 'Literal') {
								if (
									!routed.includes(ctx.node.property.value) &&
									!indexRead(ctx)
								) {
									break typeLoop;
								}
							}
						} else
							switch (ctx.node.property.type) {
								case 'Identifier':
									if (!routed.includes(ctx.node.property.name)) {
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
										result(b.arrayExpression(ctx.parent!.node.arguments)),
										b.literal(generatePartial(script, ctx.parent!)),
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
									)))
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
							if (
								chained &&
								call.parent &&
								((call.parent.node.type === 'MemberExpression' &&
									call.parentKey === 'object') ||
									(call.parent.node.type === 'CallExpression' &&
										call.parentKey === 'callee'))
							)
								call.parent.node.optional = true;
							ctx.parent!.replaceWith(
								b.callExpression(
									b.memberExpression(
										b.identifier(names.access),
										b.identifier('call2'),
									),
									[
										result(ctx.node.object),
										propertyArgument,
										result(b.arrayExpression(ctx.parent!.node.arguments)),
										b.literal(generatePartial(script, ctx.parent!)),
										...(chained || ctx.parent!.node.optional
											? [b.literal(true)]
											: []),
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
						} else if (chained && !pure(propertyArgument)) {
							// a?.b[k()]: the key is evaluated only past the links that can
							// short-circuit, and the rest of the chain follows in it
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

		const bundle = JSON.stringify(injectWorkerJS(url, config));
		return (
			prologue +
			// a module worker has no importScripts: fetch the bundle and run it
			// as the classic script it is (indirect eval, top-level await),
			// named for its URL, so its frames are dropped from stacks like
			// those of a bundle a classic worker imports
			// (once: the bundle deletes createClient when the client is made,
			// and a module worker's imports each carry this preamble). The
			// browser dispatches messages during a top-level await, when the
			// page's module has not set its handlers yet (natively its top
			// level runs first): those, and a shared worker's connects, are
			// held and the client dispatches them again
			(type === 'workerModule'
				? `if (!(${JSON.stringify(names.client)} in globalThis)) {
	let held;
	if (!globalThis.createClient) {
		held = [];
		const hold = (event) => {
			event.stopImmediatePropagation();
			held.push(event);
		};
		addEventListener('message', hold);
		addEventListener('connect', hold);
		try {
			(0, eval)((await (await fetch(${bundle})).text()) + '\\n//# sourceURL=' + new globalThis.URL(${bundle}, globalThis.location.href).href);
		} finally {
			removeEventListener('message', hold);
			removeEventListener('connect', hold);
		}
	}
	createClient(${JSON.stringify(config)}, ${JSON.stringify(url.codec.key)}, held);
}
if (!${names.client}.applied)
	${names.client}.apply();`
				: isWorker
					? `if (!(${JSON.stringify(names.client)} in globalThis) && !globalThis.createClient)
	importScripts(${JSON.stringify(injectWorkerJS(url, config))});

if (!(${JSON.stringify(names.client)} in globalThis))
	createClient(${JSON.stringify(config)}, ${JSON.stringify(url.codec.key)});

if (!${names.client}.applied) 
	${names.client}.apply();`
					: '') +
			// import.meta.resolve answers with the page's URLs; a bare specifier
			// belongs to the import map and comes back as it is
			(isModule
				? `import.meta.url = ${JSON.stringify(url.toString())};import.meta.resolve = (s) => ${BARE_SPECIFIER}.test(s = String(s)) ? s : new URL(s, import.meta.url).href;`
				: '') +
			preamble +
			holder +
			generate(tree, format) +
			trailer
		);
	} catch (error) {
		// a script the rewriter cannot handle runs as it was: the browser may
		// still parse it (and rejects it the same way when it cannot), while a
		// `throw` here would silently kill every script with that shape
		const message = `Stomp could not rewrite ${url}: ${String(error)}`;
		console.warn(message);
		// unless the host asked for a loud failure (allowInvalidJs: false)
		if (config.allowInvalidJs === false)
			return `throw new SyntaxError(${JSON.stringify(message)});`;
		return script;
	}
}

/**
 * Which keys of an object pattern read an unforgeable, at any depth:
 * `{ top }` gives `{ top: true }`, `{ a: { location: l } }` gives
 * `{ a: { location: true } }`. The runtime `pattern()` wraps the source so
 * those reads resolve like member reads. Null when the pattern reads none
 * (or is not an object pattern: array patterns read through the iterator,
 * which a proxy cannot redirect).
 */
type PatternSpec = { [key: string]: true | PatternSpec };

function patternSpec(
	pattern: any,
	routed: readonly string[] = UNDEFINABLE,
): PatternSpec | null {
	if (!pattern || pattern.type !== 'ObjectPattern') return null;
	const spec: PatternSpec = {};
	let any = false;
	for (const property of pattern.properties) {
		if (property.type !== 'Property') continue;
		// a computed key may name anything (the client's global too): the
		// source is wrapped, so the read resolves like a computed member read
		// (a pattern under it is not wrapped again: no spec can name its key)
		if (property.computed) {
			any = true;
			continue;
		}
		const key = property.key;
		const name =
			key.type === 'Identifier'
				? key.name
				: key.type === 'Literal'
					? String(key.value)
					: '';
		const value =
			property.value.type === 'AssignmentPattern'
				? property.value.left
				: property.value;
		const nested = patternSpec(value, routed);
		if (nested) {
			spec[name] = nested;
			any = true;
		} else if (routed.includes(name)) {
			spec[name] = true;
			any = true;
		}
	}
	return any ? spec : null;
}

function specLiteral(spec: PatternSpec): any {
	return b.objectExpression(
		Object.entries(spec).map(([key, value]) =>
			b.property(
				'init',
				b.literal(key),
				value === true ? b.literal(true) : specLiteral(value),
			),
		),
	);
}

/** `$s$j.pattern(source, spec)` */
function patternCall(source: any, spec: PatternSpec, access: string): any {
	return b.callExpression(
		b.memberExpression(b.identifier(access), b.identifier('pattern')),
		[source, specLiteral(spec)],
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
) {
	if (
		node.type === 'Literal' &&
		typeof node.bigint === 'string' &&
		node.raw === undefined
	) {
		node.raw = `${node.bigint}n`;
		return;
	}
	hoistParamPatterns(node, access, routed, functions);
}

function hoistParamPatterns(
	node: any,
	access: string,
	routed: readonly string[],
	functions: any[],
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
				if (item && typeof item.type === 'string')
					prepareTree(item, access, routed, functions);
			}
		} else if (typeof value.type === 'string')
			prepareTree(value, access, routed, functions);
	}
	if (MARKED.has(node.type)) functions.push(node);

	if (
		node.type !== 'FunctionDeclaration' &&
		node.type !== 'FunctionExpression' &&
		node.type !== 'ArrowFunctionExpression'
	)
		return;

	const hoisted: any[] = [];
	node.params = node.params.map((param: any, index: number) => {
		const isDefault = param.type === 'AssignmentPattern';
		const target = isDefault ? param.left : param;
		if (!patternSpec(target, routed)) return param;
		const names = boundNames(target);
		if (node.params.slice(index + 1).some((p: any) => mentions(p, names)))
			return param;
		const temp = b.identifier(`${PARAM_TEMP}${index}`);
		hoisted.push(b.variableDeclarator(target, b.identifier(temp.name)));
		return isDefault ? b.assignmentPattern(temp, param.right) : temp;
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
		body[at].expression.type === 'Literal' &&
		typeof body[at].expression.value === 'string'
	)
		at++;
	body.splice(at, 0, b.variableDeclaration('var', hoisted));
}

/** a URL-like specifier: absolute, scheme-relative, or starting with `/`, `./`, `../` */
const BARE_SPECIFIER = /^(?!\/|\.\.?\/|[a-z][a-z0-9+.-]*:)/i;

/** `react`, `#private`, `@scope/pkg`: not a URL, resolved by an import map */
export function isBareSpecifier(specifier: string): boolean {
	return BARE_SPECIFIER.test(specifier);
}

/**
 * An import map's targets, routed as modules: bare specifiers stay bare and
 * reach the browser's map, the URL they map to is proxied. Entries ending in
 * `/` (package prefixes) and scope keys are URL prefixes the browser matches
 * against module URLs, which a routed URL does not preserve, so they are
 * left as written (a known limitation). Invalid JSON is left alone too.
 */
export function rewriteImportMap(
	json: string,
	url: StompURL,
	config: Config,
): string {
	let map: {
		imports?: Record<string, string>;
		scopes?: Record<string, Record<string, string>>;
		integrity?: Record<string, string>;
	};
	try {
		map = JSON.parse(json);
	} catch (error) {
		return json;
	}
	if (typeof map !== 'object' || map === null) return json;
	const route = (entries: Record<string, string> | undefined) => {
		if (typeof entries !== 'object' || entries === null) return;
		for (const [specifier, target] of Object.entries(entries)) {
			if (
				typeof target !== 'string' ||
				specifier.endsWith('/') ||
				target.endsWith('/') ||
				// already routed (a second pass): the JS route is `js:<type>/`
				target.includes(`${url.directory}js:`)
			)
				continue;
			try {
				entries[specifier] = routeJS(
					new StompURL(new URL(target, url.toString()), url),
					url,
					config,
					'genericModule',
				);
			} catch (error) {
				// not a URL: the browser reports it
			}
		}
	};
	route(map.imports);
	if (typeof map.scopes === 'object' && map.scopes !== null)
		for (const scope of Object.values(map.scopes)) route(scope);
	return JSON.stringify(map);
}

/**
 * Where the text a script's functions read back as is kept
 * (src/functionSource.ts). A whole script needs none of it: its own text is
 * kept, by its own key.
 */
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
