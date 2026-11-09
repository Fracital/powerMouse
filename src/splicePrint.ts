// Prints a rewritten tree from the script's own text. Escodegen regenerated
// the whole program, which was most of a large rewrite's time and garbage,
// and moved every line: a node the rewriter left alone is printed now as the
// source slice it came from, a node whose children changed as its own text
// with those children spliced in, and only nodes the rewriter made go
// through escodegen, each original node inside them printed the same way.
//
// What changed is told by comparison, not by tracking: before the rewrite,
// every node's keys and values are recorded (`snapshot`), so no mutation
// path can be missed. A node is clean when it is the same object with the
// same keys, the same values and the same children, all clean.
import { generate } from '@javascript-obfuscator/escodegen';

const SNAP = Symbol('snapshot');
const CLEAN = Symbol('clean');

type Any = any;

/** the keys of a node that are not its structure */
const SKIP = new Set(['range', 'loc', 'start', 'end']);

const isNode = (value: unknown): value is Any =>
	typeof value === 'object' &&
	value !== null &&
	typeof (value as Any).type === 'string';

/**
 * Record every node's keys and values (arrays copied) under a symbol on the
 * node's range array: a property on the node itself would change the shape
 * of every node and slow every walk after it. A node made later has no
 * range, so no record.
 */
export function snapshot(root: Any) {
	const stack = [root];
	while (stack.length) {
		const node = stack.pop();
		const record: unknown[] = [];
		for (const key in node) {
			if (SKIP.has(key)) continue;
			const value = node[key];
			if (Array.isArray(value)) {
				record.push(key, value.slice());
				for (let i = value.length - 1; i >= 0; i--)
					if (isNode(value[i])) stack.push(value[i]);
			} else {
				record.push(key, value);
				if (isNode(value)) stack.push(value);
			}
		}
		if (node.range) node.range[SNAP] = record;
	}
}

/** the node's keys and values are as recorded (its children may have changed inside) */
function sameShape(node: Any): boolean {
	const record: unknown[] | undefined = node.range?.[SNAP];
	if (!record) return false;
	let i = 0;
	for (const key in node) {
		if (SKIP.has(key)) continue;
		if (record[i] !== key) return false;
		const was = record[i + 1];
		const value = node[key];
		if (Array.isArray(value)) {
			if (!Array.isArray(was) || was.length !== value.length) return false;
			for (let j = 0; j < value.length; j++)
				if (value[j] !== was[j]) return false;
		} else if (value !== was) return false;
		i += 2;
	}
	return i === record.length;
}

/**
 * The child slots of an original node whose keys and scalar values are as
 * recorded, with arrays of the same length, each as [the child now, the
 * child parsed there]; null when the node changed in any other way (a key,
 * a scalar, an array's length, a child where there was none)
 */
function slots(node: Any): [Any, Any, string][] | null {
	const record: unknown[] | undefined = node.range?.[SNAP];
	if (!record || !node.range) return null;
	const out: [Any, Any, string][] = [];
	let i = 0;
	for (const key in node) {
		if (SKIP.has(key)) continue;
		if (record[i] !== key) return null;
		const was: Any = record[i + 1];
		const value = node[key];
		if (Array.isArray(value)) {
			if (!Array.isArray(was) || was.length !== value.length) return null;
			for (let j = 0; j < value.length; j++) {
				const now = value[j];
				const then = was[j];
				if (now === then) {
					if (isNode(now)) out.push([now, then, key]);
				} else if (isNode(now) && isNode(then) && then.range)
					out.push([now, then, key]);
				else return null;
			}
		} else if (value === was) {
			if (isNode(value)) out.push([value, was, key]);
		} else if (
			isNode(value) &&
			isNode(was) &&
			was.range &&
			!methodValue(node, key)
		)
			out.push([value, was, key]);
		else return null;
		i += 2;
	}
	return i === record.length ? out : null;
}

