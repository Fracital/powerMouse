// a module worker under a deeper path than its page: its static and dynamic
// imports and its fetch resolve against the worker script's URL, and an
// imported module's own import against that module's (bypass-relative.html)
import '../m/bypass-relative-mod.js?rb=module-worker-import';

import('../m/bypass-relative-mod.js?rb=module-worker-dynamic').catch(() => {});
fetch('../j/echo.json?rb=module-worker-fetch').catch(() => {});
