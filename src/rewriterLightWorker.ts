// The light rewriter library of the worker inject (src/rewriterLight.ts):
// scripts only, a worker has no stylesheets and no cookies
import { library } from './rewriterLight';

export const api = library({});
