'use strict';

require('dotenv').config();

const nconf = require('nconf');

// Precedence: argv > environment > localisation file > app defaults file.
// Secrets MUST come from the environment (see .env.example), not committed files.
nconf
  .argv()
  .env({ lowerCase: true, parseValues: true })
  .file('localisation', { file: `${__dirname}/../config/localisation.json` })
  .file({ file: `${__dirname}/../config/app.json` });

module.exports = nconf;
