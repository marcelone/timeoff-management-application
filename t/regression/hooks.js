'use strict';

const { init, cleanup } = require('./helper');

module.exports = {
  mochaHooks: {
    beforeAll: async () => { await init(); },
    afterAll: async () => { await cleanup(); },
  },
};
