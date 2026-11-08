// a module whose own import resolves against this module's URL
// (bypass-relative.html)
import './bypass-relative-mod2.js?rb=module-nested';

export const relative = true;
