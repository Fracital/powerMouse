const r = await fetch('/pages/echo.json');
postMessage(['module', (await r.json()).ok]);
