export type ServiceState = 'idle' | 'starting' | 'ready' | 'crashed' | 'stopped';
export type ServiceEvent = { type: 'START' } | { type: 'READY' } | { type: 'CRASH' } | { type: 'STOP' } | { type: 'STOPPED' };

export function transition(s: ServiceState, e: ServiceEvent): ServiceState {
  switch (s) {
    case 'idle':     return e.type === 'START' ? 'starting' : s;
    case 'starting': return e.type === 'READY' ? 'ready' : e.type === 'CRASH' ? 'crashed' : s;
    case 'ready':    return e.type === 'CRASH' ? 'crashed' : e.type === 'STOP' ? 'stopped' : s;
    case 'crashed':  return e.type === 'START' ? 'starting' : e.type === 'STOP' ? 'stopped' : s;
    default:         return s;
  }
}
