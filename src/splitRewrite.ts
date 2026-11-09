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
// Only shapes recognised here are split; anything else is rewritten whole.
import { parse } from 'meriyah';
import { PROVIDERS, UNDEFINABLE } from './rewriteJS';

/** below this a script is rewritten whole: the split's own parse costs more than it saves */
export const SPLIT_MIN = 512 * 1024;

export interface SplitPlan {
	/** the source ranges of the groups of the module table's properties */
	groups: [number, number][];
	/** the scope the modules stand in is strict */
	strict: boolean;
	/** a name no part of the script contains, for the placeholders */
	token: string;
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
		return null;
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
	if (!table || table.properties.length < parts) return null;
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
	return { groups, strict: strictScope, token };
}

/** the skeleton (a placeholder where each group was) and the groups, each a script of its own */
export function splitSources(
	script: string,
	plan: SplitPlan,
): { skeleton: string; parts: string[] } {
	let skeleton = '';
	let at = 0;
	plan.groups.forEach(([start, end], i) => {
		skeleton += `${script.slice(at, start)}"${plan.token}${i}":0`;
		at = end;
	});
	skeleton += script.slice(at);
	const prologue = plan.strict ? '"use strict";' : '';
	return {
		skeleton,
		parts: plan.groups.map(
			([start, end]) => `${prologue}({${script.slice(start, end)}});`,
		),
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
	const pieces: string[] = [];
	for (const part of parts) {
		const open = part.indexOf('({');
		if (open === -1 || !part.endsWith('});')) return null;
		pieces.push(part.slice(open + 2, -3));
	}
	let out = '';
	let at = 0;
	for (let i = 0; i < pieces.length; i++) {
		const marker = `'${plan.token}${i}':0`;
		const found = skeleton.indexOf(marker, at);
		if (found === -1 || skeleton.indexOf(marker, found + 1) !== -1) return null;
		out += skeleton.slice(at, found) + pieces[i];
		at = found + marker.length;
	}
	return out + skeleton.slice(at);
}
