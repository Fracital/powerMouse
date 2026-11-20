// (uncontrolled-modules suite) a JSON module's import
import data from './um-data.json' with { type: 'json' };

self.__um?.('json', data.value);
