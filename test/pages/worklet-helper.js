// imported by worklet-processor.js through a relative specifier, and
// importing it back: a cycle, so this module runs first and calls a
// function of the processor's before the processor's module has run, as a
// page may (natively the function is there, hoisted)
import { cycled } from './worklet-processor.js';

export const scale = 10;
export const table = ['a', 'b', 'c'];
export const early = cycled(table, 'length');
