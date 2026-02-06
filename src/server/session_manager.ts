import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';

interface ClientContextRecord {
  id: string;
  ws: WebSocket;
  playerId: string | null;
}

export type ClientContext = Readonly<ClientContextRecord>;

export class SessionManager {
  private readonly clients = new Map<string, ClientContextRecord>();
  private readonly activeClientByPlayerId = new Map<string, string>();

  public createClient(ws: WebSocket): ClientContext {
    const ctx: ClientContextRecord = {
      id: randomUUID(),
      ws,
      playerId: null,
    };
    this.clients.set(ctx.id, ctx);
    return ctx;
  }

  public removeClient(ctx: ClientContext): { boundPlayerId: string | null; wasActive: boolean } {
    const current = this.clients.get(ctx.id);
    if (!current) {
      return { boundPlayerId: null, wasActive: false };
    }

    this.clients.delete(ctx.id);
    const boundPlayerId = current.playerId;
    if (!boundPlayerId) {
      return { boundPlayerId: null, wasActive: false };
    }

    const wasActive = this.activeClientByPlayerId.get(boundPlayerId) === ctx.id;
    if (wasActive) {
      this.activeClientByPlayerId.delete(boundPlayerId);
    }
    return { boundPlayerId, wasActive };
  }

  public bindClientToPlayer(ctx: ClientContext, playerId: string): void {
    const current = this.clients.get(ctx.id);
    if (!current) {
      return;
    }

    const oldClientId = this.activeClientByPlayerId.get(playerId);

    if (oldClientId && oldClientId !== current.id) {
      const oldClient = this.clients.get(oldClientId) ?? null;
      if (oldClient) {
        oldClient.playerId = null;
        if (oldClient.ws.readyState === oldClient.ws.OPEN) {
          oldClient.ws.close(4001, 'superseded by new connection');
        }
      }
    }

    if (current.playerId && current.playerId !== playerId) {
      this.activeClientByPlayerId.delete(current.playerId);
    }

    current.playerId = playerId;
    this.activeClientByPlayerId.set(playerId, current.id);
  }

  public resetBinding(ctx: ClientContext): void {
    const current = this.clients.get(ctx.id);
    if (!current || !current.playerId) {
      return;
    }
    if (this.activeClientByPlayerId.get(current.playerId) === current.id) {
      this.activeClientByPlayerId.delete(current.playerId);
    }
    current.playerId = null;
  }

  public getClientByPlayerId(playerId: string): ClientContext | null {
    const clientId = this.activeClientByPlayerId.get(playerId);
    if (!clientId) {
      return null;
    }
    return this.clients.get(clientId) ?? null;
  }

  public listClients(): IterableIterator<ClientContext> {
    return this.clients.values() as IterableIterator<ClientContext>;
  }

  public isActiveClient(ctx: ClientContext): boolean {
    const current = this.clients.get(ctx.id);
    if (!current || !current.playerId) {
      return false;
    }
    return this.activeClientByPlayerId.get(current.playerId) === current.id;
  }
}
