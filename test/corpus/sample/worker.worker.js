// a classic worker: importScripts and self.location next to the worker's lead
importScripts("./a.js");onmessage=({data:{location:e}})=>postMessage(self.location.href+e);for(const{top:t}of[])t;
