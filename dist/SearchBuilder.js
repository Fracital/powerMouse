"use strict";(()=>{var r=/^(\S*?\.\S*|^localhost(:\d+)?)(\/.*?)?$/,s=/^https?:\/\//,t=class{template;constructor(e){this.template=e}query(e){return s.test(e)?e:r.test(e)?`http://${e}`:this.template.replace("%s",encodeURIComponent(e))}};Reflect.defineProperty(globalThis,"SearchBuilder",{value:t,configurable:!0,writable:!0});})();
//# sourceMappingURL=SearchBuilder.js.map
