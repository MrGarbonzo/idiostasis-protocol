export class InvariantViolationError extends Error {
  constructor(
    public readonly invariant: string,
    public readonly details: string,
  ) {
    super(`Invariant violation [${invariant}]: ${details}`);
    this.name = 'InvariantViolationError';
  }
}

export class NodePausedError extends Error {
  constructor(public readonly operation: string) {
    super(`Node is paused — cannot perform: ${operation}`);
    this.name = 'NodePausedError';
  }
}
