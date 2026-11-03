/**
 * Runs before every test file. Several modules refuse to load without
 * JWT_SECRET (services/tokens.ts), so any test that imports one — even
 * indirectly — fails to start unless the variable is set. CI sets a dummy
 * value (.github/workflows/ci.yml); this sets the same kind of dummy so a
 * plain `npm test` on a laptop or the server behaves like CI. A real value
 * already in the environment is left alone.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret';
