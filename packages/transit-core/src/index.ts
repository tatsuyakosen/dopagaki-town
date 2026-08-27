import { TransitGraphSchema, type TransitGraph } from "@dopagaki/contracts";
import type { StationMetadata } from "@dopagaki/world-core";

const DEPARTURE_INTERVALS_MS = [120_000, 180_000, 240_000] as const;

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function seededValue(seed: number, index: number): number {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

export function createFixtureTransitGraph(
  seed: number,
  stationMetadata: StationMetadata[],
  matchDurationMs = 600_000,
): TransitGraph {
  const stations = stationMetadata.slice(0, 6).map((station) => ({
    id: station.id,
    name: station.name,
    chunkId: station.chunkId,
    position: { ...station.position },
  }));
  if (stations.length < 4) throw new Error("Transit fixture requires at least four stations");

  const routes = stations.flatMap((station, index) => {
    const next = stations[(index + 1) % stations.length];
    if (!next) return [];
    const baseFare = 120 + positiveModulo(seededValue(seed, index), 5) * 20;
    const durationMs = 10_000 + positiveModulo(seededValue(seed, index + 100), 5) * 2_000;
    return [
      {
        id: `route-${station.id}-${next.id}`,
        fromStationId: station.id,
        toStationId: next.id,
        durationMs,
        fareYen: baseFare,
        transfers: 0,
      },
      {
        id: `route-${next.id}-${station.id}`,
        fromStationId: next.id,
        toStationId: station.id,
        durationMs,
        fareYen: baseFare,
        transfers: 0,
      },
    ];
  });

  const timetable = routes.flatMap((route, routeIndex) => {
    const intervalMs = DEPARTURE_INTERVALS_MS[
      positiveModulo(seededValue(seed, routeIndex + 200), DEPARTURE_INTERVALS_MS.length)
    ] ?? DEPARTURE_INTERVALS_MS[0];
    const firstDepartureAtMs = 8_000 + positiveModulo(seededValue(seed, routeIndex + 300), 4) * 3_000;
    const departures = [];
    const timetableHorizonMs = Math.max(matchDurationMs, firstDepartureAtMs);
    for (
      let departureAtMs = firstDepartureAtMs, sequence = 0;
      departureAtMs <= timetableHorizonMs;
      departureAtMs += intervalMs, sequence += 1
    ) {
      departures.push({
        id: `departure-${routeIndex + 1}-${sequence + 1}`,
        routeId: route.id,
        departureAtMs,
        arrivalAtMs: departureAtMs + route.durationMs,
      });
    }
    return departures;
  }).sort((left, right) => left.departureAtMs - right.departureAtMs || left.id.localeCompare(right.id));

  return TransitGraphSchema.parse({ source: "FIXTURE", seed, stations, routes, timetable });
}

export interface TransitAdapterOptions {
  seed: number;
  stations: StationMetadata[];
  matchDurationMs?: number;
  timeoutMs?: number;
  loadExternal?: () => Promise<unknown>;
}

export async function resolveTransitGraph(options: TransitAdapterOptions): Promise<TransitGraph> {
  const fallback = createFixtureTransitGraph(options.seed, options.stations, options.matchDurationMs);
  if (!options.loadExternal) return fallback;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Transit adapter timeout")), options.timeoutMs ?? 1_000);
    });
    const loaded = await Promise.race([options.loadExternal(), timeout]);
    return TransitGraphSchema.parse(loaded);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
