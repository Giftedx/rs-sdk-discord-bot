// Action types of the `switch (action.type)` in the pinned client's ActionExecutor.ts.
export const BLOCKED_ACTION_TYPES: ReadonlySet<string> = new Set(['interactPlayer', 'spellOnPlayer']);

export const ALLOWED_ACTION_TYPES: ReadonlySet<string> = new Set([
  'none', 'wait', 'walkTo', 'talkToNpc', 'interactNpc', 'interactLoc',
  'useInventoryItem', 'dropItem', 'pickupItem', 'clickDialogOption', 'searchGE',
  'clickComponent', 'clickComponentWithOption', 'useItemOnItem', 'useItemOnLoc',
  'useItemOnNpc', 'useEquipmentItem', 'shopBuy', 'shopSell', 'closeShop', 'closeModal',
  'setCombatStyle', 'setSpecialAttack', 'spellOnNpc', 'spellOnItem', 'spellOnGroundItem',
  'spellOnLoc', 'setTab', 'bankDeposit', 'bankWithdraw', 'submitCountDialog',
  'acceptCharacterDesign', 'randomizeCharacterDesign', 'interactGroundItem',
  'say', 'privateMessage', 'scanNearbyLocs', 'scanGroundItems', 'togglePrayer',
]);

export interface PolicyContext { jobActive: boolean; nowMs: number; }

export type Verdict =
  | { allow: true }
  | { allow: false; reason: 'no_job' | 'blocked_type' | 'unknown_type' | 'client_command' | 'chat_rate' | 'malformed' | 'logout_component' };

export interface ActionPolicy { check(action: unknown, ctx: PolicyContext): Verdict; }

// The logout button of the client. Only gamelink logs the account out (game-tab.ts), never a job.
export const LOGOUT_COMPONENT = 2458;
const COMPONENT_TYPES: ReadonlySet<string> = new Set(['clickComponent', 'clickComponentWithOption']);

const CHAT_TYPES: ReadonlySet<string> = new Set(['say', 'privateMessage']);
const WINDOW_MS = 60_000;

const deny = (reason: Exclude<Verdict, { allow: true }>['reason']): Verdict => ({ allow: false, reason });

export function createActionPolicy(opts: { chatPerMinute?: number } = {}): ActionPolicy {
  const limit = opts.chatPerMinute ?? 6;
  let chatTimes: number[] = [];

  return {
    check(action, ctx) {
      if (typeof action !== 'object' || action === null) return deny('malformed');
      const { type, message, componentId } = action as { type?: unknown; message?: unknown; componentId?: unknown };
      if (typeof type !== 'string') return deny('malformed');
      if (!ctx.jobActive) return deny('no_job');
      if (BLOCKED_ACTION_TYPES.has(type)) return deny('blocked_type');
      if (!ALLOWED_ACTION_TYPES.has(type)) return deny('unknown_type');
      if (COMPONENT_TYPES.has(type)) {
        // A plain whole number only: the check and the client must see the same component.
        if (typeof componentId !== 'number' || !Number.isInteger(componentId) || componentId < 0 || componentId > 0xffff) return deny('malformed');
        if (componentId === LOGOUT_COMPONENT) return deny('logout_component');
      }
      if (!CHAT_TYPES.has(type)) return { allow: true };

      if (typeof message !== 'string') return deny('malformed');
      if (message.trimStart().startsWith('::')) return deny('client_command');
      chatTimes = chatTimes.filter(t => t > ctx.nowMs - WINDOW_MS);
      if (chatTimes.length >= limit) return deny('chat_rate');
      chatTimes.push(ctx.nowMs);
      return { allow: true };
    },
  };
}