/** the node and everything under it are as parsed */
function clean(node: Any): boolean {
	const memo = node.range?.[CLEAN];
	if (memo !== undefined) return memo;
	let result = sameShape(node);
	if (result)
		for (const key in node) {
			if (SKIP.has(key)) continue;
			const value = node[key];
			if (Array.isArray(value)) {
				for (let j = 0; j < value.length && result; j++)
					if (isNode(value[j]) && !clean(value[j])) result = false;
			} else if (isNode(value) && !clean(value)) result = false;
			if (!result) break;
		}
	if (node.range) node.range[CLEAN] = result;
	return result;
}

const STATEMENT = /Statement$|Declaration$/;
// statements that end in a block of their own: no `;` after one
const BLOCKISH = new Set([
	'BlockStatement',
	'IfStatement',
	'ForStatement',
	'ForInStatement',
	'ForOfStatement',
	'WhileStatement',
	'TryStatement',
	'SwitchStatement',
	'LabeledStatement',
	'WithStatement',
	'FunctionDeclaration',
	'ClassDeclaration',
	'EmptyStatement',
]);
// expressions that need parentheses wherever a higher precedence is wanted,
// or at the start of a statement
const LOOSE = new Set([
	'SequenceExpression',
	'AssignmentExpression',
	'ArrowFunctionExpression',
	'ConditionalExpression',
	'LogicalExpression',
	'BinaryExpression',
	'UnaryExpression',
	'UpdateExpression',
	'AwaitExpression',
	'YieldExpression',
	'ObjectExpression',
	'FunctionExpression',
	'ClassExpression',
]);
// slots that take any expression: nothing there needs parentheses but a
// statement's start
const OPEN_SLOTS: Record<string, string[]> = {
	ExpressionStatement: ['expression'],
	IfStatement: ['test'],
	WhileStatement: ['test'],
	DoWhileStatement: ['test'],
	SwitchStatement: ['discriminant'],
	SwitchCase: ['test'],
	ReturnStatement: ['argument'],
	ThrowStatement: ['argument'],
	ForStatement: ['test', 'update'],
	TemplateLiteral: ['expressions'],
	MemberExpression: ['property'],
};
// at a statement's start, these open a block, a declaration or a destructuring
const STATEMENT_START = new Set([
	'ObjectExpression',
	'FunctionExpression',
	'ClassExpression',
]);
// a statement starting with one of these continues the statement before it
// when that one has no `;`
const HAZARD = /^[([`+\-/]/;
// the lists of statements a statement may follow another in
const LISTS: Record<string, string> = {
	Program: 'body',
	BlockStatement: 'body',
	StaticBlock: 'body',
	SwitchCase: 'consequent',
};

/**
 * `text` for a statement in a list, after `before` (the text of the one
 * before it, or null for the first): a statement that now starts with ( [ `
 * + - or / where it did not before would continue one that does not end
 * itself, so it starts with `0, ` there (the same statement: a sequence's
 * value is its last)
 */
function guarded(
	text: string,
	original: string,
	before: string | null,
	beforeType: string | undefined,
): string {
	if (before === null || !HAZARD.test(text) || text[0] === original)
		return text;
	const end = before.trimEnd();
	if (end.endsWith(';')) return text;
	if (beforeType && BLOCKISH.has(beforeType) && end.endsWith('}')) return text;
	return `0, ${text}`;
}

/**
 * A method's function (an object method, a getter or setter, a class
 * member): its range starts at the parameters, and it is no expression
 * slot: never parenthesized, and only printed from its own text
 */
const methodValue = (parent: Any, slot: string) =>
	slot === 'value' &&
	(parent?.type === 'MethodDefinition' ||
		(parent?.type === 'Property' &&
			(parent.method || parent.kind === 'get' || parent.kind === 'set')));

/** `text` for `node` in `slot` of `parent`, parenthesized where its precedence needs it */
function fitted(text: string, node: Any, parent: Any, slot: string): string {
	if (!LOOSE.has(node.type) || methodValue(parent, slot)) return text;
	const open = OPEN_SLOTS[parent?.type];
	if (
		open?.includes(slot) &&
		!(open === OPEN_SLOTS.MemberExpression && !parent.computed)
	) {
		if (parent.type === 'ExpressionStatement' && STATEMENT_START.has(node.type))
			return `(${text})`;
		return text;
	}
	return `(${text})`;
}

const WORD = /[\p{ID_Continue}$\u200c\u200d]/u;
/**
 * `left` and `right` side by side without them becoming one token: a space
 * where both ends are word characters (`return` and `$s$j`), or would make
 * `++`, `--` or a comment
 */
const merges = (a: string, b: string) =>
	(WORD.test(a) && WORD.test(b)) ||
	(a === '+' && b === '+') ||
	(a === '-' && b === '-') ||
	(a === '/' && (b === '/' || b === '*'));

/**
 * Text built from pieces, kept as a list until the end: reading the last
 * character of a growing string would flatten it on every piece
 */
class Joined {
	readonly #parts: string[] = [];
	#last = '';
	add(text: string) {
		if (!text) return;
		if (this.#last && merges(this.#last, text[0])) this.#parts.push(' ');
		this.#parts.push(text);
		this.#last = text[text.length - 1];
	}
	toString() {
		return this.#parts.join('');
	}
}

// the slots that hold a statement (any other holds a declaration as part
// of something else: a for head's `let i = 0`)
const STATEMENT_SLOTS: Record<string, string[]> = {
	Program: ['body'],
	BlockStatement: ['body'],
	StaticBlock: ['body'],
	SwitchCase: ['consequent'],
	IfStatement: ['consequent', 'alternate'],
	ForStatement: ['body'],
	ForInStatement: ['body'],
	ForOfStatement: ['body'],
	WhileStatement: ['body'],
	DoWhileStatement: ['body'],
	LabeledStatement: ['body'],
	WithStatement: ['body'],
};

export interface Printer {
	print(node: Any, parent?: Any, slot?: string): string;
	/**
	 * The statements of `node[key]` from the first one's text to the last
	 * one's, spliced; null when the list's length changed
	 */
	printList(node: Any, key: string): string | null;
}

/**
 * A printer of `script`'s rewritten tree. `options` are escodegen's, for the
 * nodes the rewriter made.
 */
export function splicePrinter(script: string, options?: object): Printer {
	// a placeholder no script can contain
	let salt = 0;
	let token: string;
	do token = `$stomp$splice${(salt++).toString(36)}$`;
	while (script.includes(token));
	let counter = 0;

	const raw = (node: Any) => script.slice(node.range[0], node.range[1]);

	const print = (node: Any, parent?: Any, slot?: string): string => {
		if (node.range?.[SNAP] && node.range && clean(node)) return raw(node);
		const children = node.range?.[SNAP] && node.range ? slots(node) : null;
		if (children) return spliced(node, children);
		return generated(node);
	};

	// an original node whose children changed, or were replaced: its own
	// text, each changed child's printed text in place of the text of the
	// child parsed there
	const spliced = (node: Any, children: [Any, Any, string][]): string => {
		const edits: [number, number, string][] = [];
		const list = LISTS[node.type];
		// the statement before, in a list: its text and type
		let before: string | null = null;
		let beforeType: string | undefined;
		let lastKey: string | null = null;
		for (const [child, parsed, key] of children) {
			if (key !== lastKey) {
				before = null;
				lastKey = key;
			}
			const changed = !(child === parsed && clean(child));
			let text = changed
				? fitted(print(child, node, key), child, node, key)
				: null;
			if (text !== null && key === list)
				text = guarded(text, script[parsed.range[0]], before, beforeType);
			if (key === list) {
				before = text ?? raw(parsed);
				beforeType = child.type;
			}
			if (text !== null) edits.push([parsed.range[0], parsed.range[1], text]);
		}
		edits.sort((a, b) => a[0] - b[0]);
		const out = new Joined();
		let at = node.range[0];
		for (const [start, end, text] of edits) {
			out.add(script.slice(at, start));
			out.add(text);
			at = end;
		}
		out.add(script.slice(at, node.range[1]));
		return out.toString();
	};

	// a node the rewriter made (or one whose shape changed): escodegen, with
	// every original expression or statement inside it standing in as a
	// placeholder that its own printed text replaces
	const generated = (node: Any): string => {
		const swaps: [Any, string, number | null, Any][] = [];
		const texts = new Map<string, string>();
		const visit = (parent: Any) => {
			for (const key in parent) {
				if (SKIP.has(key)) continue;
				const value = parent[key];
				const list = Array.isArray(value) ? value : null;
				const children = list ?? [value];
				for (let i = 0; i < children.length; i++) {
					const child = children[i];
					if (!isNode(child)) continue;
					const declaration = STATEMENT.test(child.type);
					// a statement where a statement goes; a declaration anywhere
					// else (a for head) is put in as its text, like an expression
					const statement =
						declaration && !!STATEMENT_SLOTS[parent.type]?.includes(key);
					const expression =
						(declaration && !statement) ||
						child.type.endsWith('Expression') ||
						child.type === 'Identifier' ||
						child.type === 'Literal' ||
						child.type === 'TemplateLiteral';
					if (child.range?.[SNAP] && child.range && (statement || expression)) {
						const name = `${token}${(counter++).toString(36)}`;
						let text = print(child, parent, key);
						let stand: Any;
						if (statement) {
							if (
								!(BLOCKISH.has(child.type) && /[;}]\s*$/.test(text)) &&
								!/;\s*$/.test(text)
							)
								text += ';';
							stand = {
								type: 'ExpressionStatement',
								expression: { type: 'Identifier', name },
							};
							texts.set(`${name};`, text);
						} else {
							stand = { type: 'Identifier', name };
							texts.set(
								name,
								declaration ? text : fitted(text, child, parent, key),
							);
						}
						swaps.push([parent, key, list ? i : null, child]);
						if (list) list[i] = stand;
						else parent[key] = stand;
					} else visit(child);
				}
			}
		};
		visit(node);
		let out = generate(node, options);
		for (const [parent, key, index, child] of swaps)
			if (index === null) parent[key] = child;
			else parent[key][index] = child;
		if (texts.size) {
			const pattern = new RegExp(
				`${token.replace(/\$/g, '\\$')}[0-9a-z]+;?`,
				'g',
			);
			out = out.replace(pattern, (match) => {
				const exact = texts.get(match);
				if (exact !== undefined) return exact;
				// an expression placeholder followed by the statement's own `;`
				const bare = match.endsWith(';') ? match.slice(0, -1) : match;
				const text = texts.get(bare);
				return text === undefined ? match : text + (bare !== match ? ';' : '');
			});
		}
		return out;
	};

	const printList = (node: Any, key: string): string | null => {
		const record: unknown[] | undefined = node.range?.[SNAP];
		if (!record) return null;
		const index = record.indexOf(key);
		const was = record[index + 1] as Any[];
		const now: Any[] = node[key];
		if (index === -1 || !Array.isArray(was) || was.length !== now.length)
			return null;
		if (!now.length) return '';
		const out = new Joined();
		let at = was[0].range[0];
		let before: string | null = null;
		let beforeType: string | undefined;
		for (let j = 0; j < now.length; j++) {
			if (now[j] === was[j] && clean(now[j])) {
				before = raw(was[j]);
				beforeType = was[j].type;
				continue;
			}
			const text = guarded(
				print(now[j], node, key),
				script[was[j].range[0]],
				before,
				beforeType,
			);
			out.add(script.slice(at, was[j].range[0]));
			out.add(text);
			at = was[j].range[1];
			before = text;
			beforeType = now[j].type;
		}
		out.add(script.slice(at, was[was.length - 1].range[1]));
		return out.toString();
	};

	return { print, printList };
}
