export class GoogleAccountLinkRequiredError extends Error {
  constructor() {
    super('An existing account must be linked while authenticated');
    this.name = GoogleAccountLinkRequiredError.name;
  }
}

export class GoogleOAuthFlowError extends Error {
  constructor(public readonly reason: string) {
    super('Google authentication could not be completed');
    this.name = GoogleOAuthFlowError.name;
  }
}
