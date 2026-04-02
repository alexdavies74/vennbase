import type { Identity } from "./identity.js";
import type { Provisioning } from "./provisioning.js";
import type { MemberRole, RowRef } from "./schema.js";
import type { Transport } from "./transport.js";
import { buildRowUrl, normalizeBaseUrl } from "./transport.js";
import type { JoinOptions, VennbaseUser, Row, RowSnapshot } from "./types.js";

interface PostMessageResponse {
  message: { sequence: number };
}

interface JoinRowResponse {
  role: MemberRole;
}

export interface PlannedRowState {
  user: VennbaseUser;
  federationWorkerUrl: string;
}

export interface PlannedRow {
  row: Row;
  ref: RowRef;
}

export class RowRuntime {
  private plannedState: PlannedRowState | null = null;

  constructor(
    private readonly transport: Transport,
    private readonly identity: Identity,
    private readonly provisioning: Provisioning,
    private readonly ensureMutationBootstrap: () => Promise<void>,
  ) {}

  setPlannedState(state: PlannedRowState): void {
    this.plannedState = state;
  }

  clearPlannedState(): void {
    this.plannedState = null;
  }

  assertPlannedState(): PlannedRowState {
    if (!this.plannedState) {
      throw new Error("Vennbase client has not finished mutation bootstrap.");
    }

    return this.plannedState;
  }

  planRow(name: string): PlannedRow {
    const state = this.assertPlannedState();
    const rowId = this.transport.createId("row");
    const baseUrl = normalizeBaseUrl(state.federationWorkerUrl);

    return {
      row: {
        id: rowId,
        name,
        owner: state.user.username,
        baseUrl,
        createdAt: Date.now(),
      },
      ref: {
        id: rowId,
        collection: "unknown",
        baseUrl,
      },
    };
  }

  async commitPlannedRow(plan: PlannedRow): Promise<Row> {
    const state = this.assertPlannedState();
    await this.transport.request({
      url: `${state.federationWorkerUrl}/rows`,
      action: "rows/create",
      rowId: plan.row.id,
      payload: {
        rowId: plan.row.id,
        rowName: plan.row.name,
      },
    });

    const row = await this.joinRow(plan.ref, {});
    return {
      id: row.id,
      name: row.name,
      owner: row.owner,
      baseUrl: row.baseUrl,
      createdAt: row.createdAt,
    };
  }

  async createRow(name: string): Promise<Row> {
    await this.ensureMutationBootstrap();
    const user = await this.identity.whoAmI();
    const federationWorkerUrl = await this.provisioning.getUsableFederationWorkerUrl(user.username);
    this.setPlannedState({ user, federationWorkerUrl });
    return this.commitPlannedRow(this.planRow(name));
  }

  async joinMembership(rowRef: Pick<RowRef, "id" | "baseUrl">, options: JoinOptions = {}): Promise<MemberRole> {
    const user = await this.identity.whoAmI();
    const row = this.transport.row(rowRef);

    const response = await row.request<JoinRowResponse>("row/join", {
      username: user.username,
      inviteToken: options.inviteToken,
    });

    return response.role;
  }

  async joinRow(rowRef: Pick<RowRef, "id" | "baseUrl">, options: JoinOptions = {}): Promise<Row> {
    await this.joinMembership(rowRef, options);

    const snapshot = await this.getRow(rowRef);
    return {
      id: snapshot.id,
      name: snapshot.name,
      owner: snapshot.owner,
      baseUrl: snapshot.baseUrl,
      createdAt: snapshot.createdAt,
    };
  }

  async getRow(rowRef: Pick<RowRef, "id" | "baseUrl">): Promise<RowSnapshot> {
    return this.transport.row(rowRef).request<RowSnapshot>("row/get", {});
  }

  async listMembers(rowRef: Pick<RowRef, "id" | "baseUrl">): Promise<string[]> {
    const snapshot = await this.getRow(rowRef);
    return snapshot.members;
  }

  async sendSyncMessage(rowRef: Pick<RowRef, "id" | "baseUrl">, body: unknown): Promise<{ sequence: number }> {
    const payload = {
      id: this.transport.createId("msg"),
      rowId: rowRef.id,
      body,
      createdAt: Date.now(),
    };

    const response = await this.transport.row(rowRef).request<PostMessageResponse>("sync/send", payload);

    return response.message;
  }

  async pollSyncMessages(
    rowRef: Pick<RowRef, "id" | "baseUrl">,
    sinceSequence: number,
  ): Promise<{ messages: Array<{ body: unknown; sequence: number; createdAt: number; id: string }>; latestSequence: number }> {
    return this.transport.row(rowRef).request("sync/poll", { sinceSequence });
  }
}
