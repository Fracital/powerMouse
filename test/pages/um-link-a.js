// (uncontrolled-modules suite) the first of a cycle of three modules (a
// imports b and c, b imports a and c, c imports a), which the browser runs
// c, b, a. What a cycle's modules see of each other natively: a function
// another declares before that one ran, a binding still in its temporal
// dead zone, a live binding, names `export *` brings, a namespace, an
// anonymous default export's name, each module's own top-level names and
// its own import.meta.
import {
	meta as bMeta,
	bump as bumpThrough,
	fromC,
	helpers,
	total,
} from './um-link-b.js';
import * as c from './um-link-c.js';
import named from './um-link-c.js';

(globalThis.__umLinkOrder ??= []).push('a');
const local = 'a';
function helper() {
	return local;
}
export function hoisted() {
	return 'hoisted';
}
export let count = 0;
export function bump() {
	return ++count;
}
const cut = (url) => String(url).split('?')[0];

export function report() {
	const before = total();
	bumpThrough();
	return {
		order: globalThis.__umLinkOrder.join(),
		early: c.early,
		tdz: c.tdz,
		live: [before, total(), count],
		fromC,
		namespace: [Object.keys(c).join(), c[Symbol.toStringTag]],
		defaultName: named.name,
		helpers: [helper.name, helper(), ...helpers(), ...c.helpersC()],
		metas: [import.meta.url, bMeta, c.meta].map(cut),
	};
}
