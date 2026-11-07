'use strict';

const { resolve } = require('node:path');

const stompPath = resolve(__dirname, '..', 'dist');

exports.stompPath = stompPath;
