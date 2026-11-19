// (uncontrolled-modules suite) a module whose static import is not there:
// it never runs, and its script fires error
import './um-not-there.js';

self.__um?.('missingRan', 'ran');
