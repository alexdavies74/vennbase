export class WriteSettler {
  private readonly queues = new Map<string, Promise<void>>();

  schedule<TValue>(
    key: string,
    task: () => Promise<TValue>,
    dependencies: Promise<unknown>[] = [],
  ): Promise<TValue> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (dependencies.length > 0) {
          await Promise.all(dependencies);
        }
        return task();
      });

    this.queues.set(key, next.then(() => undefined, () => undefined));
    return next;
  }
}
