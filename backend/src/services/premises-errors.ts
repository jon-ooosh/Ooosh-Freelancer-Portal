/**
 * The premises services' error: a message a person can act on, and the HTTP
 * status the route answers with. Its own file so premises.ts and
 * premises-library.ts can both use it without importing each other.
 */
export class PremisesError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
