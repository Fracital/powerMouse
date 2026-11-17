### Fixes

- An identity request (`navigator.credentials.get({ identity })`) and
  `IdentityCredential.disconnect()` reject when FedCM's deferred part cannot
  be had (a part of another build, a failed load); they threw
  synchronously, where the browser's own calls only ever reject. They
  never reach the browser's get either way (deferred-refusals suite, new).
