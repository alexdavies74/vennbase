export type MutationStatus = "pending" | "committed" | "failed";

export interface MutationReceipt<TValue = void> {
  readonly value: TValue;
  readonly committed: Promise<TValue>;
  readonly status: MutationStatus;
  readonly error: unknown;
}

export interface MutableMutationReceipt<TValue = void> extends MutationReceipt<TValue> {
  resolve(value?: TValue): void;
  reject(error: unknown): void;
}

export function createMutationReceipt<TValue>(value: TValue): MutableMutationReceipt<TValue> {
  let status: MutationStatus = "pending";
  let error: unknown = undefined;
  let resolvePromise: (value: TValue) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;

  const committed = new Promise<TValue>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    value,
    committed,
    get status() {
      return status;
    },
    get error() {
      return error;
    },
    resolve(next = value) {
      if (status !== "pending") {
        return;
      }
      status = "committed";
      resolvePromise(next);
    },
    reject(nextError: unknown) {
      if (status !== "pending") {
        return;
      }
      status = "failed";
      error = nextError;
      rejectPromise(nextError);
    },
  };
}
