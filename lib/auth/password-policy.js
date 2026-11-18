'use strict';

/*
 * Server-side password policy. Applied wherever a password is set (registration,
 * password reset, user creation/edit) so client-side checks are never trusted.
 */

const MIN_LENGTH = 8;

function validatePassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, error: 'Password could not be blank' };
  }
  if (password.length < MIN_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_LENGTH} characters` };
  }
  return { ok: true };
}

module.exports = { validatePassword, MIN_LENGTH };
