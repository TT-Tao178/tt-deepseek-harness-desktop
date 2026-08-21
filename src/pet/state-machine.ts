// v6.1 §2.3 桌宠状态机（纯函数；气泡为 UI 叠加层，不属于状态）
export type PetState = 'idle'|'wander'|'hover'|'click'|'dragging'|'sleep'|'wake'|'working'|'workingProgress'|'happy'|'sad'|'absorb'|'absorbed'|'release';
export type PetEvent =
  | { type: 'TIMER_WANDER' } | { type: 'HOVER' } | { type: 'CLICK' } | { type: 'DRAG_START' } | { type: 'DRAG_END' }
  | { type: 'IDLE_TIMEOUT' } | { type: 'WAKE' } | { type: 'TASK_STARTED' } | { type: 'TASK_PROGRESS' }
  | { type: 'TASK_DONE' } | { type: 'TASK_ERROR' } | { type: 'ABSORB' } | { type: 'RELEASE' }
  | { type: 'ANIM_DONE' };

// 交互/任务优先级：click/dragging > working* > wander/sleep；非法转移保持原状态
export function petTransition(s: PetState, e: PetEvent): PetState {
  switch (s) {
    case 'idle':
      if (e.type === 'TIMER_WANDER') return 'wander';
      if (e.type === 'HOVER') return 'hover';
      if (e.type === 'CLICK') return 'click';
      if (e.type === 'DRAG_START') return 'dragging';
      if (e.type === 'IDLE_TIMEOUT') return 'sleep';
      if (e.type === 'TASK_STARTED') return 'working';
      if (e.type === 'TASK_PROGRESS') return 'workingProgress';
      if (e.type === 'TASK_DONE') return 'happy';
      if (e.type === 'TASK_ERROR') return 'sad';
      if (e.type === 'ABSORB') return 'absorb';
      if (e.type === 'RELEASE') return 'release';
      return s;
    case 'wander':
      if (e.type === 'HOVER') return 'hover';
      if (e.type === 'CLICK') return 'click';
      if (e.type === 'DRAG_START') return 'dragging';
      if (e.type === 'IDLE_TIMEOUT') return 'sleep';
      if (e.type === 'TASK_STARTED') return 'working';
      if (e.type === 'ABSORB') return 'absorb';
      if (e.type === 'ANIM_DONE') return 'idle';
      return s;
    case 'hover':
      if (e.type === 'CLICK') return 'click';
      if (e.type === 'DRAG_START') return 'dragging';
      if (e.type === 'TASK_STARTED') return 'working';
      if (e.type === 'ANIM_DONE') return 'idle';
      return s;
    case 'click':
      if (e.type === 'DRAG_START') return 'dragging';
      if (e.type === 'TASK_STARTED') return 'working';
      if (e.type === 'ANIM_DONE') return 'idle';
      return s;
    case 'dragging':
      if (e.type === 'DRAG_END') return 'idle';
      return s;
    case 'sleep':
      if (e.type === 'HOVER' || e.type === 'CLICK' || e.type === 'WAKE') return 'wake';
      if (e.type === 'TASK_STARTED') return 'working';
      if (e.type === 'ABSORB') return 'absorb';
      return s;
    case 'wake':
      if (e.type === 'CLICK') return 'click';
      if (e.type === 'TASK_STARTED') return 'working';
      if (e.type === 'ANIM_DONE') return 'idle';
      return s;
    case 'working':
      if (e.type === 'TASK_PROGRESS') return 'workingProgress';
      if (e.type === 'TASK_DONE') return 'happy';
      if (e.type === 'TASK_ERROR') return 'sad';
      if (e.type === 'CLICK') return 'click';
      if (e.type === 'DRAG_START') return 'dragging';
      if (e.type === 'ANIM_DONE') return 'idle';
      return s;
    case 'workingProgress':
      if (e.type === 'TASK_PROGRESS') return 'workingProgress';
      if (e.type === 'TASK_DONE') return 'happy';
      if (e.type === 'TASK_ERROR') return 'sad';
      if (e.type === 'CLICK') return 'click';
      if (e.type === 'DRAG_START') return 'dragging';
      return s;
    case 'happy':
    case 'sad':
      if (e.type === 'CLICK') return 'click';
      if (e.type === 'TASK_STARTED') return 'working';
      if (e.type === 'ANIM_DONE') return 'idle';
      return s;
    case 'absorb':
      if (e.type === 'ANIM_DONE') return 'absorbed';
      if (e.type === 'CLICK') return 'click';
      return s;
    case 'absorbed':
      if (e.type === 'CLICK' || e.type === 'RELEASE') return 'release';
      if (e.type === 'TASK_STARTED') return 'working';
      return s;
    case 'release':
      if (e.type === 'CLICK') return 'click';
      if (e.type === 'TASK_STARTED') return 'working';
      if (e.type === 'ANIM_DONE') return 'idle';
      return s;
    default:
      return s;
  }
}
