// The esbuild plugin that hands what the inject bundles' syntax iterates to
// `ownIterable` of src/inject/snapshot.ts (its comment says why), a name the
// bundles' injected snapshot gives every file. Every `for...of`, spread
// and `yield*`, every array destructuring's source, and the iterable of
// Array.from, Object.fromEntries, Promise.all (allSettled, race, any) and the
// Map, Set, WeakMap and WeakSet constructors becomes `ownIterable(<it>)`. An
// array pattern with nothing to wrap (a parameter's, a loop variable's, one
// inside another pattern) is read by index instead (`[a, , b]` is
// `{ 0: a, 2: b }`): what such patterns take apart is a tuple. A pattern the
// plugin cannot read that way (a rest element) and an array destructuring
// whose value is used fail the build, at their place. A statement whose
// comment says `own-iteration: as written` is left as it is (code whose
// syntax is the point: the error message probes of src/inject/errorMessages.ts).
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const NAME = 'ownIterable';
const ITEMS = 'ownItems';
const AS_WRITTEN = 'own-iteration: as written';
const CALLS = new Set([
	'Array.from',
	'Object.fromEntries',
	'Promise.all',
	'Promise.allSettled',
	'Promise.race',
	'Promise.any',
]);
const CONSTRUCTORS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);

/** the text of `file` with its iteration handed to the helper, or null */
export function ownIteration(text, file, { topLevel = true } = {}) {
	const source = ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.Latest,
		true,
		/\.ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS,
	);
	const edits = [];
	const problems = [];
	const at = (node) => {
		const { line, character } = source.getLineAndCharacterOfPosition(
			node.getStart(source),
		);
		return `${file}:${line + 1}:${character + 1}`;
	};
	// (whether the node being visited runs only as its module is evaluated)
	let loading = false;
	const wrap = (node, how = '') => {
		if (loading) return;
		// a list written out (`for (const name of ['src', 'href'])`) is
		// handed over as arguments: `ownItems('src', 'href')`
		if (
			!how &&
			ts.isArrayLiteralExpression(node) &&
			!node.elements.some(
				(element) =>
					ts.isSpreadElement(element) || ts.isOmittedExpression(element),
			)
		) {
			edits.push([node.getStart(source), `/* @__PURE__ */ ${ITEMS}(`, 1]);
			edits.push([node.end - 1, ')', 1]);
			return;
		}
		edits.push([node.getStart(source), `/* @__PURE__ */ ${NAME}(`]);
		edits.push([node.end, how ? `, ${how})` : ')']);
	};
	// an array pattern (binding or assignment) read by index
	const byIndex = (node) => {
		if (loading) return;
		const elements = node.elements;
		edits.push([node.getStart(source), '{', 1]);
		edits.push([node.end - 1, '}', 1]);
		elements.forEach((element, index) => {
			if (ts.isOmittedExpression(element)) {
				// the hole and its comma
				const next = elements[index + 1];
				edits.push([
					element.pos,
					'',
					(next ? next.pos : element.end) - element.pos,
				]);
				return;
			}
			if (
				(ts.isBindingElement(element) && element.dotDotDotToken) ||
				ts.isSpreadElement(element)
			) {
				problems.push(`${at(element)}: a rest element in an array pattern`);
				return;
			}
			edits.push([element.getStart(source), `${index}: `]);
		});
	};
	// assignment targets: an array literal there is a pattern
	const targets = new Set();
	const markTarget = (node) => {
		node = skipParens(node);
		if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node))
			targets.add(node);
	};
	const skipParens = (node) => {
		while (ts.isParenthesizedExpression(node)) node = node.expression;
		return node;
	};
	// the patterns inside a pattern (the outer one's source is wrapped)
	const nested = (pattern) => {
		const each = (element) => {
			if (ts.isOmittedExpression(element)) return;
			const name = element.name;
			if (name && ts.isArrayBindingPattern(name)) {
				byIndex(name);
				nested(name);
			} else if (name && ts.isObjectBindingPattern(name)) nested(name);
		};
		pattern.elements.forEach(each);
	};
	const nestedTargets = (literal) => {
		for (const element of literal.elements ?? literal.properties) {
			let value = element;
			if (ts.isPropertyAssignment(element)) value = element.initializer;
			else if (ts.isShorthandPropertyAssignment(element)) continue;
			else if (ts.isSpreadElement(element) || ts.isSpreadAssignment(element))
				value = element.expression;
			if (
				ts.isBinaryExpression(value) &&
				value.operatorToken.kind === ts.SyntaxKind.EqualsToken
			)
				value = value.left;
			value = skipParens(value);
			if (ts.isArrayLiteralExpression(value)) {
				targets.add(value);
				byIndex(value);
				nestedTargets(value);
			} else if (ts.isObjectLiteralExpression(value)) {
				targets.add(value);
				nestedTargets(value);
			}
		}
	};
	const callName = (callee) => {
		if (ts.isIdentifier(callee)) return callee.text;
		if (
			ts.isPropertyAccessExpression(callee) &&
			ts.isIdentifier(callee.expression)
		)
			return `${callee.expression.text}.${callee.name.text}`;
		return '';
	};
	const asWritten = (node) =>
		(ts.isVariableStatement(node) || ts.isFunctionDeclaration(node)) &&
		ts
			.getLeadingCommentRanges(text, node.getFullStart())
			?.some((range) => text.slice(range.pos, range.end).includes(AS_WRITTEN));
	const visit = (node) => {
		if (asWritten(node)) return;
		if (ts.isForOfStatement(node)) {
			const head = node.initializer;
			// (a loop variable that is an array pattern takes each value apart:
			// each is handed over too)
			const pattern =
				ts.isVariableDeclarationList(head) &&
				ts.isArrayBindingPattern(head.declarations[0].name);
			if (!node.awaitModifier) wrap(node.expression, pattern ? 2 : '');
			if (ts.isVariableDeclarationList(head)) {
				for (const declaration of head.declarations)
					if (
						ts.isArrayBindingPattern(declaration.name) ||
						ts.isObjectBindingPattern(declaration.name)
					)
						nested(declaration.name);
			} else {
				const target = skipParens(head);
				if (ts.isArrayLiteralExpression(target)) {
					targets.add(target);
					byIndex(target);
					nestedTargets(target);
				} else if (ts.isObjectLiteralExpression(target)) {
					targets.add(target);
					nestedTargets(target);
				}
			}
		} else if (ts.isForInStatement(node)) {
			markTarget(node.initializer);
		} else if (
			ts.isVariableDeclaration(node) &&
			!ts.isForOfStatement(node.parent.parent) &&
			!ts.isForInStatement(node.parent.parent)
		) {
			const name = node.name;
			if (ts.isArrayBindingPattern(name)) {
				if (node.initializer) wrap(node.initializer);
				nested(name);
			} else if (ts.isObjectBindingPattern(name)) nested(name);
		} else if (ts.isParameter(node)) {
			if (ts.isArrayBindingPattern(node.name)) {
				byIndex(node.name);
				nested(node.name);
			} else if (ts.isObjectBindingPattern(node.name)) nested(node.name);
		} else if (ts.isCatchClause(node)) {
			const name = node.variableDeclaration?.name;
			if (name && ts.isArrayBindingPattern(name)) {
				byIndex(name);
				nested(name);
			}
		} else if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken
		) {
			const left = skipParens(node.left);
			if (ts.isArrayLiteralExpression(left)) {
				targets.add(left);
				nestedTargets(left);
				let parent = node.parent;
				while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
				if (!ts.isExpressionStatement(parent) && !loading)
					problems.push(
						`${at(node)}: the value of an array destructuring is used`,
					);
				wrap(node.right);
			} else if (ts.isObjectLiteralExpression(left)) {
				targets.add(left);
				nestedTargets(left);
			}
		} else if (ts.isSpreadElement(node)) {
			const parent = node.parent;
			if (
				!loading &&
				ts.isArrayLiteralExpression(parent) &&
				!targets.has(parent) &&
				parent.elements.length === 1
			) {
				// `[...value]`: the helper's copy of it
				const start = parent.getStart(source);
				const inner = node.expression;
				edits.push([
					start,
					`/* @__PURE__ */ ${NAME}(`,
					inner.getStart(source) - start,
				]);
				edits.push([inner.end, ', 1)', parent.end - inner.end]);
			} else if (
				!(ts.isArrayLiteralExpression(parent) && targets.has(parent)) &&
				(ts.isArrayLiteralExpression(parent) ||
					ts.isCallExpression(parent) ||
					ts.isNewExpression(parent))
			)
				wrap(node.expression);
		} else if (ts.isYieldExpression(node) && node.asteriskToken) {
			wrap(node.expression);
		} else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
			const name = callName(node.expression);
			const first = node.arguments?.[0];
			if (
				first &&
				!ts.isSpreadElement(first) &&
				(ts.isCallExpression(node) ? CALLS.has(name) : CONSTRUCTORS.has(name))
			)
				wrap(first);
		}
		const was = loading;
		// what runs later: a function's body, an instance field's initializer
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
	if (problems.length)
		throw new Error(
			`iteration the inject cannot hand to ownIterable:\n${problems.join('\n')}`,
		);
	if (!edits.length) return null;
	// (from the end, so each position still holds; at one position the
	// later-pushed insertion goes first, so `[...[a]]` nests its wraps)
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

/**
 * @param {string[]} skip files left as they are: the snapshots, which
 *   define the helper and iterate only as the bundle loads
 * @param {boolean} topLevel whether a module's own statements are handed
 *   over too: not in a bundle, which evaluates every module as it loads,
 *   before any page script (a constant table there stays one esbuild can
 *   drop when nothing reads it); in the deferred parts, which may be
 *   evaluated after the page's scripts ran
 * @returns {import('esbuild').Plugin}
 */
export const ownIterationPlugin = (skip, topLevel) => ({
	name: 'own-iteration',
	setup(pluginBuild) {
		pluginBuild.onLoad({ filter: /\.(ts|js|mjs)$/ }, async (args) => {
			if (skip.includes(args.path)) return undefined;
			const text = await readFile(args.path, 'utf8');
			const out = ownIteration(text, args.path, { topLevel });
			if (out === null) return undefined;
			return {
				contents: out,
				loader: /\.ts$/.test(args.path) ? 'ts' : 'js',
			};
		});
	},
});
