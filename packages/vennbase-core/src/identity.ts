import { resolveBackend, resolveBackendAsync } from "./backend.js";
import { missingPuterClientMessage, signedOutError } from "./errors.js";
import type { VennbaseOptions } from "./vennbase.js";
import type { AuthSession, BackendClient, VennbaseUser } from "./types.js";

export class Identity {
  private cached: VennbaseUser | null = null;
  private session: AuthSession | null = null;
  private sessionPromise: Promise<AuthSession> | null = null;
  private backend: BackendClient | undefined;

  constructor(private readonly options: Pick<VennbaseOptions, "backend" | "identityProvider">) {
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
        signedIn: true,
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
        if (session.signedIn) {
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

  async whoAmI(): Promise<VennbaseUser> {
    const session = await this.getSession();
    if (!session.signedIn) {
      const backend = this.options.identityProvider ? undefined : await resolveBackendAsync(this.backend);
      this.backend = backend;
      if (!this.options.identityProvider && !backend) {
        throw signedOutError(missingPuterClientMessage());
      }
      throw signedOutError();
    }

    this.cached = session.user;
    return session.user;
  }

  async signIn(): Promise<VennbaseUser> {
    this.clear();

    if (this.options.identityProvider) {
      const user = await this.options.identityProvider();
      this.cached = user;
      this.session = {
        signedIn: true,
        user,
      };
      return user;
    }

    this.backend = await resolveBackendAsync(this.backend);
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
        signedIn: true,
        user,
      };
    }

    this.backend = await resolveBackendAsync(this.backend);

    const auth = this.backend?.auth;
    if (auth?.isSignedIn && !auth.isSignedIn()) {
      return { signedIn: false };
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
      return { signedIn: false };
    }

    return {
      signedIn: true,
      user: { username },
    };
  }
}
