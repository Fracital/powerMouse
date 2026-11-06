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

		// const catchLoop = 0;

		for (const ctx of new AcornIterator(tree)) {
			typeLoop: switch (ctx.node.type) {
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
									: b.identifier('undefined'),
								ctx.node.source,
							],
						),
					);

					break;
				case 'VariableDeclarator':
					// `const { top: t } = o`: the pattern reads `o.top` without a
					// member expression to rewrite, so the source is wrapped and the
					// reads resolve through it (shallow: nested patterns read raw)
					if (
						ctx.node.id.type === 'ObjectPattern' &&
						ctx.node.init &&
						patternReadsUnforgeable(ctx.node.id)
					)
						ctx.replaceWith(
							b.variableDeclarator(
								ctx.node.id,
								b.callExpression(
									b.memberExpression(
										b.identifier(ACCESS_KEY),
										b.identifier('pattern'),
									),
									[result(ctx.node.init)],
								),
							),
						);
					break;
				case 'AssignmentExpression':
					if (
						ctx.node.left.type === 'ObjectPattern' &&
						patternReadsUnforgeable(ctx.node.left)
					)
						ctx.replaceWith(
							b.assignmentExpression(
								'=',
								ctx.node.left,
								b.callExpression(
									b.memberExpression(
										b.identifier(ACCESS_KEY),
										b.identifier('pattern'),
									),
									[result(ctx.node.right)],
								),
							),
						);
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
			? `(0, eval)(await (await fetch(${JSON.stringify(injectWorkerJS(url))})).text());`
			: `importScripts(${JSON.stringify(injectWorkerJS(url))});`
	}

if (!(${JSON.stringify(CLIENT_KEY)} in globalThis))
	createClient(${JSON.stringify(config)}, ${JSON.stringify(url.codec.key)});

if (!${CLIENT_KEY}.applied) 
	${CLIENT_KEY}.apply();`
				: '') +
			(isModule ? `import.meta.url = ${JSON.stringify(url.toString())};` : '') +
			generate(tree)
		);
	} catch (error) {
		// a script the rewriter cannot handle runs as it was: the browser may
		// still parse it (and rejects it the same way when it cannot), while a
		// `throw` here would silently kill every script with that shape
		console.warn(`Stomp could not rewrite ${url}: ${String(error)}`);
		return script;
	}
}

/** whether an object pattern names an unforgeable (`{ top }`, `{ location: l }`) */
function patternReadsUnforgeable(pattern: any): boolean {
	for (const property of pattern.properties) {
		if (property.type !== 'Property' || property.computed) continue;
		const key = property.key;
		const name =
			key.type === 'Identifier'
				? key.name
				: key.type === 'Literal'
					? String(key.value)
					: '';
		if (UNDEFINABLE.includes(name)) return true;
	}
	return false;
}

/** `react`, `#private`, `@scope/pkg`: not a URL, resolved by an import map */
export function isBareSpecifier(specifier: string): boolean {
	return !/^(\/|\.\.?\/|[a-z][a-z0-9+.-]*:)/i.test(specifier);
}

export function restoreJS(script: string, _url: StompURL) {
	return script;
}
