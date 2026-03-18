import { resolveBackend } from "./backend";
import { missingPuterClientMessage, signedOutError } from "./errors";
import type { PutBaseOptions } from "./putbase";
import type { AuthSession, BackendClient, PutBaseUser } from "./types";

export class Identity {
  private cached: PutBaseUser | null = null;
  private session: AuthSession | null = null;
  private sessionPromise: Promise<AuthSession> | null = null;
  private backend: BackendClient | undefined;

  constructor(private readonly options: Pick<PutBaseOptions, "backend" | "identityProvider">) {
    this.backend = resolveBackend(options.backend);
  }

  setBackend(backend: BackendClient | undefined): void {
    const resolved = resolveBackend(backend);
    if (this.backend !== resolved) {
      this.clear();
    }
    this.backend = resolved;
  }

  clear(): void {
    this.cached = null;
    this.session = null;
    this.sessionPromise = null;
  }

  async getSession(): Promise<AuthSession> {
    if (this.cached) {
      return {
        state: "signed-in",
        user: this.cached,
      };
    }

    if (this.session) {
      return this.session;
    }

    if (this.sessionPromise) {
      return this.sessionPromise;
    }

    const promise = this.resolveSession()
      .then((session) => {
        if (session.state === "signed-in") {
          this.session = session;
          this.cached = session.user;
        }
        return session;
      })
      .finally(() => {
        if (this.sessionPromise === promise) {
          this.sessionPromise = null;
        }
      });
    this.sessionPromise = promise;
    return promise;
  }

  async whoAmI(): Promise<PutBaseUser> {
    const session = await this.getSession();
    if (session.state !== "signed-in") {
      if (!this.options.identityProvider && !resolveBackend(this.backend)) {
        throw signedOutError(missingPuterClientMessage());
      }
      throw signedOutError();
    }

    this.cached = session.user;
    return session.user;
  }

  async signIn(): Promise<PutBaseUser> {
    this.clear();

    if (this.options.identityProvider) {
      const user = await this.options.identityProvider();
      this.cached = user;
      this.session = {
        state: "signed-in",
        user,
      };
      return user;
    }

    this.backend = resolveBackend(this.backend);
    const auth = this.backend?.auth;
    if (!auth?.signIn) {
      throw signedOutError(missingPuterClientMessage());
    }

    await auth.signIn();
    const user = await this.whoAmI();
    return user;
  }

  private async resolveSession(): Promise<AuthSession> {
    if (this.options.identityProvider) {
      const user = await this.options.identityProvider();
      return {
        state: "signed-in",
        user,
      };
    }

    this.backend = resolveBackend(this.backend);

    const auth = this.backend?.auth;
    if (auth?.isSignedIn && !auth.isSignedIn()) {
      return { state: "signed-out" };
    }

    let candidate: { username?: string } | null = null;

    if (auth?.getUser) {
      candidate = await auth.getUser().catch(() => null);
    }

    if (!candidate?.username && auth?.whoami) {
      candidate = await auth.whoami().catch(() => candidate);
    }

    if (!candidate?.username && this.backend?.getUser) {
      candidate = await this.backend.getUser().catch(() => null);
    }

    const username = candidate?.username?.trim();
    if (!username) {
      return { state: "signed-out" };
    }

    return {
      state: "signed-in",
      user: { username },
    };
  }
}
