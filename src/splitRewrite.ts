// A large webpack bundle rewritten by several rewrite workers at once: one
// file is otherwise one worker's work, and Discord's 13 MB main bundle took
// three and a half seconds in one, the longest wait of its page.
//
// The module table, an object of module functions, is cut into groups. Each
// group is rewritten on its own as `({...});`, and the rest of the script
// (the skeleton) with a placeholder property where each group was; the
// placeholders are then replaced by the groups' output. A module function
// is rewritten the same wherever it stands (the rewriter decides by the code
// inside it), so the result is byte for byte what one rewrite of the whole
// would make, as long as everything is printed compact, as minified code is.
// A Closure module bundle (YouTube, Google Docs) is cut into runs of its
// function's statements instead (planStatements). Only shapes recognised
// here are split; anything else is rewritten whole.
import { parse } from 'meriyah';
import { sourceKey } from './functionSource';
import { PROVIDERS, UNDEFINABLE, type ScriptSource } from './rewriteJS';

/** below this a script is rewritten whole: the split's own parse costs more than it saves */
export const SPLIT_MIN = 512 * 1024;

export interface SplitPlan {
	/**
	 * what the groups are: properties of a webpack module table (the
	 * default), or runs of statements of a Closure module's function body
	 */
	kind?: 'statements';
	/** the source ranges of the groups of the module table's properties */
	groups: [number, number][];
	/** the scope the modules stand in is strict */
	strict: boolean;
	/** a name no part of the script contains, for the placeholders */
	token: string;
	/** the key the whole script's text is kept by (src/functionSource.ts) */
	key: string;
}

// names the rewriter treats as the window's: a module that saw one bound
// around it is not split (the rewriter decides by name, so this is caution)
const OUTER = new Set([
	...UNDEFINABLE,
	...PROVIDERS,
	'parent',
	'self',
	'globalThis',
	'frames',
	'opener',
	'postMessage',
]);

function bindings(pattern: any, out: string[]) {
	switch (pattern?.type) {
		case 'Identifier':
			out.push(pattern.name);
			break;
		case 'ObjectPattern':
			for (const property of pattern.properties)
				bindings(
					property.type === 'RestElement' ? property.argument : property.value,
					out,
				);
			break;
		case 'ArrayPattern':
			for (const element of pattern.elements) bindings(element, out);
			break;
		case 'AssignmentPattern':
			bindings(pattern.left, out);
			break;
		case 'RestElement':
			bindings(pattern.argument, out);
			break;
	}
}

/** the names a scope's statements declare, not looking into nested functions */
function declared(node: any, out: string[]) {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const item of node) declared(item, out);
		return;
	}
	if (typeof node.type !== 'string') return;
	if (node.type.includes('Function')) {
		if (node.type === 'FunctionDeclaration') bindings(node.id, out);
		return;
	}
	if (node.type === 'VariableDeclarator' || node.type === 'ClassDeclaration')
		bindings(node.id, out);
	if (node.type === 'CatchClause') bindings(node.param, out);
	for (const key in node)
		if (key !== 'range' && key !== 'loc') declared(node[key], out);
}

const strict = (body: any[]) =>
	body.some(
		(statement) =>
			statement.type === 'ExpressionStatement' &&
			statement.directive === 'use strict',
	);

/** a property of a module table: a module id and its function */
const isModule = (property: any) =>
	property.type === 'Property' &&
	!property.computed &&
	!property.shorthand &&
	property.kind === 'init' &&
	(property.key.type === 'Literal' || property.key.type === 'Identifier') &&
	(property.value.type === 'FunctionExpression' ||
		property.value.type === 'ArrowFunctionExpression');

/**
 * How to split `script` into `parts` groups, or null when it is not a shape
 * recognised here: the webpack runtime (an IIFE whose scope declares the
 * module table as an object) or a chunk
 * (`(self.webpackChunkX ||= []).push([[ids], {modules}, runtime?])`)
 */
