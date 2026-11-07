import { generate } from '@javascript-obfuscator/escodegen';
import { builders as b } from 'ast-types';
import { parse } from 'meriyah';
import { AcornContext, AcornIterator, result } from './acornUtil';
import { Config } from './config';
import {
	createDataURI,
	injectWorkerJS,
	parseDataURI,
	routeURL,
} from './routeURL';
import StompURL from './StompURL';

export const ACCESS_KEY = '$s$j';
export const GLOBAL_PROXY = '$s$L';
export const GLOBAL_NAME = '$s$N';
export const CLIENT_KEY = '$P$s';

// smaller range inside larger range = invalidates larger range
// smaller modifications called later in script

export const PROVIDERS = ['window', 'document'];
export const UNDEFINABLE = ['eval', 'location', 'top'];

const cTarget = 't$t';
const cProp = 't$p';
const cValue = 't$v';

function generatePartial(script: string, ctx: AcornContext) {
	let result = ctx.node.range
		? script.slice(ctx.node.range[0], ctx.node.range[1])
		: generate(ctx.node);

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

export function routeJS(
	resource: StompURL,
	url: StompURL,
	config: Config,
	type: ScriptType = 'generic',
) {
	if (resource.url.protocol === 'data:') {
		const { mime, data, attributes } = parseDataURI(resource.url.pathname);
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
) {
	try {
		const isModule = type === 'genericModule' || type === 'workerModule';
		const isWorker = type === 'workerModule' || type === 'worker';

		const tree = parse(script, {
			module: isModule,
			next: true,
			ranges: true,
			globalReturn: true,
			webcompat: true,
		});

		// destructured parameters become plain ones with the pattern moved into
		// the body, where the main pass wraps its source like any declaration
		hoistParamPatterns(tree);

		for (const ctx of new AcornIterator(tree)) {
			typeLoop: switch (ctx.node.type) {
				case 'DebuggerStatement':
					// a proxied site's anti-debugging trap, not the user's breakpoint
					ctx.replaceWith(b.emptyStatement());
					break;
				case 'ImportExpression':
					// todo: add tompc$.import(meta, url)
					ctx.replaceWith(
						b.callExpression(
							b.memberExpression(
								b.identifier(ACCESS_KEY),
								b.identifier('import'),
							),
							[
								isModule
									? b.memberExpression(
											b.metaProperty(
												b.identifier('import'),
												b.identifier('meta'),
											),
											b.identifier('url'),
										)
									: // a classic script resolves against its own URL, which
										// only the rewriter knows
										b.literal(url.toString()),
								ctx.node.source,
							],
						),
					);

					break;
				case 'VariableDeclarator':
					// `const { top: t } = o`, `const { a: { top } } = o`: the pattern
					// reads `o.top` without a member expression to rewrite, so the
					// source is wrapped and the reads resolve through it, at every
					// depth the pattern names an unforgeable
					{
						const spec =
							ctx.node.init && !isPatternCall(ctx.node.init)
								? patternSpec(ctx.node.id)
								: null;
						if (spec)
							ctx.replaceWith(
								b.variableDeclarator(
									ctx.node.id,
									patternCall(result(ctx.node.init), spec),
								),
							);
					}
					break;
				case 'AssignmentExpression':
					{
						const spec = patternSpec(ctx.node.left);
						if (spec)
							ctx.replaceWith(
								b.assignmentExpression(
									'=',
									ctx.node.left,
									patternCall(result(ctx.node.right), spec),
								),
							);
					}
					break;
				case 'ImportDeclaration':
				case 'ExportAllDeclaration':
				case 'ExportNamedDeclaration':
					// a bare specifier (`import x from "react"`) is the import
					// map's to resolve: leave it, or `new URL` throws and the whole
					// module is lost
					if (ctx.node.source && !isBareSpecifier(ctx.node.source.value))
						ctx.node.source = b.literal(
							routeJS(
								new StompURL(
									new URL(ctx.node.source.value, url.toString()),
									url,
								),
								url,
								config,
								'genericModule',
							),
						);
					break;
				case 'CallExpression':
					{
						const { callee } = ctx.node;

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
									b.binaryExpression(
										'===',
										b.identifier('eval'),
										b.memberExpression(
											b.identifier(ACCESS_KEY),
											b.identifier('evalSnapshot'),
										),
									),
									b.callExpression(b.identifier('eval'), [
										b.callExpression(
											b.memberExpression(
												b.identifier(ACCESS_KEY),
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
						if (!UNDEFINABLE.includes(ctx.node.name)) break;

						if (
							ctx.parent?.node.type === 'UpdateExpression' ||
							(ctx.parent?.node.type === 'AssignmentExpression' &&
								ctx.parentKey === 'left')
						) {
							ctx.parent.replaceWith(
								b.callExpression(
									b.memberExpression(
										b.identifier(ACCESS_KEY),
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
										b.identifier(ACCESS_KEY),
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
								if (!UNDEFINABLE.includes(ctx.node.property.value)) {
									break typeLoop;
								}
							}
						} else
							switch (ctx.node.property.type) {
								case 'Identifier':
									if (!UNDEFINABLE.includes(ctx.node.property.name)) {
										break typeLoop;
									}

									break;
								case 'Literal':
									if (!UNDEFINABLE.includes(ctx.node.property.value)) {
										break typeLoop;
									}

									break;
							}

						// if not computed (object.property), make property a string
						// computed is object[property]

						let propertyArgument;

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
										b.identifier(ACCESS_KEY),
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
							ctx.parentKey === 'callee'
						) {
							ctx.parent!.replaceWith(
								b.callExpression(
									b.memberExpression(
										b.identifier(ACCESS_KEY),
										b.identifier('call2'),
									),
									[
										result(ctx.node.object),
										propertyArgument,
										result(b.arrayExpression(ctx.parent!.node.arguments)),
										b.literal(generatePartial(script, ctx.parent!)),
										...(ctx.node.optional || ctx.parent!.node.optional
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
										b.identifier(ACCESS_KEY),
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
										ctx.parent?.node.type === 'UpdateExpression'
											? b.identifier('undefined')
											: ctx.parent!.node.right,
										b.literal(generatePartial(script, ctx.parent!)),
									],
								),
							);
						} else {
							// a?.[k]: get2 short-circuits on a nullish object, and the
							// rest of the chain must keep short-circuiting on undefined
							if (ctx.node.optional && ctx.parent) {
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
										b.identifier(ACCESS_KEY),
										b.identifier('get2'),
									),
									[
										result(ctx.node.object),
										propertyArgument,
										b.literal(generatePartial(script, ctx)),
										...(ctx.node.optional ? [b.literal(true)] : []),
									],
								),
							);
						}
					}
					break;
			}
		}

		return (
			// a module worker has no importScripts: fetch the bundle and run it
			// as the classic script it is (indirect eval, top-level await)
			(isWorker
				? `if (!globalThis.createClient)
	${
		type === 'workerModule'
			? `(0, eval)(await (await fetch(${JSON.stringify(injectWorkerJS(url, config))})).text());`
			: `importScripts(${JSON.stringify(injectWorkerJS(url, config))});`
	}

if (!(${JSON.stringify(CLIENT_KEY)} in globalThis))
	createClient(${JSON.stringify(config)}, ${JSON.stringify(url.codec.key)});

if (!${CLIENT_KEY}.applied) 
	${CLIENT_KEY}.apply();`
				: '') +
			// import.meta.resolve answers with the page's URLs; a bare specifier
			// belongs to the import map and comes back as it is
			(isModule
				? `import.meta.url = ${JSON.stringify(url.toString())};import.meta.resolve = (s) => ${BARE_SPECIFIER}.test(s = String(s)) ? s : new URL(s, import.meta.url).href;`
				: '') +
			generate(tree)
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

function patternSpec(pattern: any): PatternSpec | null {
	if (!pattern || pattern.type !== 'ObjectPattern') return null;
	const spec: PatternSpec = {};
	let any = false;
	for (const property of pattern.properties) {
		if (property.type !== 'Property' || property.computed) continue;
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
		const nested = patternSpec(value);
		if (nested) {
			spec[name] = nested;
			any = true;
		} else if (UNDEFINABLE.includes(name)) {
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
function patternCall(source: any, spec: PatternSpec): any {
	return b.callExpression(
		b.memberExpression(b.identifier(ACCESS_KEY), b.identifier('pattern')),
		[source, specLiteral(spec)],
	);
}

function isPatternCall(node: any): boolean {
	return (
		node.type === 'CallExpression' &&
		node.callee.type === 'MemberExpression' &&
		node.callee.object.type === 'Identifier' &&
		node.callee.object.name === ACCESS_KEY &&
		node.callee.property.type === 'Identifier' &&
		node.callee.property.name === 'pattern'
	);
}

/** every child node of an ESTree node, in source order */
function* children(node: any): Generator<any> {
	for (const key in node) {
		if (key === 'range' || key === 'loc') continue;
		const value = node[key];
		if (typeof value !== 'object' || value === null) continue;
		if (Array.isArray(value)) {
			for (const item of value)
				if (item && typeof item.type === 'string') yield item;
		} else if (typeof value.type === 'string') yield value;
	}
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
	for (const child of children(node)) if (mentions(child, names)) return true;
	return false;
}

const PARAM_TEMP = `${ACCESS_KEY}a`;

/**
 * `function f({ top: t }) {}`: a parameter pattern has no source expression
 * to wrap, so the parameter becomes a plain one and the pattern a `var`
 * declaration at the top of the body (after the directive prologue), whose
 * source the main pass wraps. `var` matches a parameter's scoping; the
 * default value stays on the parameter. Left alone when a later parameter
 * refers to a name the pattern binds. (`'use strict'` cannot appear in such
 * a function, but other directives can, so the prologue is skipped.)
 */
function hoistParamPatterns(node: any) {
	for (const child of children(node)) hoistParamPatterns(child);

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
		if (!patternSpec(target)) return param;
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

export function restoreJS(script: string, _url: StompURL) {
	return script;
}
