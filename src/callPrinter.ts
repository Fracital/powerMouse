// V8 names the expression an error is about in the error's message (`o[k]
// is not a function`, `Cannot destructure property 'a' of 'f(...)' as it is
// undefined.`) by printing it back from its syntax tree (CallPrinter, in
// V8's src/ast/prettyprinter.cc). An error the access API
// throws for an expression the rewriter routed to it must name the page's
// expression the same way, so this prints a page's expression the way
// CallPrinter would: from the source the rewriter hands the helper, parsed
// again only when something throws.
import { parse } from 'meriyah';

const INTERMEDIATE = '(intermediate value)';

/** what CallPrinter prints for `node` where it prints it (Find(node, true)) */
function shown(node: any): string {
	const text = visit(node);
	return text === '' ? INTERMEDIATE : text;
}

/** a node CallPrinter visits without printing it (Find(node) once found) */
const hidden = (_node: any): string => INTERMEDIATE;

function literal(node: any): string {
	const { value } = node;
	if (node.regex) {
		// V8 prints the flags in its own order
		const flags = [...'dgilmsuvy']
			.filter((flag) => node.regex.flags.includes(flag))
			.join('');
		return `/${node.regex.pattern}/${flags}`;
	}
	if (typeof value === 'string') return `"${value}"`;
	if (typeof value === 'number') return String(value);
	if (typeof value === 'boolean' || value === null) return String(value);
	// a BigInt: CallPrinter prints nothing for one
	return '';
}

/** whether a member's key prints as a name (a string literal, as V8 has it) */
function namedKey(node: any): string | null {
	if (!node.computed) return node.property.name ?? null;
	const key = unparenthesized(node.property);
	if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
	if (key.type === 'TemplateLiteral' && key.expressions.length === 0)
		return key.quasis[0].value.cooked ?? null;
	return null;
}

function unparenthesized(node: any): any {
	while (node?.type === 'ParenthesizedExpression') node = node.expression;
	return node;
}

/**
 * the operands of a chain of one operator V8 parses as one (a + b + c, and
 * (a + b) + c too, measured)
 */
function operands(node: any, operator: string): any[] {
	const left = unparenthesized(node.left);
	if (
		(left.type === 'BinaryExpression' || left.type === 'LogicalExpression') &&
		left.operator === operator
	)
		return [...operands(left, operator), node.right];
	return [left, node.right];
}

/** a numeric literal V8's parser folds `-1`, `+1`, `~1`, `!1` and `1 + 2` into */
function folded(node: any): number | boolean | undefined {
	node = unparenthesized(node);
	if (node.type === 'Literal' && typeof node.value === 'number')
		return node.value;
	if (node.type === 'UnaryExpression') {
		const value = folded(node.argument);
		if (node.operator === '!' && value !== undefined) return !value;
		if (typeof value !== 'number') return undefined;
		if (node.operator === '-') return -value;
		if (node.operator === '+') return value;
		if (node.operator === '~') return ~value;
	}
	if (node.type === 'BinaryExpression') {
		const left = folded(node.left);
		const right = folded(node.right);
		if (typeof left !== 'number' || typeof right !== 'number') return undefined;
		switch (node.operator) {
			case '+':
				return left + right;
			case '-':
				return left - right;
			case '*':
				return left * right;
			case '/':
				return left / right;
			case '%':
				return left % right;
			case '**':
				return left ** right;
			case '|':
				return left | right;
			case '&':
				return left & right;
			case '^':
				return left ^ right;
			case '<<':
				return left << right;
			case '>>':
				return left >> right;
			case '>>>':
				return left >>> right;
		}
	}
	return undefined;
}

function visit(node: any): string {
	switch (node?.type) {
		case 'ParenthesizedExpression':
			return visit(node.expression);
		case 'Identifier':
			return node.name;
		case 'PrivateIdentifier':
			return `#${node.name}`;
		case 'ThisExpression':
			return 'this';
		case 'Super':
			return '';
		case 'Literal':
			return literal(node);
		case 'TemplateLiteral':
			// a template without substitutions is a string literal to V8
			if (node.expressions.length === 0)
				return `"${node.quasis[0].value.cooked ?? ''}"`;
			return node.expressions.map(shown).join('');
		case 'ArrayExpression':
			return `[${node.elements
				.map((element: any) =>
					element === null ? INTERMEDIATE : shown(element),
				)
				.join(',')}]`;
		case 'ObjectExpression':
			return `{${node.properties.map(hidden).join('')}}`;
		case 'SpreadElement':
			return `(...${shown(node.argument)})`;
		case 'MemberExpression': {
			const object = shown(node.object);
			const name = namedKey(node);
			if (name !== null && node.property.type !== 'PrivateIdentifier')
				return `${object}${node.optional ? '?.' : '.'}${name}`;
			if (node.property.type === 'PrivateIdentifier')
				return `${object}${node.optional ? '?.' : '.'}#${node.property.name}`;
			return `${object}${node.optional ? '?.' : ''}[${shown(node.property)}]`;
		}
		case 'CallExpression':
			return `${shown(node.callee)}(...)`;
		case 'TaggedTemplateExpression':
			return `${shown(node.tag)}(...)`;
		case 'ImportExpression':
			return `ImportCall(${shown(node.source)})`;
		case 'NewExpression':
		case 'ChainExpression':
		case 'ConditionalExpression':
		case 'AwaitExpression':
		case 'YieldExpression':
		case 'FunctionExpression':
		case 'ArrowFunctionExpression':
		case 'ClassExpression':
		case 'MetaProperty':
			return conditional(node);
		case 'UnaryExpression': {
			const value = folded(node);
			if (value !== undefined) return String(value);
			const space =
				node.operator === 'typeof' ||
				node.operator === 'void' ||
				node.operator === 'delete'
					? ' '
					: '';
			return `(${node.operator}${space}${shown(node.argument)})`;
		}
		case 'UpdateExpression':
			return node.prefix
				? `(${node.operator}${shown(node.argument)})`
				: `(${shown(node.argument)}${node.operator})`;
		case 'BinaryExpression':
		case 'LogicalExpression': {
			const value = folded(node);
			if (value !== undefined) return String(value);
			return `(${operands(node, node.operator)
				.map(shown)
				.join(` ${node.operator} `)})`;
		}
		case 'SequenceExpression':
			return `(${node.expressions.map(shown).join(' , ')})`;
		case 'AssignmentExpression':
			return shown(node.left);
	}
	return '';
}

