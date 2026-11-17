### Performance

- The Permissions module's requests and device id translation
  (`src/inject/dom/modules/permissionCalls.ts`), the WebRTC library's
  install (`src/inject/dom/rtcInstall.ts`), an XMLHttpRequest response's
  document (`xhrParse.ts`) and the messages of XHR's misuse exceptions
  (`xhrMessages.ts`) are deferred parts, made at a page's first such call;
  the hooks, the WebRTC stand-ins and the natives they take stay in the
  bundle. Without the parts each call refuses and none reaches the browser
  (deferred-refusals suite).
