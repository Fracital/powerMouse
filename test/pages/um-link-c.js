// (uncontrolled-modules suite) the third of a cycle of three modules
// (./um-link-a.js), which runs first: before a ran
import { count, hoisted } from './um-link-a.js';

(globalThis.__umLinkOrder ??= []).push('c');
const local = 'c';
function helper() {
	return local;
}
export const helpersC = () => [helper.name, helper()];
export const early = hoisted();
let tdz = 'none';
try {
	tdz = String(count);
} catch (error) {
	tdz = error.name;
}
export { tdz };
export const fromC = 'c';
export const meta = import.meta.url;
export default function () {}
