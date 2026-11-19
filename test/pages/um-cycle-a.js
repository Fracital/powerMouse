// (uncontrolled-modules suite) one half of an import cycle
import { y } from './um-cycle-b.js';

export const x = 'x';
export const both = () => `${x}${y}`;
