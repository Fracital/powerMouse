// (uncontrolled-modules suite) a module with a static import of its sibling
import { b, bURL } from './um-b.js';

export const a = `a+${b}`;
export const aURL = import.meta.url;
export { bURL };
