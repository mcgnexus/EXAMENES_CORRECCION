import { EventEmitter } from 'node:events';

export interface BoardEvent {
  type: 'job' | 'submission';
  jobId?: number;
  submissionId?: number;
  status?: string;
  done?: number;
  total?: number;
}

export const eventBus = new EventEmitter();
eventBus.setMaxListeners(50);

export function emitEvent(event: BoardEvent): void {
  eventBus.emit('event', event);
}
