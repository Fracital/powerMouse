// (uncontrolled-modules suite) an external module script: reports what its
// static imports gave it, and a dynamic import relative to itself
import * as deep from './deep/x/um-c.js';
import { a, aURL, bURL } from './um-a.js';

self.__um?.('external', {
	a,
	aURL: aURL.split('?')[0],
	bURL: bURL.split('?')[0],
	deep: deep.c,
	meta: import.meta.url.split('?')[0],
});
import('./um-b.js').then(
	(module) => self.__um?.('externalDynamic', module.b),
	(error) => self.__um?.('externalDynamic', error.name),
);
