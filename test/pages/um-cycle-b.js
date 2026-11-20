// (uncontrolled-modules suite) the other half of an import cycle
import { x } from './um-cycle-a.js';

export const y = 'y';
export const seen = () => x;
