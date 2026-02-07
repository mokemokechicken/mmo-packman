import type { RuntimeEvent, Snapshot } from '../shared/types.js';

export const DEFAULT_AOI_RADIUS_TILES = 12;

export function buildAoiSnapshot(snapshot: Snapshot, viewerPlayerId: string, spectator: boolean, radiusTiles = DEFAULT_AOI_RADIUS_TILES): Snapshot {
  if (spectator) {
    return snapshot;
  }

  const viewer = snapshot.players.find((player) => player.id === viewerPlayerId);
  if (!viewer) {
    return snapshot;
  }

  const isNear = (x: number, y: number): boolean => {
    return Math.abs(x - viewer.x) + Math.abs(y - viewer.y) <= radiusTiles;
  };
  const isNearSector = (x: number, y: number, size: number): boolean => {
    const maxX = x + size - 1;
    const maxY = y + size - 1;
    const nearestX = Math.max(x, Math.min(maxX, viewer.x));
    const nearestY = Math.max(y, Math.min(maxY, viewer.y));
    return Math.abs(nearestX - viewer.x) + Math.abs(nearestY - viewer.y) <= radiusTiles;
  };

  const players = snapshot.players.filter((player) => player.id === viewerPlayerId || isNear(player.x, player.y));
  const visiblePlayerIds = new Set(players.map((player) => player.id));
  const ghosts = snapshot.ghosts.filter((ghost) => isNear(ghost.x, ghost.y));
  const visibleGhostIds = new Set(ghosts.map((ghost) => ghost.id));
  const fruits = snapshot.fruits.filter((fruit) => isNear(fruit.x, fruit.y));
  const pings = snapshot.pings.filter((ping) => ping.ownerId === viewerPlayerId || isNear(ping.x, ping.y));
  const events = snapshot.events.filter((event) =>
    isEventVisible(event, snapshot, visiblePlayerIds, visibleGhostIds, isNear, isNearSector),
  );

  return {
    ...snapshot,
    players,
    ghosts,
    fruits,
    pings,
    events,
  };
}

function isEventVisible(
  event: RuntimeEvent,
  snapshot: Snapshot,
  visiblePlayerIds: Set<string>,
  visibleGhostIds: Set<string>,
  isNear: (x: number, y: number) => boolean,
  isNearSector: (x: number, y: number, size: number) => boolean,
): boolean {
  if (event.type === 'dot_eaten' || event.type === 'dot_respawned') {
    return true;
  }

  if (event.type === 'pellet_taken' || event.type === 'pellet_respawned') {
    return true;
  }

  if (event.type === 'player_down') {
    if (visiblePlayerIds.has(event.playerId)) {
      return true;
    }
    const target = snapshot.players.find((player) => player.id === event.playerId);
    return !!target && isNear(target.x, target.y);
  }

  if (event.type === 'player_revived') {
    if (visiblePlayerIds.has(event.playerId) || visiblePlayerIds.has(event.by)) {
      return true;
    }
    const target = snapshot.players.find((player) => player.id === event.playerId);
    return !!target && isNear(target.x, target.y);
  }

  if (event.type === 'sector_captured' || event.type === 'sector_lost') {
    const sector = snapshot.sectors.find((item) => item.id === event.sectorId);
    if (!sector) {
      return false;
    }
    return isNearSector(sector.x, sector.y, sector.size);
  }

  if (event.type === 'fruit_spawned') {
    return isNear(event.fruit.x, event.fruit.y);
  }

  if (event.type === 'fruit_taken') {
    return visiblePlayerIds.has(event.by);
  }

  if (event.type === 'boss_spawned' || event.type === 'boss_hit') {
    if (event.type === 'boss_hit' && visiblePlayerIds.has(event.by)) {
      return true;
    }
    return visibleGhostIds.has(event.ghostId);
  }

  if (event.type === 'toast') {
    return true;
  }

  return true;
}
