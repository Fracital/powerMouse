// (uncontrolled-modules suite) a module a directory down that imports up
import { b } from '../../um-b.js';

export const c = `c+${b}`;
