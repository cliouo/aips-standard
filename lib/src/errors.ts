/**
 * Refract Error taxonomy — see STANDARD.md §8 and Appendix B
 */

export class RefractError extends Error {
  constructor(
    public readonly code: string,
    public readonly messageForUser: string,
    public readonly messageForAI: string,
    public readonly httpStatus: number,
    public readonly retryable: boolean = false,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(messageForAI);
    this.name = 'RefractError';
  }

  toJSON() {
    return {
      error: this.code,
      message_for_user: this.messageForUser,
      message_for_ai: this.messageForAI,
      retryable: this.retryable,
      ...this.extra,
    };
  }
}

export const errors = {
  invalidInput: (msg: string, field?: string) =>
    new RefractError('INVALID_INPUT', msg, msg, 400, false, field ? { field } : {}),

  unauthorized: (msg = 'Authentication required') =>
    new RefractError('UNAUTHORIZED', '请先登录', msg, 401),

  permissionDenied: (msg = 'Permission denied') =>
    new RefractError('PERMISSION_DENIED', '无权执行此操作', msg, 403),

  notFound: (resource: string) =>
    new RefractError('NOT_FOUND', `${resource} 不存在`, `${resource} not found`, 404),

  conflict: (msg: string) => new RefractError('CONFLICT', msg, msg, 409),

  pendingConfirmation: (token: string, summary: string, expiresAt: string) =>
    new RefractError(
      'PENDING_CONFIRMATION',
      summary,
      `Confirmation required: ${summary}`,
      409,
      true,
      { status: 'PENDING_CONFIRMATION', confirmation_token: token, summary, expires_at: expiresAt },
    ),

  needsClarification: (question: string, candidates: unknown[]) =>
    new RefractError('NEEDS_CLARIFICATION', question, question, 422, true, { candidates }),

  rateLimited: (retryAfterSec: number) =>
    new RefractError(
      'RATE_LIMITED',
      `请稍后再试（${retryAfterSec} 秒后）`,
      `Rate limited, retry after ${retryAfterSec}s`,
      429,
      true,
      { retry_after: retryAfterSec },
    ),

  loopDetected: () =>
    new RefractError(
      'LOOP_DETECTED',
      '检测到重复调用',
      'Detected repeated identical call',
      429,
      false,
    ),

  budgetExceeded: () =>
    new RefractError(
      'BUDGET_EXCEEDED',
      '已超出今日 AI 使用额度',
      'User token budget exceeded',
      429,
      false,
    ),

  neverAllowed: (action: string) =>
    new RefractError(
      'NEVER_ALLOWED',
      '该操作不允许通过 AI 执行',
      `Action ${action} is on the never-list`,
      403,
      false,
    ),

  internalError: (msg = 'Internal error') =>
    new RefractError('INTERNAL_ERROR', '内部错误，请稍后重试', msg, 500),
};

export type Errors = typeof errors;
