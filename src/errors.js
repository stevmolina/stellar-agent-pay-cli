export class AgentPayConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentPayConfigError";
  }
}