export function planSplit(script: string, parts: number): SplitPlan | null {
	let tree: any;
	try {
		tree = parse(script, {
			module: false,
			next: true,
			ranges: true,
			globalReturn: true,
			webcompat: true,
		});
	} catch (error) {
		return null;
	}
	if (tree.body.length !== 1 || tree.body[0].type !== 'ExpressionStatement')
		return planStatements(script, tree, parts);
	let expression = tree.body[0].expression;
	if (expression.type === 'UnaryExpression') expression = expression.argument;
	if (expression.type !== 'CallExpression') return null;
	const outer: string[] = [];
	let strictScope = strict(tree.body);
	let table: any = null;
	const callee = expression.callee;
	if (
		(callee.type === 'ArrowFunctionExpression' ||
			callee.type === 'FunctionExpression') &&
		callee.body.type === 'BlockStatement'
	) {
		for (const param of callee.params) bindings(param, outer);
		declared(callee.body.body, outer);
		strictScope ||= strict(callee.body.body);
		for (const statement of callee.body.body)
			if (statement.type === 'VariableDeclaration')
				for (const declarator of statement.declarations)
					if (
						declarator.init?.type === 'ObjectExpression' &&
						(!table ||
							declarator.init.properties.length > table.properties.length)
					)
						table = declarator.init;
	} else if (
		callee.type === 'MemberExpression' &&
		!callee.computed &&
		callee.property.name === 'push' &&
		expression.arguments[0]?.type === 'ArrayExpression' &&
		expression.arguments[0].elements[1]?.type === 'ObjectExpression'
	)
		table = expression.arguments[0].elements[1];
	if (!table) return planStatements(script, tree, parts);
	if (table.properties.length < parts) return null;
	if (!table.properties.every(isModule)) return null;
	if (outer.some((name) => OUTER.has(name))) return null;

	const properties = table.properties;
	const size =
		properties[properties.length - 1].range[1] - properties[0].range[0];
	const groups: [number, number][] = [];
	let first = 0;
	for (let i = 0; i < properties.length; i++)
		if (
			properties[i].range[1] - properties[first].range[0] >= size / parts ||
			i === properties.length - 1
		) {
			groups.push([properties[first].range[0], properties[i].range[1]]);
			first = i + 1;
		}

	let token = '$stomp$part';
	while (script.includes(token)) token += '$';
	return { groups, strict: strictScope, token, key: sourceKey(script) };
}

/** a function expression's own, a function called directly or through .call or .apply */
function calledFunction(expression: any): any {
	if (expression?.type === 'UnaryExpression') expression = expression.argument;
	if (expression?.type !== 'CallExpression') return null;
	let callee = expression.callee;
	if (
		callee.type === 'MemberExpression' &&
		!callee.computed &&
		(callee.property.name === 'call' || callee.property.name === 'apply')
	)
		callee = callee.object;
	// an async function or a generator is not: `await` and `yield` would not
	// parse the same in the plain function a run is rewritten in
	return (callee.type === 'FunctionExpression' ||
		callee.type === 'ArrowFunctionExpression') &&
		callee.body.type === 'BlockStatement' &&
		!callee.async &&
		!callee.generator
		? callee
		: null;
}

/**
 * A Closure module (YouTube's kevlar_base, Google Docs): the program's
 * largest statement calls a function (`(function(_){var window=this;
 * try{...}catch(e){_._DumpException(e)}try{...}...}).call(this, ...)`)
 * whose body is a long list of statements, each module of the build a try
 * statement of its own. The groups are runs of sibling statements, a try
 * block too large for one group giving runs of its own statements. The
 * rewriter decides by the code itself and by names, never by the scope a
 * statement stands in, so a run is rewritten the same on its own (inside a
 * function and a block, under the same strictness) as in the whole.
 *
 * With no such function, the program's own statements are the list, when
 * they are many: CNN's 3.5 MB inline script is one module chunk after
 * another (`(self.modules=self.modules||[]).push(...)`), 1.4 s in one
 * worker, which the page's first response waited for.
 */
