import type { Identity } from "./identity";
import type { Provisioning } from "./provisioning";
import type { RowRef } from "./schema";
import type { Transport } from "./transport";
import { buildRowUrl, normalizeBaseUrl } from "./transport";
import type { JoinOptions, CoveDBUser, Row, RowSnapshot } from "./types";

interface PostMessageResponse {
  message: { sequence: number };
}

export interface PlannedRowState {
  user: CoveDBUser;
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
    private readonly ensureReady: () => Promise<void>,
  ) {}

  setPlannedState(state: PlannedRowState): void {
    this.plannedState = state;
  }

  clearPlannedState(): void {
    this.plannedState = null;
  }

  assertPlannedState(): PlannedRowState {
    if (!this.plannedState) {
      throw new Error("CoveDB client is not ready. Call ensureReady() before mutating.");
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

    await this.joinRow(plan.ref, {});

    const row = await this.getRow(plan.ref);
    return {
      id: row.id,
      name: row.name,
      owner: row.owner,
      baseUrl: row.baseUrl,
      createdAt: row.createdAt,
    };
  }

  async createRow(name: string): Promise<Row> {
    await this.ensureReady();
    const user = await this.identity.whoAmI();
    const federationWorkerUrl = await this.provisioning.getFederationWorkerUrl(user.username);
    this.setPlannedState({ user, federationWorkerUrl });
    return this.commitPlannedRow(this.planRow(name));
  }

  async joinRow(rowRef: Pick<RowRef, "id" | "baseUrl">, options: JoinOptions = {}): Promise<Row> {
    const user = await this.identity.whoAmI();
    const row = this.transport.row(rowRef);

    await row.request("row/join", {
      username: user.username,
      inviteToken: options.inviteToken,
    });

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
