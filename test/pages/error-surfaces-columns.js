// Code the rewriter writes something around (a member the access API
// reads, a call through it, a location, a write, a `new`, an eval), each
// throwing where its stack is taken, so every frame of this file says where
// the map the rewrite carries puts it: the error-surfaces suite holds each
// line and column to the native ones. The characters past ASCII on some
// lines count one or two UTF-16 units before the columns after them.
window.surfaces.columns = async () => {
	const stacks = {};
	const take = (name, fn) => {
		try {
			fn();
		} catch (error) {
			stacks[name] = error.stack;
		}
	};
	const o = {
		f() {
			throw new Error('member call');
		},
		get g() {
			throw new Error('getter');
		},
	};
	take('memberCall', () => o.f());
	take('computedCall', () => o['f']());
	take('getter', () => o.g);
	take('nullMember', () => {
		const a = null;
		return a.b.c;
	});
	take('missingCall', () => {
		const a = {};
		a.missing();
	});
	take(
		'newThrows',
		() =>
			new (class {
				constructor() {
					throw new Error('made');
				}
			})(),
	);
	take('afterLocation', () => {
		const here = location.href;
		o.f(here);
	});
	take('afterDocument', () => document.title.length + o.f());
	take('optional', () => o?.f?.());
	take('template', () => `${o.f()}`);
	take('nested', () => [1].map(() => o.f()));
	take('throughEval', () => eval('o.f()'));
	take('strictWrite', function () {
		'use strict';
		Object.freeze({}).x = 1;
	});
	take('wide', () => {
		const s = 'ü 😀 ü';
		o.f(s);
	});
	take('wideLater', () => ['é', '😀😀'][o.f()]);
	try {
		await (async () => {
			await null;
			o.f();
		})();
	} catch (error) {
		stacks.async = error.stack;
	}
	return stacks;
};
