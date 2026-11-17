// The esbuild transform that hands the inject bundles' calls of String and
// Array methods to helpers of their own (`own$<method>`, made by
// `ownMethodsSource` below and evaluated as the end of
// src/inject/snapshot.ts, a file every module of a bundle has the names
// of). A page can replace any of String.prototype's and Array.prototype's
// methods (a polyfill does; a hostile page made String.prototype.toLowerCase
// answer 'text/plain', and the inject then took every script type for a
// data block and ran none of the scripts it should have), and
// `value.toLowerCase()` asks the realm's current one each time. The helper
// calls the method the bundle took as it loaded, before any page script
// ran, when the receiver is what it is a method of: a string (typeof), or
// an array (Array.isArray). Anything else (a Map's forEach, a Blob's slice,
// location.replace, a String object, an array-like) is called as written,
// by its own method. An Array method that makes an array of its receiver's
// realm (map, filter, slice, splice, concat, flat, flatMap) takes the native only for an array of the bundle's realm (by its
// prototype): an about:blank child runs its creator's bundle, and an array
// of the child's must give the child's arrays back, as its own method does.
//
// `receiver.method(args)` becomes `own$method(receiver, args)`; the
// receiver and the arguments are evaluated in the same order, and the
// method is read after the arguments (only a receiver whose method is read
// as written can tell, and only by a getter). Left as written: an optional
// call or a call in an optional chain, `super.method()`, a computed member
// (`value['slice'](...)`), module top level in a bundle (it runs as the
// bundle loads, before any page script), and a statement whose comment says
// `own-methods: as written`.
import ts from 'typescript';

const AS_WRITTEN = 'own-methods: as written';

// The methods the inject's sources call, by where the native comes from:
// String, Array, Array for one that makes an array of its receiver's realm,
// both (a string first). A name not listed is called as written: one the
// sources start calling goes in a list (a helper of a method nothing calls
// would be bytes and heap in every frame).
const STRING = [
	'charCodeAt',
	'codePointAt',
	'endsWith',
	'isWellFormed',
	'match',
	'matchAll',
	'padStart',
	'repeat',
	'replace',
	'replaceAll',
	'search',
	'split',
	'startsWith',
	'toLowerCase',
	'toUpperCase',
	'toWellFormed',
	'trim',
	'trimEnd',
	'trimStart',
];
const ARRAY = [
	'copyWithin',
	'every',
	'fill',
	'find',
	'findIndex',
	'forEach',
	'join',
	'pop',
	'push',
	'reduce',
	'reverse',
	'shift',
	'some',
	'sort',
	'unshift',
];
const ARRAY_MADE = ['filter', 'flat', 'flatMap', 'map', 'splice'];
const BOTH = ['at', 'includes', 'indexOf', 'lastIndexOf'];
const BOTH_MADE = ['concat', 'slice'];

const KINDS = [
	['string', STRING],
	['array', ARRAY],
	['arrayMade', ARRAY_MADE],
	['both', BOTH],
	['bothMade', BOTH_MADE],
];
export const METHODS = new Set(KINDS.flatMap(([, names]) => names));

/**
 * The helpers' source, appended to src/inject/snapshot.ts after
 * src/ownIterable.ts (whose `apply`, `isArray` and `protoOf` it uses): each
 * native is taken as the bundle loads. One function declaration a method,
 * which does all of its work: function declarations of one scope share its
 * context, and a helper that called another (one a kind) cost each frame
 * about 4 KB more of heap (frame-cost), the second function's state.
 */
