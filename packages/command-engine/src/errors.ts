export type ErrorCode =
  | 'NotFound' | 'LockedTrack' | 'LockedTrackConflict' | 'Collision' | 'InsufficientHandle' | 'RippleBlocked'
  | 'InvalidArgument' | 'NothingToDo' | 'Invariant' | 'GestureState' | 'MediaInUse' | 'NoTarget';
export class CommandError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details?: unknown) { super(message); this.name = 'CommandError'; }
}
export const fail = (code: ErrorCode, message: string, details?: unknown): never => { throw new CommandError(code, message, details); };