function planStatements(
	script: string,
	tree: any,
	parts: number,
): SplitPlan | null {
	let call: any = null;
	for (const statement of tree.body)
		if (
			statement.type === 'ExpressionStatement' &&
			calledFunction(statement.expression) &&
			(!call ||
				statement.range[1] - statement.range[0] > call.range[1] - call.range[0])
		)
			call = statement;
	const fn =
		call && call.range[1] - call.range[0] >= script.length / 2
			? calledFunction(call.expression)
			: null;
	const scope = fn ? fn.body : tree;
	// two runs per worker: a statement (a module's try block) is not cut,
	// and smaller runs even out what each worker gets
	const target = (scope.range[1] - scope.range[0]) / (parts * 2);
	const groups: [number, number][] = [];
	const take = (list: any[]) => {
		let start = -1;
		let end = -1;
		const close = () => {
			if (start !== -1) groups.push([start, end]);
			start = -1;
		};
		for (const statement of list) {
			if (
				statement.type === 'TryStatement' &&
				statement.block.range[1] - statement.block.range[0] > target
			) {
				close();
				take(statement.block.body);
				continue;
			}
			if (start === -1) start = statement.range[0];
			end = statement.range[1];
			if (end - start >= target) close();
		}
		close();
	};
	// a directive prologue of the function's own (or the program's) stays
	// with the skeleton
	const body: any[] = scope.body;
	let first = 0;
	while (
		first < body.length &&
		body[first].type === 'ExpressionStatement' &&
		typeof body[first].directive === 'string'
	)
		first++;
	// a program of a few statements is no list of modules
	if (!fn && body.length - first < parts * 2) return null;
	take(body.slice(first));
	if (groups.length < 2) return null;

	let token = '$stomp$part';
	while (script.includes(token)) token += '$';
	return {
		kind: 'statements',
		groups,
		strict: strict(tree.body) || (fn !== null && strict(fn.body.body)),
		token,
		key: sourceKey(script),
	};
}

/**
 * Where a run of statements is put to be rewritten on its own: in a function
 * and a block, as it stood, between two marker statements. The line breaks
 * keep a last statement that ends without a semicolon from running into the
 * marker (`a=b` and `$stomp$partb` would be one identifier).
 */
const statementsOpen = (plan: SplitPlan) =>
	`${plan.strict ? '"use strict";' : ''}(function(){try{${plan.token}a;\n`;
const statementsClose = (plan: SplitPlan) => `\n${plan.token}b;}catch{}});`;

/**
 * The skeleton (a placeholder where each group was) and the groups, each a
 * script of its own, with where each stands in the whole: their functions
 * read back from the whole's text, which the skeleton keeps
 */
export function splitSources(
	script: string,
	plan: SplitPlan,
): {
	skeleton: string;
	parts: string[];
	skeletonSource: ScriptSource;
	partSources: ScriptSource[];
} {
	const statements = plan.kind === 'statements';
	let skeleton = '';
	let at = 0;
	const shifts: number[] = [];
	plan.groups.forEach(([start, end], i) => {
		skeleton += `${script.slice(at, start)}${
			statements ? `${plan.token}${i};` : `"${plan.token}${i}":0`
		}`;
		// what follows the placeholder stands where the group ended
		shifts.push(skeleton.length, end - skeleton.length);
		at = end;
	});
	skeleton += script.slice(at);
	const prologue = plan.strict ? '"use strict";' : '';
	const open = statements
		? statementsOpen(plan).length
		: prologue.length + '({'.length;
	return {
		skeleton,
		parts: plan.groups.map(([start, end]) =>
			statements
				? `${statementsOpen(plan)}${script.slice(start, end)}${statementsClose(plan)}`
				: `${prologue}({${script.slice(start, end)}});`,
		),
		skeletonSource: { key: plan.key, text: script, shifts },
		partSources: plan.groups.map(([start]) => ({
			key: plan.key,
			text: null,
			shifts: [0, start - open],
		})),
	};
}

/**
 * The rewritten whole from the rewritten skeleton and groups (each printed
 * compact), or null when one is not the shape it should be
 */
export function stitch(
	skeleton: string,
	parts: string[],
	plan: SplitPlan,
): string | null {
	const statements = plan.kind === 'statements';
	const pieces: string[] = [];
	for (const part of parts) {
		if (statements) {
			// between the two marker statements, each there once
			const before = `${plan.token}a;`;
			const after = `${plan.token}b;`;
			const open = part.indexOf(before);
			const close = part.indexOf(after);
			if (
				open === -1 ||
				close < open ||
				part.indexOf(before, open + 1) !== -1 ||
				part.indexOf(after, close + 1) !== -1
			)
				return null;
			pieces.push(part.slice(open + before.length, close));
			continue;
		}
		const open = part.indexOf('({');
		if (open === -1 || !part.endsWith('});')) return null;
		pieces.push(part.slice(open + 2, -3));
	}
	let out = '';
	let at = 0;
	for (let i = 0; i < pieces.length; i++) {
		const marker = statements ? `${plan.token}${i};` : `'${plan.token}${i}':0`;
		const found = skeleton.indexOf(marker, at);
		if (found === -1 || skeleton.indexOf(marker, found + 1) !== -1) return null;
		out += skeleton.slice(at, found) + pieces[i];
		at = found + marker.length;
	}
	return out + skeleton.slice(at);
}