export function ownMethodsSource() {
	let out = `
// (scripts/ownMethods.mjs: the inject's String and Array method calls)
const ownStringMethods = String.prototype as any;
const ownArrayMethods = Array.prototype as any;
/** \`receiver[name](...args)\` as written, by the receiver's own method */
function ownAsWritten(receiver: any, name: string, args: any[]): any {
	const method = receiver[name];
	return typeof method === 'function'
		? apply(method, receiver, args)
		: receiver[name]();
}
`;
	for (const [kind, names] of KINDS)
		for (const name of names) {
			const tests = [];
			if (kind === 'string' || kind.startsWith('both')) {
				out += `const ownString$${name} = ownStringMethods.${name};\n`;
				tests.push(
					`typeof receiver === 'string'\n\t\t? apply(ownString$${name}, receiver, args)`,
				);
			}
			if (kind !== 'string') {
				out += `const ownArray$${name} = ownArrayMethods.${name};\n`;
				// (an array of another realm's makes that realm's arrays: as
				// written)
				tests.push(
					`${
						kind.endsWith('ade')
							? 'isArray(receiver) && protoOf(receiver) === ownArrayMethods'
							: 'isArray(receiver)'
					}\n\t\t? apply(ownArray$${name}, receiver, args)`,
				);
			}
			out += `export function own$${name}(receiver: any, ...args: any[]): any {
	return ${tests.join('\n\t\t: ')}
		: ownAsWritten(receiver, '${name}', args);
}
`;
		}
	// (what the WebRTC library is handed, src/inject/dom/modules/WebRTC.ts:
	// made when it is evaluated)
	out += `export function ownMethodHelpers(): Record<string, Function> {
	return { ${[...METHODS].map((name) => `${name}: own$${name}`).join(', ')} };
}
`;
	return out;
}

/**
 * The helpers' names in a library the inject evaluates after the page's
 * scripts ran (the WebRTC library, src/inject/dom/rtcStackGlobals.ts): the
 * bundle's own, from the table `table` names (ownMethodHelpers)
 */
export function ownMethodsFrom(table) {
	return `const ownMethodTable = ${table};
${[...METHODS].map((name) => `export const own$${name} = ownMethodTable.${name};`).join('\n')}
`;
}

/** the text of `file` with its method calls handed to the helpers, or null */
export function ownMethods(text, file, { topLevel = true } = {}) {
	const source = ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.Latest,
		true,
		/\.ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS,
	);
	const edits = [];
	let loading = false;
	const asWritten = (node) =>
		ts.isStatement(node) &&
		ts
			.getLeadingCommentRanges(text, node.getFullStart())
			?.some((range) => text.slice(range.pos, range.end).includes(AS_WRITTEN));
	const visit = (node) => {
		if (asWritten(node)) return;
		if (
			!loading &&
			ts.isCallExpression(node) &&
			!ts.isOptionalChain(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			!ts.isOptionalChain(node.expression) &&
			ts.isIdentifier(node.expression.name) &&
			METHODS.has(node.expression.name.text) &&
			node.expression.expression.kind !== ts.SyntaxKind.SuperKeyword
		) {
			const receiver = node.expression.expression;
			edits.push([
				receiver.getStart(source),
				`own$${node.expression.name.text}(`,
			]);
			// `.method<T>(` becomes `, ` (or nothing, with no argument)
			edits.push([
				receiver.end,
				node.arguments.length ? ', ' : '',
				node.arguments.pos - receiver.end,
			]);
		}
		const was = loading;
		if (
			ts.isFunctionLike(node) ||
			(ts.isPropertyDeclaration(node) &&
				!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword))
		)
			loading = false;
		ts.forEachChild(node, visit);
		loading = was;
	};
	loading = !topLevel;
	visit(source);
	if (!edits.length) return null;
	// (from the end; at one position the earlier-pushed, outer, call's
	// insertion ends up first)
	const ordered = edits
		.map((edit, order) => ({
			at: edit[0],
			text: edit[1],
			cut: edit[2] ?? 0,
			order,
		}))
		.sort((a, b) => b.at - a.at || b.order - a.order);
	let out = text;
	for (const edit of ordered)
		out = out.slice(0, edit.at) + edit.text + out.slice(edit.at + edit.cut);
	return out;
}
