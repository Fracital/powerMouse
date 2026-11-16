// module goal: imports, exports and top-level await next to rewritten accesses
import{a as b}from"./a.js";import*as c from"./c.js";export{b as location};export const top=b.top;
export default location.href;const{href:h}=await import("./d.js").then(e=>e.location);
for(const{location:t}of await c.all())b(t);export*from"./e.js";
const u=import.meta.url,w=new Worker(new URL("./w.js",import.meta.url),{type:"module"});
