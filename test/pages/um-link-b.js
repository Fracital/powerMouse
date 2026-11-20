// (uncontrolled-modules suite) the second of a cycle of three modules
// (./um-link-a.js)
import { bump, count } from './um-link-a.js';

export * from './um-link-c.js';

(globalThis.__umLinkOrder ??= []).push('b');
const local = 'b';
function helper() {
	return local;
}
export const helpers = () => [helper.name, helper()];
export const total = () => count;
export const meta = import.meta.url;
export { bump };
