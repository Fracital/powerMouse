// Compute kernels for test/suites/measure-compute.mjs: what the rewriter's
// routing of computed member access (`a[i]`, `a[i] = v`, `o[k](x)`, `k in o`)
// costs code that does nothing else. Each kernel is timed over `rounds`
// rounds after `warm` warm-up rounds and reports its median; its checksum
// must be the same natively and through the proxy. Every kernel runs once
// before any is timed (see `__computeRun`). `?only=a,b` runs the kernels
// named, `?rounds=` and `?warm=` set the counts, and with
// `window.__computeOptions = { manual: true }` nothing runs until
// `__computeRun()` is called.
(function () {
	'use strict';

	const kernels = [];
	/** `make()` builds the state once, `run(state)` is one timed round, `check(state)` adds what a round left behind to the checksum */
	const kernel = (name, make, run, check) =>
		kernels.push({ name, make, run, check });

	// a small deterministic generator: the data is the same in every run
	let seed = 12345;
	const random = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
		return (seed >>> 8) / 16777216;
	};

	// control: no member access at all, so its ratio is the noise of the run
	function lcg(n) {
		let x = 1;
		for (let i = 0; i < n; i++) x = (Math.imul(x, 1664525) + 1013904223) | 0;
		return x;
	}
	kernel(
		'control',
		() => null,
		() => lcg(30000000),
	);

	// packed array of small integers
	function sumPacked(a) {
		let t = 0;
		for (let i = 0; i < a.length; i++) t += a[i];
		return t;
	}
	function fillPacked(a, r) {
		for (let i = 0; i < a.length; i++) a[i] = (i + r) & 255;
	}
	const packed = () => {
		const a = [];
		for (let i = 0; i < 200000; i++) a.push(i & 1023);
		return a;
	};
	kernel('packed-sum', packed, (a) => {
		let t = 0;
		for (let r = 0; r < 250; r++) t += sumPacked(a);
		return t;
	});
	kernel(
		'packed-fill',
		packed,
		(a) => {
			for (let r = 0; r < 300; r++) fillPacked(a, r);
			return 0;
		},
		(a) => a.reduce((x, y) => x + y, 0),
	);

	// holey array of doubles
	function sumDoubles(a) {
		let t = 0;
		for (let i = 0; i < a.length; i++) t += a[i];
		return t;
	}
	function fillDoubles(a, r) {
		for (let i = 0; i < a.length; i++) a[i] = i * 0.25 + r;
	}
	const doubles = () => {
		const a = new Array(200000);
		for (let i = 0; i < a.length; i++) a[i] = i * 0.5;
		return a;
	};
	kernel('double-sum', doubles, (a) => {
		let t = 0;
		for (let r = 0; r < 200; r++) t += sumDoubles(a);
		return t;
	});
	kernel(
		'double-fill',
		doubles,
		(a) => {
			for (let r = 0; r < 250; r++) fillDoubles(a, r);
			return 0;
		},
		(a) => a.reduce((x, y) => x + y, 0),
	);

	// array of objects
	function sumObjects(a) {
		let t = 0;
		for (let i = 0; i < a.length; i++) t += a[i].v;
		return t;
	}
	function fillObjects(a, pool, r) {
		for (let i = 0; i < a.length; i++) a[i] = pool[(i + r) & 7];
	}
	const objects = () => {
		const a = [];
		for (let i = 0; i < 200000; i++) a.push({ v: i & 255, w: i });
		return a;
	};
	kernel('object-sum', objects, (a) => {
		let t = 0;
		for (let r = 0; r < 150; r++) t += sumObjects(a);
		return t;
	});
	kernel(
		'object-fill',
		() => {
			const pool = [];
			for (let i = 0; i < 8; i++) pool.push({ v: i, w: -i });
			return { a: objects(), pool };
		},
		(s) => {
			for (let r = 0; r < 180; r++) fillObjects(s.a, s.pool, r);
			return 0;
		},
		(s) => s.a.reduce((x, y) => x + y.v, 0),
	);

	// typed arrays
	function sumFloat64(a) {
		let t = 0;
		for (let i = 0; i < a.length; i++) t += a[i];
		return t;
	}
	function fillFloat64(a, r) {
		for (let i = 0; i < a.length; i++) a[i] = i * 0.25 + r;
	}
	function sumUint8(a) {
		let t = 0;
		for (let i = 0; i < a.length; i++) t += a[i];
		return t;
	}
	function fillUint8(a, r) {
		for (let i = 0; i < a.length; i++) a[i] = i + r;
	}
	const float64 = () =>
		Float64Array.from({ length: 200000 }, (_, i) => i * 0.5);
	const uint8 = () => Uint8Array.from({ length: 200000 }, (_, i) => i * 7);
	kernel('f64-sum', float64, (a) => {
		let t = 0;
		for (let r = 0; r < 200; r++) t += sumFloat64(a);
		return t;
	});
	kernel(
		'f64-fill',
		float64,
		(a) => {
			for (let r = 0; r < 250; r++) fillFloat64(a, r);
			return 0;
		},
		(a) => a.reduce((x, y) => x + y, 0),
	);
	kernel('u8-sum', uint8, (a) => {
		let t = 0;
		for (let r = 0; r < 250; r++) t += sumUint8(a);
		return t;
	});
	kernel(
		'u8-fill',
		uint8,
		(a) => {
			for (let r = 0; r < 250; r++) fillUint8(a, r);
			return 0;
		},
		(a) => a.reduce((x, y) => x + y, 0),
	);

	// a matrix as an array of Float64Array rows
	function multiply(a, b, c, n) {
		for (let i = 0; i < n; i++)
			for (let j = 0; j < n; j++) {
				let s = 0;
				for (let k = 0; k < n; k++) s += a[i][k] * b[k][j];
				c[i][j] = s;
			}
	}
	kernel(
		'matmul',
		() => {
			const n = 72;
			const matrix = (f) => {
				const rows = [];
				for (let i = 0; i < n; i++)
					rows.push(Float64Array.from({ length: n }, (_, j) => f(i, j)));
				return rows;
			};
			return {
				n,
				a: matrix((i, j) => ((i * 31 + j * 17) % 13) - 6),
				b: matrix((i, j) => ((i * 7 + j * 3) % 11) - 5),
				c: matrix(() => 0),
			};
		},
		(s) => {
			for (let r = 0; r < 50; r++) multiply(s.a, s.b, s.c, s.n);
			return 0;
		},
		(s) => s.c.reduce((x, row) => x + row.reduce((y, v) => y + v, 0), 0),
	);

	// a 3x3 kernel over a grey image
	function convolve(src, dst, w, h, k) {
		for (let y = 1; y < h - 1; y++)
			for (let x = 1; x < w - 1; x++) {
				let s = 0;
				for (let ky = -1; ky <= 1; ky++)
					for (let kx = -1; kx <= 1; kx++)
						s += src[(y + ky) * w + x + kx] * k[(ky + 1) * 3 + kx + 1];
				dst[y * w + x] = s;
			}
	}
	kernel(
		'convolve',
		() => {
			const w = 256;
			const h = 256;
			const src = Uint8ClampedArray.from({ length: w * h }, () =>
				Math.floor(random() * 256),
			);
			return {
				w,
				h,
				src,
				dst: new Uint8ClampedArray(w * h),
				k: [0, -1, 0, -1, 5, -1, 0, -1, 0],
			};
		},
		(s) => {
			for (let r = 0; r < 20; r++) convolve(s.src, s.dst, s.w, s.h, s.k);
			return 0;
		},
		(s) => s.dst.reduce((x, y) => x + y, 0),
	);

	// counting into bins: a read that keys a compound write
	function histogram(data, bins) {
		for (let i = 0; i < data.length; i++) bins[data[i]]++;
	}
	kernel(
		'histogram',
		() => ({
			data: Uint8Array.from({ length: 200000 }, () =>
				Math.floor(random() * 256),
			),
			bins: new Uint32Array(256),
		}),
		(s) => {
			s.bins.fill(0);
			for (let r = 0; r < 150; r++) histogram(s.data, s.bins);
			return 0;
		},
		(s) => s.bins.reduce((x, y, i) => (x + y * (i + 1)) % 1000000007, 0),
	);

	// sorting numbers in place: reads and writes of one array, by index
	function sortRange(a, low, high) {
		while (low < high) {
			const pivot = a[(low + high) >> 1];
			let i = low;
			let j = high;
			while (i <= j) {
				while (a[i] < pivot) i++;
				while (a[j] > pivot) j--;
				if (i <= j) {
					const t = a[i];
					a[i] = a[j];
					a[j] = t;
					i++;
					j--;
				}
			}
			if (j - low < high - i) {
				sortRange(a, low, j);
				low = i;
			} else {
				sortRange(a, i, high);
				high = j;
			}
		}
	}
	kernel(
		'quicksort',
		() => {
			const from = [];
			for (let i = 0; i < 60000; i++) from.push(Math.floor(random() * 1e6));
			return { from, last: null };
		},
		(s) => {
			for (let r = 0; r < 6; r++) {
				s.last = s.from.slice();
				sortRange(s.last, 0, s.last.length - 1);
			}
			return 0;
		},
		(s) => s.last.reduce((x, y, i) => (x + y * (i & 7)) % 1000000007, 0),
	);

	// the keys of a plain object
	function sumForIn(o) {
		let t = 0;
		for (const k in o) t += o[k];
		return t;
	}
	function sumKeys(o) {
		let t = 0;
		Object.keys(o).forEach((k) => {
			t += o[k];
		});
		return t;
	}
	const large = () => {
		const o = {};
		for (let i = 0; i < 5000; i++) o['key' + i] = i;
		return o;
	};
	const small = () => ({
		alpha: 1,
		beta: 2,
		gamma: 3,
		delta: 4,
		epsilon: 5,
		zeta: 6,
		eta: 7,
		theta: 8,
		iota: 9,
		kappa: 10,
		lambda: 11,
		mu: 12,
	});
	kernel('forin-large', large, (o) => {
		let t = 0;
		for (let r = 0; r < 100; r++) t += sumForIn(o);
		return t;
	});
	kernel('forin-small', small, (o) => {
		let t = 0;
		for (let r = 0; r < 300000; r++) t += sumForIn(o);
		return t;
	});
	kernel('keys-foreach', large, (o) => {
		let t = 0;
		for (let r = 0; r < 100; r++) t += sumKeys(o);
		return t;
	});

	// characters of a string
	function countLetter(s) {
		let t = 0;
		for (let i = 0; i < s.length; i++) if (s[i] === 'e') t++;
		return t;
	}
	function sumCodes(s) {
		let t = 0;
		for (let i = 0; i < s.length; i++) t += s.charCodeAt(i);
		return t;
	}
	const text = () => {
		const words = ['measure', 'the', 'rewritten', 'code', 'at', 'run', 'time'];
		const parts = [];
		for (let i = 0; i < 40000; i++)
			parts.push(words[Math.floor(random() * words.length)]);
		return parts.join(' ');
	};
	kernel('string-index', text, (s) => {
		let t = 0;
		for (let r = 0; r < 40; r++) t += countLetter(s);
		return t;
	});
	kernel('string-charcodeat', text, (s) => {
		let t = 0;
		for (let r = 0; r < 100; r++) t += sumCodes(s);
		return t;
	});

	// a JSON-ish tree, walked by its keys
	function walk(node) {
		if (Array.isArray(node)) {
			let t = 0;
			for (let i = 0; i < node.length; i++) t += walk(node[i]);
			return t;
		}
		if (typeof node === 'object' && node !== null) {
			let t = 0;
			const keys = Object.keys(node);
			for (let i = 0; i < keys.length; i++)
				t += walk(node[keys[i]]) + keys[i].length;
			return t;
		}
		if (typeof node === 'number') return node;
		if (typeof node === 'string') return node.length;
		return 1;
	}
	kernel(
		'tree-walk',
		() => {
			const grow = (depth) => {
				if (depth === 0) {
					const pick = random();
					return pick < 0.4
						? Math.floor(random() * 100)
						: pick < 0.7
							? 'leaf' + Math.floor(random() * 10)
							: pick < 0.85
								? true
								: null;
				}
				if (random() < 0.35) {
					const list = [];
					for (let i = 0; i < 6; i++) list.push(grow(depth - 1));
					return list;
				}
				return {
					id: Math.floor(random() * 1000),
					type: 'node',
					left: grow(depth - 1),
					right: grow(depth - 1),
					meta: { tag: 'x', weight: random() < 0.5 ? 1 : 2 },
				};
			};
			return JSON.parse(JSON.stringify(grow(9)));
		},
		(tree) => {
			let t = 0;
			for (let r = 0; r < 24; r++) t += walk(tree);
			return t;
		},
	);

	// methods called by a computed name
	function dispatch(ops, names, n) {
		let t = 1;
		for (let i = 0; i < n; i++) t = ops[names[i & 3]](t);
		return t;
	}
	kernel(
		'computed-call',
		() => ({
			ops: {
				add(x) {
					return x + 3;
				},
				scale(x) {
					return (x * 5) % 1000003;
				},
				drop(x) {
					return x - 1;
				},
				mix(x) {
					return x ^ 0x55;
				},
			},
			names: ['add', 'scale', 'drop', 'mix'],
		}),
		(s) => dispatch(s.ops, s.names, 3000000),
	);

	// an object as a map: mostly writes
	function countWords(words, n) {
		const counts = {};
		const first = {};
		for (let i = 0; i < n; i++) {
			const word = words[i % words.length];
			first[word] ??= i;
			counts[word] = (counts[word] || 0) + 1;
		}
		let t = 0;
		for (const word in counts) t += counts[word] * 3 + first[word];
		return t;
	}
	kernel(
		'cache-write',
		() => {
			const words = [];
			for (let i = 0; i < 500; i++) words.push('word' + i * 7);
			return words;
		},
		(words) => countWords(words, 1200000),
	);

	// the arguments object, by index
	function sumArguments() {
		let t = 0;
		for (let i = 0; i < arguments.length; i++) t += arguments[i];
		return t;
	}
	function callWithArguments(n) {
		let t = 0;
		for (let i = 0; i < n; i++) t += sumArguments(i, 1, 2, 3, 4, 5, 6, 7);
		return t;
	}
	kernel(
		'arguments',
		() => null,
		() => callWithArguments(3000000),
	);

	// the array methods a framework calls on small arrays, millions of times
	// a page: what a hook on Array.prototype or Function.prototype.apply
	// costs each call
	function arrayMethods(a, n) {
		let t = 0;
		for (let i = 0; i < n; i++) {
			t += a.map((x) => x + i).filter((x) => x & 1).length;
			t += a.indexOf(i & 7) + a.slice(1).length;
			a.forEach((x) => (t += x));
			t += Math.max.apply(null, a);
		}
		return t;
	}
	kernel(
		'array-methods',
		() => [0, 1, 2, 3, 4, 5, 6, 7],
		(a) => arrayMethods(a, 200000),
	);

	// spread, for-of, destructuring and Array.from of small arrays: V8 runs
	// them on a fast path while an array's @@iterator is the browser's, a
	// flag of the whole process that one write of it turns off
	function iterateArrays(a, n) {
		let t = 0;
		for (let i = 0; i < n; i++) {
			t += [...a].length + Math.max(...a);
			for (const x of a) t += x;
			const [x, y] = a;
			t += x + y + Array.from(a).length;
		}
		return t;
	}
	kernel(
		'array-iteration',
		() => [0, 1, 2, 3, 4, 5, 6, 7],
		(a) => iterateArrays(a, 300000),
	);

	// call, apply and bind, as compiled classes and older libraries use them:
	// what a hook on Function.prototype costs each call
	function Base(x) {
		this.x = x;
	}
	Base.prototype.add = function (y) {
		return this.x + y;
	};
	function Derived(x) {
		Base.call(this, x);
	}
	function forward() {
		return Base.prototype.add.apply(this, arguments);
	}
	function callMethods(n) {
		let t = 0;
		const slice = Array.prototype.slice;
		for (let i = 0; i < n; i++) {
			const o = new Derived(i);
			t += Base.prototype.add.call(o, 1) + forward.call(o, 2);
			t += slice.call([i, 1, 2], 1).length;
			if ((i & 63) === 0) t += Base.prototype.add.bind(o, 3)();
		}
		return t;
	}
	kernel(
		'call-apply',
		() => null,
		() => callMethods(1000000),
	);

	// `in` with a key that is no literal
	function countPresent(o, keys) {
		let t = 0;
		for (let i = 0; i < keys.length; i++) if (keys[i] in o) t++;
		return t;
	}
	function countIndices(a, n) {
		let t = 0;
		for (let i = 0; i < n; i++) if (i in a) t++;
		return t;
	}
	kernel(
		'in-string',
		() => {
			const o = {};
			const keys = [];
			for (let i = 0; i < 2000; i++) {
				keys.push('name' + i);
				if (i % 2 === 0) o['name' + i] = i;
			}
			return { o, keys };
		},
		(s) => {
			let t = 0;
			for (let r = 0; r < 1200; r++) t += countPresent(s.o, s.keys);
			return t;
		},
	);
	kernel(
		'in-sparse',
		() => {
			// far enough apart that the engine keeps the elements in a table
			const a = [];
			for (let i = 0; i < 100000; i += 3) a[i * 64] = i;
			return a;
		},
		(a) => {
			let t = 0;
			for (let r = 0; r < 3; r++) t += countIndices(a, 400000);
			return t;
		},
	);

	// The shapes of a framework's own loops over plain objects, where a
	// page's time goes on most sites: a JSON payload walked by its keys, a
	// virtual DOM's props and children diffed, a store's subscribers
	// notified by key, records grouped into an object, an object cloned.

	// a JSON payload, walked by for-in (every value read by its key)
	function walkForIn(node) {
		if (typeof node !== 'object' || node === null)
			return typeof node === 'number' ? node : 1;
		let t = 0;
		for (const k in node) t += walkForIn(node[k]);
		return t;
	}
	const payload = () => {
		const users = [];
		for (let i = 0; i < 400; i++)
			users.push({
				id: i,
				name: 'user' + i,
				active: i % 3 === 0,
				score: Math.floor(random() * 1000),
				tags: ['a' + (i % 5), 'b' + (i % 7)],
				address: { city: 'c' + (i % 11), zip: 10000 + i, geo: [i, -i] },
				posts: [
					{ id: i * 2, likes: i % 13, title: 't' + i },
					{ id: i * 2 + 1, likes: i % 17, title: 'u' + i },
				],
			});
		return JSON.parse(JSON.stringify({ users, total: users.length }));
	};
	kernel('json-forin', payload, (data) => {
		let t = 0;
		for (let r = 0; r < 200; r++) t += walkForIn(data);
		return t;
	});

	// a virtual DOM diff: props compared by key, children by index
	function diffProps(prev, next, patch) {
		let changed = 0;
		for (const k in next)
			if (prev[k] !== next[k]) {
				patch[k] = next[k];
				changed++;
			}
		for (const k in prev)
			if (!(k in next)) {
				patch[k] = undefined;
				changed++;
			}
		return changed;
	}
	function diffTree(prev, next) {
		let t = diffProps(prev.props, next.props, {});
		const a = prev.children;
		const b = next.children;
		const n = a.length < b.length ? a.length : b.length;
		for (let i = 0; i < n; i++)
			if (a[i].tag === b[i].tag) t += diffTree(a[i], b[i]);
			else t += 100;
		return t + b.length - n;
	}
	const vnode = (depth, salt) => {
		const props = {
			className: 'c' + (depth % 3),
			id: 'n' + depth,
			title: salt % 4 === 0 ? 'changed' : 'same',
			'data-x': depth * salt,
		};
		if (salt % 3 === 0) props.hidden = true;
		const children = [];
		if (depth > 0)
			for (let i = 0; i < 4; i++) children.push(vnode(depth - 1, salt + i));
		return { tag: depth % 2 ? 'div' : 'span', props, children };
	};
	kernel(
		'vdom-diff',
		() => ({ prev: vnode(6, 1), next: vnode(6, 2) }),
		(s) => {
			let t = 0;
			for (let r = 0; r < 100; r++) t += diffTree(s.prev, s.next);
			return t;
		},
	);

	// a reactive store: a write by key notifies that key's subscribers
	// (closures kept in arrays in an object), which recompute derived state
	function makeStore(keys) {
		const state = {};
		const subs = {};
		const derived = {};
		for (let i = 0; i < keys.length; i++) {
			const key = keys[i];
			state[key] = i;
			subs[key] = [];
			for (let j = 0; j < 3; j++) {
				const name = key + '$' + j;
				subs[key].push((value) => {
					derived[name] = value * (j + 1) + state[keys[(i + 1) % keys.length]];
				});
			}
		}
		const set = (key, value) => {
			if (state[key] === value) return;
			state[key] = value;
			const list = subs[key];
			for (let i = 0; i < list.length; i++) list[i](value);
		};
		return { keys, state, derived, set };
	}
	kernel(
		'reactive',
		() => {
			const keys = [];
			for (let i = 0; i < 64; i++) keys.push('field' + i);
			return makeStore(keys);
		},
		(store) => {
			const { keys, set, derived } = store;
			for (let r = 0; r < 12000; r++)
				for (let i = 0; i < keys.length; i++) set(keys[i], r + i);
			let t = 0;
			for (const k in derived) t = (t + derived[k]) % 1000000007;
			return t;
		},
	);

	// records grouped into an object of arrays, then summed by key
	function groupBy(rows) {
		const groups = {};
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			(groups[row.kind] ||= []).push(row);
		}
		let t = 0;
		for (const kind in groups) {
			const list = groups[kind];
			for (let i = 0; i < list.length; i++) t += list[i].amount;
		}
		return t;
	}
	kernel(
		'group-by',
		() => {
			const rows = [];
			for (let i = 0; i < 20000; i++)
				rows.push({
					kind: 'k' + Math.floor(random() * 40),
					amount: i % 97,
				});
			return rows;
		},
		(rows) => {
			let t = 0;
			for (let r = 0; r < 150; r++) t += groupBy(rows);
			return t;
		},
	);

	// an object cloned key by key, as a state update copies it
	function clone(value) {
		if (typeof value !== 'object' || value === null) return value;
		if (Array.isArray(value)) {
			const list = [];
			for (let i = 0; i < value.length; i++) list.push(clone(value[i]));
			return list;
		}
		const out = {};
		for (const k in value) out[k] = clone(value[k]);
		return out;
	}
	kernel('deep-clone', payload, (data) => {
		let t = 0;
		for (let r = 0; r < 200; r++) t += clone(data).users.length;
		return t;
	});

	// string keys read and written, values that are numbers
	function readByKey(o, keys) {
		let t = 0;
		for (let i = 0; i < keys.length; i++) t += o[keys[i]];
		return t;
	}
	function writeByKey(o, keys, r) {
		for (let i = 0; i < keys.length; i++) o[keys[i]] = i + r;
	}
	const keyed = () => {
		const o = {};
		const keys = [];
		for (let i = 0; i < 200; i++) {
			keys.push('prop' + i);
			o['prop' + i] = i;
		}
		return { o, keys };
	};
	kernel('key-read', keyed, (s) => {
		let t = 0;
		for (let r = 0; r < 40000; r++) t += readByKey(s.o, s.keys);
		return t;
	});
	kernel(
		'key-write',
		keyed,
		(s) => {
			for (let r = 0; r < 40000; r++) writeByKey(s.o, s.keys, r);
			return 0;
		},
		(s) => readByKey(s.o, s.keys),
	);

	// handlers kept by event type, each list called in turn
	function emit(handlers, type, event) {
		const list = handlers[type];
		let t = 0;
		for (let i = 0; i < list.length; i++) t += list[i](event);
		return t;
	}
	kernel(
		'event-emit',
		() => {
			const handlers = {};
			const types = ['click', 'input', 'change', 'keydown', 'scroll'];
			for (let i = 0; i < types.length; i++) {
				handlers[types[i]] = [];
				for (let j = 0; j < 4; j++)
					handlers[types[i]].push((event) => event.value * (j + 1) + i);
			}
			return { handlers, types };
		},
		(s) => {
			let t = 0;
			for (let r = 0; r < 2000000; r++)
				t += emit(s.handlers, s.types[r % 5], { value: r & 15 });
			return t;
		},
	);

	const median = (values) => {
		const sorted = values.slice().sort((a, b) => a - b);
		return sorted[sorted.length >> 1];
	};
	const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

	/** runs the kernels (all, or `options.only`) and resolves to the report it also leaves on `window.__compute` */
	window.__computeRun = async (options = {}) => {
		const rounds = options.rounds || 5;
		const warm = options.warm === undefined ? 2 : options.warm;
		const report = { done: false, rounds, warm, order: [], kernels: {} };
		window.__compute = report;
		const chosen = kernels.filter(
			(entry) => !options.only || options.only.includes(entry.name),
		);
		// every kernel runs once before any is timed: the access helpers are
		// shared by every access of the page, the engine compiles them for
		// what they have seen, and on a page that does more than one thing
		// they have seen every kind of receiver and key. Timed one after
		// another from a cold start, the first kernels would have helpers
		// that know only their own kind, which no page gives them.
		const states = new Map();
		for (const entry of chosen) {
			states.set(entry, entry.make());
			entry.run(states.get(entry));
			await tick();
		}
		for (const entry of chosen) {
			const state = states.get(entry);
			let result = 0;
			for (let i = 0; i < warm; i++) result = entry.run(state);
			await tick();
			const times = [];
			for (let i = 0; i < rounds; i++) {
				const start = performance.now();
				result = entry.run(state);
				times.push(performance.now() - start);
			}
			report.order.push(entry.name);
			report.kernels[entry.name] = {
				ms: median(times),
				least: Math.min(...times),
				times,
				checksum: String(result + (entry.check ? entry.check(state) : 0)),
			};
			await tick();
		}
		report.done = true;
		return report;
	};
	window.__computeNames = kernels.map((entry) => entry.name);

	const given = window.__computeOptions;
	if (!given || !given.manual) {
		const query = new URLSearchParams(location.search);
		const only = query.get('only');
		window.__computeRun({
			rounds: Number(query.get('rounds')) || undefined,
			warm: query.has('warm') ? Number(query.get('warm')) : undefined,
			only: only ? only.split(',') : undefined,
			...(given || {}),
		});
	}
})();