/**
 * What CallPrinter prints for the nodes it visits without printing their
 * parts: three unprinted operands for a conditional, nothing (so the
 * placeholder) for the rest
 */
function conditional(node: any): string {
	return node.type === 'ConditionalExpression' ? INTERMEDIATE.repeat(3) : '';
}

/** the expression a parsed partial holds, past the wrappers it was parsed in */
function expressionOf(program: any): any {
	let node = program.body.at(-1);
	// class C { async *m() { (partial) } } and async function* f() { ... }
	for (;;) {
		if (node?.type === 'ClassDeclaration') {
			node = node.body.body.at(-1)?.value?.body?.body?.[0];
			continue;
		}
		if (node?.type === 'FunctionDeclaration') {
			node = node.body.body[0];
			continue;
		}
		break;
	}
	return unparenthesized(node?.expression);
}

const PRIVATE_NAME = /#[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*/gu;

/**
 * A partial parsed as an expression: as a script, then where `await` and
 * `yield` are expressions, then in a class method (`super`, the private
 * names it uses), then as a module (`import.meta`)
 */
function parsePartial(source: string): any {
	const options = {
		next: true,
		webcompat: true,
		preserveParens: true,
	};
	const wrapped = `(${source}\n)`;
	const privates = [...new Set(source.match(PRIVATE_NAME) ?? [])];
	const attempts = [
		() => parse(wrapped, options),
		() => parse(`async function* f() {${wrapped}}`, options),
		() =>
			parse(
				`class C extends Object { ${privates.map((name) => `${name};`).join('')} async *m() {${wrapped}} }`,
				options,
			),
		() => parse(wrapped, { ...options, module: true }),
	];
	for (const attempt of attempts)
		try {
			return expressionOf(attempt());
		} catch (error) {
			// the next goal
		}
	return null;
}

/** the call, construction or tagged template a partial is, past a chain */
function callOf(node: any): any {
	node = unparenthesized(node);
	if (node?.type === 'ChainExpression') node = unparenthesized(node.expression);
	return node;
}

/** the name V8 gives a destructuring's first property in its message, if any */
function firstKey(pattern: any): string {
	const first =
		pattern?.type === 'ObjectPattern' ? pattern.properties[0] : null;
	if (!first || first.type !== 'Property' || first.computed) return '';
	const { key } = first;
	if (key.type === 'Identifier') return key.name;
	if (key.type === 'Literal') return String(key.value);
	return '';
}

let lastSource = '';
let lastNode: any = null;

/**
 * What V8 names a part of `source` (a page's expression, as the rewriter
 * handed it to a helper) by in the message of an error about it, as text,
 * or null when the source does not parse:
 * - 'callee': the function a call, construction or tagged template calls
 * - 'spread': '1' when the call's arguments spread other than once at the
 *   end, which V8 makes a Function.prototype.apply (a Reflect.construct) of,
 *   with that function's errors
 * - 'value': the expression; 'type': its node type (past parentheses and
 *   an optional chain)
 * - 'key', 'init': a destructuring assignment's first property name ('' for
 *   none or a computed one) and its source expression
 */
export function printExpression(source: string, part: string): string | null {
	if (source !== lastSource) {
		lastNode = parsePartial(source);
		lastSource = source;
	}
	const node = lastNode;
	if (!node) return null;
	const call = callOf(node);
	switch (part) {
		case 'callee':
			switch (call?.type) {
				case 'CallExpression':
				case 'NewExpression':
					return shown(call.callee);
				case 'TaggedTemplateExpression':
					return shown(call.tag);
			}
			return null;
		case 'spread': {
			const args: any[] = call?.arguments ?? [];
			const spreads = args.filter((arg) => arg.type === 'SpreadElement');
			return spreads.length > 1 ||
				(spreads.length === 1 && args.at(-1)?.type !== 'SpreadElement')
				? '1'
				: '';
		}
		case 'type':
			return call?.type ?? '';
		case 'key':
			return node.type === 'AssignmentExpression' ? firstKey(node.left) : '';
		case 'init':
			return node.type === 'AssignmentExpression' ? shown(node.right) : null;
	}
	return shown(node);
}
