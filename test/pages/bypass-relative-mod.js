// a module whose own import resolves against this module's URL
// (bypass-relative.html)
import './bypass-relative-mod2.js?rb=module-nested';

export const relative = true;

// a URL built on the module's own URL
fetch(new URL('../q/echo.json?rb=import-meta-url', import.meta.url)).catch(
	() => {},
);
