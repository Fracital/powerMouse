// a worker whose script throws at its top level: register() rejects
throw new Error('boom');
