/** Shared typed outcome; each entry point chooses JSON or framework navigation. */
export class AuthorizationError extends Error {
  constructor(
    public readonly destination:
      "/auth/login" | "/auth/approval" | "/auth/inactive",
  ) {
    super("Your access has changed. Please sign in again.");
  }
}
