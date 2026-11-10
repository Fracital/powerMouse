/**
 * The ESTree node builders the JS rewriter uses, as plain objects with the
 * fields, defaults and key order ast-types' builders give them (escodegen
 * and the rewriter's own walk read the same object either way). ast-types
 * builds its definitions of every node kind of every dialect (Flow,
 * TypeScript, Babel, JSX) when it loads: about 470 KB of heap in each realm
 * that evaluates it, which was every proxied frame.
 */

type Node = any;

const COMPUTED_KEYS = ['Literal', 'MemberExpression', 'BinaryExpression'];

export const builders = {
	identifier: (name: string): Node => ({
		name,
		loc: null,
		type: 'Identifier',
		comments: null,
		optional: false,
		typeAnnotation: null,
	}),
	memberExpression: (
		object: Node,
		property: Node,
		computed: boolean = COMPUTED_KEYS.includes(property.type),
	): Node => ({
		object,
		property,
		computed,
		loc: null,
		type: 'MemberExpression',
		comments: null,
		optional: false,
	}),
	callExpression: (callee: Node, args: Node[]): Node => ({
		callee,
		arguments: args,
		loc: null,
		type: 'CallExpression',
		comments: null,
		optional: false,
		typeParameters: null,
		typeArguments: null,
	}),
	literal: (
		value: string | boolean | null | number | RegExp | bigint,
	): Node => ({
		value,
		loc: null,
		type: 'Literal',
		comments: null,
	}),
	assignmentExpression: (operator: string, left: Node, right: Node): Node => ({
		operator,
		left,
		right,
		loc: null,
		type: 'AssignmentExpression',
		comments: null,
	}),
	arrayExpression: (elements: Node[]): Node => ({
		elements,
		loc: null,
		type: 'ArrayExpression',
		comments: null,
	}),
	arrowFunctionExpression: (
		params: Node[],
		body: Node,
		expression = false,
	): Node => ({
		params,
		body,
		expression,
		loc: null,
		type: 'ArrowFunctionExpression',
		comments: null,
		id: null,
		generator: false,
		async: false,
		defaults: [],
		rest: null,
		returnType: null,
		typeParameters: null,
		predicate: null,
	}),
	variableDeclarator: (id: Node, init: Node = null): Node => ({
		id,
		init,
		loc: null,
		type: 'VariableDeclarator',
		comments: null,
	}),
	blockStatement: (body: Node[]): Node => ({
		body,
		loc: null,
		type: 'BlockStatement',
		comments: null,
		directives: [],
	}),
	updateExpression: (
		operator: string,
		argument: Node,
		prefix: boolean,
	): Node => ({
		operator,
		argument,
		prefix,
		loc: null,
		type: 'UpdateExpression',
		comments: null,
	}),
	variableDeclaration: (kind: string, declarations: Node[]): Node => ({
		kind,
		declarations,
		loc: null,
		type: 'VariableDeclaration',
		comments: null,
	}),
	sequenceExpression: (expressions: Node[]): Node => ({
		expressions,
		loc: null,
		type: 'SequenceExpression',
		comments: null,
	}),
	returnStatement: (argument: Node): Node => ({
		argument,
		loc: null,
		type: 'ReturnStatement',
		comments: null,
	}),
	property: (kind: string, key: Node, value: Node): Node => ({
		kind,
		key,
		value,
		loc: null,
		type: 'Property',
		comments: null,
		method: false,
		shorthand: false,
		computed: false,
		decorators: null,
	}),
	objectExpression: (properties: Node[]): Node => ({
		properties,
		loc: null,
		type: 'ObjectExpression',
		comments: null,
	}),
	metaProperty: (meta: Node, property: Node): Node => ({
		meta,
		property,
		loc: null,
		type: 'MetaProperty',
		comments: null,
	}),
	expressionStatement: (expression: Node): Node => ({
		expression,
		loc: null,
		type: 'ExpressionStatement',
		comments: null,
	}),
	emptyStatement: (): Node => ({
		loc: null,
		type: 'EmptyStatement',
		comments: null,
	}),
	conditionalExpression: (
		test: Node,
		consequent: Node,
		alternate: Node,
	): Node => ({
		test,
		consequent,
		alternate,
		loc: null,
		type: 'ConditionalExpression',
		comments: null,
	}),
	assignmentPattern: (left: Node, right: Node): Node => ({
		left,
		right,
		loc: null,
		type: 'AssignmentPattern',
		comments: null,
		typeAnnotation: null,
		optional: false,
	}),
};
