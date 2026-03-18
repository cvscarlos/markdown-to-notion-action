import * as core from "@actions/core";

export type LogContext = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export const defaultLogContext: LogContext = {
  info: (message) => core.info(message),
  warn: (message) => core.warning(message),
};

export function createLogContext(prefix?: string): LogContext {
  if (!prefix) {
    return defaultLogContext;
  }

  return {
    info: (message) => core.info(`[${prefix}] ${message}`),
    warn: (message) => core.warning(`[${prefix}] ${message}`),
  };
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runStepWithLogging<T>(
  logContext: LogContext,
  startMessage: string,
  successMessage: string,
  operation: () => Promise<T>,
): Promise<T> {
  logContext.info(startMessage);
  try {
    const result = await operation();
    logContext.info(successMessage);
    return result;
  } catch (error) {
    logContext.warn(`${startMessage} Failed: ${describeError(error)}`);
    throw error instanceof Error ? error : new Error(String(error));
  }
}
