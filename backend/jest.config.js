/**
 * Minimal Jest setup. The repo has no broad test suite and this does not try to
 * start one — it exists so the pure, high-risk helpers (date/validity
 * arithmetic that silently broke production in Aug 2026) can be pinned down.
 * `npm test` still passes with no tests elsewhere.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
};
