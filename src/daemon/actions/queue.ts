// Une seule action git à la fois par workspace : deux `git worktree add` en parallèle se disputent les verrous.
export class WorkspaceQueue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(workspaceId: string, job: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(workspaceId) ?? Promise.resolve();
    const next = previous.then(job, job);
    const tail = next.catch(() => undefined);
    this.tails.set(workspaceId, tail);
    void tail.then(() => {
      if (this.tails.get(workspaceId) === tail) this.tails.delete(workspaceId);
    });
    return next;
  }
}
