import type { ESTree } from 'meriyah';

type mNode = ESTree.Node;

// children of the node to replace a node must explicitly opt into being part of the result with
// result(node)

export const symbolNoResult = Symbol('symbolNoResult');
export const symbolResult = Symbol('symbolResult');

declare type NodeRange = [number, number];

export declare type Node =
	| {
			range?: NodeRange;
			[key: string | symbol]:
				Node | Node[] | NodeRange | string | boolean | undefined;
	  }
	| mNode
	| any;

export function result(node: Node): Node {
	node[symbolResult] = true;
	return node;
}

export class AcornContext {
	node: Node;
	parent?: AcornContext;
	parentKey?: string | undefined;
	attached: boolean;
	root: boolean;
	stack: AcornContext[];
	entries: AcornContext[];
	constructor(
		node: Node,
		parent: AcornContext | undefined,
		parentKey: string | undefined,
		stack: AcornContext[],
		root = false,
	) {
		this.node = node;
		this.stack = stack;
		this.entries = [];

		if (parent) {
			this.parent = parent;
			this.parentKey = parentKey;
			this.attached = true;
		} else if (!root) {
			throw new TypeError('New parent isnt an instance of AcornContext.');
		} else {
			this.attached = false;
		}

		this.root = root;
	}
	// only used by array() and index()
	get parentObject(): Node | Node[] {
		if (!this.parent || !this.parentKey) {
			throw new Error('No parent');
		}

		return <Node | Node[]>this.parent.node[this.parentKey];
	}
	get parentIndex() {
		if (!(this.parentObject instanceof Array)) {
			throw new Error('Not an array');
		}

		return this.parentObject.indexOf(this.node);
	}
	detach() {
		if (this.root) {
			throw new RangeError('Cannot detach the root.');
		} else if (!this.attached) {
			throw new RangeError('Cannot detach a detached node.');
		}

		if (this.parentObject instanceof Array) {
			const place = this.parentObject.indexOf(this.node);
			if (place === -1) return false;
			this.parentObject.splice(place, 1);
		} else {
			delete this.parent!.node[this.parentKey!];
		}

		this.attached = false;

		return true;
	}
	// success = new AcornContext, failure = false
	replaceWith(node: Node) {
		if (this.root) {
			throw new RangeError('Cannot replace the root.');
		} else if (!this.attached) {
			throw new RangeError('Cannot replace a detached node.');
		}

		if (this.parentObject instanceof Array) {
			const place = this.parentObject.indexOf(this.node);

			if (place === -1) {
				return false;
			}

			this.parentObject.splice(place, 1, node);
		} else {
			delete this.parent!.node[this.parentKey!];
			this.parent!.node[this.parentKey!] = node;
		}

		this.attached = false;

		const created = new AcornContext(
			node,
			this.parent!,
			this.parentKey!,
			this.stack,
		);

		delete this.parent;

		this.removeDescendantsFromStack();
		created.node[symbolNoResult] = true;
		this.stack.push(created);

		created.addEntriesToStack();

		// what the replacement is made of is the rewriter's and is not
		// visited; what was handed back with result(), and everything under
		// it, stays the walk's. A node of an earlier replacement handed back
		// again (a loop whose head and source are both replaced) is one too:
		// taken for the rewriter's, the page's code under it was never
		// visited and printed as written
		const pending: Node[] = [created.node];
		while (pending.length) {
			const node = pending.pop();
			for (const key in node) {
				if (key === 'range' || key === 'loc') continue;
				const value = node[key];
				if (typeof value !== 'object' || value === null) continue;
				for (const child of value instanceof Array ? value : [value]) {
					if (typeof child !== 'object' || child === null) continue;
					if (typeof child.type !== 'string') continue;
					if (child[symbolResult]) {
						delete child[symbolResult];
						continue;
					}
					child[symbolNoResult] = true;
					pending.push(child);
				}
			}
		}

		return created;
	}
	addEntriesToStack() {
		// each child node gets its context, in source order, and the stack
		// gets them last first, so the first child is the next popped. No
		// intermediate list: this runs for every node of a script, and its
		// allocations were a large part of a big rewrite's garbage
		const node = this.node;
		const first = this.entries.length;
		for (const key in node) {
			if (key === 'range' || key === 'loc') continue;
			const value = node[key];
			if (typeof value !== 'object' || value === null) continue;
			if (value instanceof Array) {
				for (let i = 0; i < value.length; i++) {
					const sv = value[i];
					if (typeof sv !== 'object' || sv === null) continue;
					if (typeof sv.type === 'string')
						this.entries.push(new AcornContext(sv, this, key, this.stack));
				}
			} else if (typeof value.type === 'string') {
				this.entries.push(new AcornContext(value, this, key, this.stack));
			}
		}
		for (let i = this.entries.length - 1; i >= first; i--)
			this.stack.push(this.entries[i]);
	}
	removeDescendantsFromStack() {
		for (let i = 0; i < this.entries.length; i++) {
			const entry = this.entries[i];
			const stackI = this.stack.indexOf(entry);

			if (stackI !== -1) {
				this.stack.splice(stackI, 1);
			}

			entry.removeDescendantsFromStack();
		}
	}
}
export class AcornIterator {
	stack: AcornContext[];
	constructor(ast: Node) {
		this.stack = [];
		this.stack.push(
			new AcornContext(ast, undefined, undefined, this.stack, true),
		);
	}
	next() {
		while (true) {
			const context = this.stack.pop();

			if (context === undefined) {
				return { value: undefined, done: true };
			}

			context.addEntriesToStack();

			if (context.node[symbolNoResult]) {
				continue;
			}

			return { value: context, done: false };
		}
	}
	[Symbol.iterator](): Iterator<AcornContext> {
		return <Iterator<AcornContext>>this;
	}
}
