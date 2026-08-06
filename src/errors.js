export class AgentPayConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "AgentPayConfigError";
  }
}
