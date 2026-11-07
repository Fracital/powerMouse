// A worker that fails at startup: the page reads ErrorEvent.filename.
throw new Error('adv-worker-boom');
