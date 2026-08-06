export class AgentPayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentPayConfigError";
  }
}
