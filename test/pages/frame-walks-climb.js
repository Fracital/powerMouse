// What a measurement tag in a child of a safe frame does (DoubleVerify's
// locateCmpApi on nytimes): climbs `t = t.parent` until it reaches `top`,
// reading a property of each window on the way, which throws for one of
// another origin. Natively it takes two steps. Bounded: a climb that never
// ends is a count, and the timed one stops at two seconds instead of
// hanging the tab. Then every way this window reaches the top and its
// frames is compared with the others, in window.__fwb.
(() => {
	const result = {};
	const record = (name, fn) => {
		try {
			result[name] = fn();
		} catch (error) {
			result[name] = `threw ${error.name}`;
		}
	};
	record('climb', () => {
		let steps = 0;
		for (let t = window; t !== top && steps < 20; t = t.parent) steps++;
		return steps;
	});
	record('climbLoose', () => {
		let steps = 0;
		for (let t = window; t != top && steps < 20; t = t.parent) steps++;
		return steps;
	});
	record('climbTimed', () => {
		const start = performance.now();
		let t = window;
		let steps = 0;
		while (performance.now() - start < 2000) {
			try {
				void t.__cmp;
			} catch (error) {
				// a window of another origin, as natively
			}
			if (t === top) return steps;
			t = t.parent;
			steps++;
		}
		return 'timed out';
	});
	record('parentParentIsTop', () => parent.parent === top);
	record('parentParentIsParentTop', () => parent.parent === parent.top);
	record('parentTopIsTop', () => parent.top === top);
	record('topParentIsTop', () => top.parent === top);
	record('topTopIsTop', () => top.top === top);
	record('parentParentParent', () => parent.parent.parent === parent.parent);
	record('objectIs', () => Object.is(parent.parent, top));
	record('selfAndWindow', () => [
		top.self === top,
		top.window === top,
		top.frames === top,
		parent.parent.window === top,
	]);
	record('weakMapKey', () => {
		const map = new WeakMap([[top, 1]]);
		return [map.get(parent.parent), map.get(parent.top), map.has(top.parent)];
	});
	// the safe frame's own `top`, kept by its realm, and its children's
	record('heldTop', () => [
		parent.__top === top,
		parent.__top === parent.parent,
		parent.__parent === top,
	]);
	const peer = 0;
	const ad = 1;
	record('framesIndex', () => [top.frames[ad] === parent, top[ad] === parent]);
	record('framesLiteral', () => [top[1] === parent, top.frames[1] === parent]);
	record('peerSame', () => top[peer] === top.frames[peer]);
	// the frame of this origin with no sandbox: what it read of the top,
	// and what its window reads now
	record('peerTop', () => [
		top[peer].__top === top,
		top[peer].__parent === top,
		top[peer].parent === top,
		top[peer].top === top,
		top[peer].parent === parent.parent,
	]);
	const own = window.__who === 'blank' ? 0 : 1;
	record('ownFrame', () => [
		parent.frames[own] === window,
		parent[own] === window,
		top[ad][own] === window,
		top.frames[ad].frames[own] === window,
	]);
	record('opener', () => [
		parent.opener === null,
		top.opener === null,
		top[peer].opener === null,
	]);
	result.done = true;
	window.__fwb = result;
})();
