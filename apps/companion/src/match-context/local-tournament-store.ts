import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { MatchDocumentV1, ScheduleWindowV1 } from '@mizar/core/match-context';
import {
  matchPlayerV1Schema,
  parseMatchDocumentV1,
  parseScheduleWindowV1,
} from '@mizar/protocol/context';

import { replaceDurableJson } from './durable-json.js';
import { SerialCommitQueue } from './serial-commit.js';

export const LOCAL_TOURNAMENT_STORE_VERSION = 'mizar.local-tournament-store.v1' as const;

export interface LocalEventV1 {
  readonly eventId: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly themeColor: string | null;
  readonly mapPool: readonly string[];
  readonly matchIds: readonly string[];
}

export interface LocalTeamV1 {
  readonly teamId: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly players: MatchDocumentV1['entrants']['a']['players'];
}

interface LocalTournamentState {
  readonly version: typeof LOCAL_TOURNAMENT_STORE_VERSION;
  readonly events: readonly LocalEventV1[];
  readonly teams: readonly LocalTeamV1[];
  readonly matches: readonly MatchDocumentV1[];
  readonly selectedMatchId: string | null;
  readonly selectedAt: string | null;
}

const emptyState = (): LocalTournamentState => ({
  version: LOCAL_TOURNAMENT_STORE_VERSION,
  events: [],
  teams: [],
  matches: [],
  selectedMatchId: null,
  selectedAt: null,
});

function readState(input: unknown): LocalTournamentState {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error('local_store_invalid');
  const value = input as Record<string, unknown>;
  if (
    value.version !== LOCAL_TOURNAMENT_STORE_VERSION ||
    !Array.isArray(value.events) ||
    !Array.isArray(value.teams) ||
    !Array.isArray(value.matches) ||
    !(value.selectedMatchId === null || typeof value.selectedMatchId === 'string') ||
    !(
      value.selectedAt === null ||
      (typeof value.selectedAt === 'string' && Number.isFinite(Date.parse(value.selectedAt)))
    )
  )
    throw new Error('local_store_invalid');
  const matches = value.matches.map(parseMatchDocumentV1);
  if (matches.length > 256 || value.events.length > 32 || value.teams.length > 128)
    throw new Error('local_store_too_large');
  const events = value.events.map((event): LocalEventV1 => {
    if (typeof event !== 'object' || event === null) throw new Error('local_event_invalid');
    const item = event as Record<string, unknown>;
    if (
      typeof item.eventId !== 'string' ||
      typeof item.name !== 'string' ||
      !Array.isArray(item.matchIds) ||
      !item.matchIds.every((id) => typeof id === 'string') ||
      !Array.isArray(item.mapPool) ||
      !item.mapPool.every((name) => typeof name === 'string') ||
      !(item.logoUrl === null || typeof item.logoUrl === 'string') ||
      !(item.themeColor === null || typeof item.themeColor === 'string')
    )
      throw new Error('local_event_invalid');
    return {
      eventId: item.eventId,
      name: item.name,
      logoUrl: item.logoUrl,
      themeColor: item.themeColor,
      mapPool: item.mapPool,
      matchIds: item.matchIds,
    };
  });
  const teams = value.teams.map((team): LocalTeamV1 => {
    if (typeof team !== 'object' || team === null) throw new Error('local_team_invalid');
    const item = team as Record<string, unknown>;
    if (
      typeof item.teamId !== 'string' ||
      typeof item.name !== 'string' ||
      !(item.logoUrl === null || typeof item.logoUrl === 'string') ||
      !Array.isArray(item.players)
    )
      throw new Error('local_team_invalid');
    return {
      teamId: item.teamId,
      name: item.name,
      logoUrl: item.logoUrl,
      players: item.players.map((player) => matchPlayerV1Schema.parse(player)),
    };
  });
  const selectedMatchId = value.selectedMatchId;
  const selectedAt = value.selectedAt;
  if (selectedMatchId !== null && !matches.some((match) => match.matchId === selectedMatchId))
    throw new Error('local_selection_invalid');
  if ((selectedMatchId === null) !== (selectedAt === null))
    throw new Error('local_selection_invalid');
  const matchIds = new Set(matches.map((match) => match.matchId));
  if (
    new Set(events.map((event) => event.eventId)).size !== events.length ||
    new Set(teams.map((team) => team.teamId)).size !== teams.length ||
    new Set(matches.map((match) => match.matchId)).size !== matches.length ||
    events.some(
      (event) =>
        new Set(event.matchIds).size !== event.matchIds.length ||
        event.matchIds.some(
          (id) =>
            !matchIds.has(id) ||
            matches.find((match) => match.matchId === id)?.competition.competitionId !==
              event.eventId,
        ),
    ) ||
    matches.some(
      (match) =>
        !events.some(
          (event) =>
            event.eventId === match.competition.competitionId &&
            event.matchIds.includes(match.matchId),
        ),
    )
  )
    throw new Error('local_store_identity_invalid');
  return {
    version: LOCAL_TOURNAMENT_STORE_VERSION,
    events,
    teams,
    matches,
    selectedMatchId,
    selectedAt,
  };
}

export class LocalTournamentStore {
  private state: LocalTournamentState = emptyState();
  private readonly queue = new SerialCommitQueue();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const bytes = await readFile(this.filePath, 'utf8');
      if (Buffer.byteLength(bytes) > 2_000_000) throw new Error('local_store_too_large');
      this.state = readState(JSON.parse(bytes));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  getSnapshot(): LocalTournamentState {
    return this.state;
  }

  async createMatch(input: {
    readonly eventId?: string;
    readonly teamA: string;
    readonly teamB: string;
    readonly teamAId?: string;
    readonly teamBId?: string;
    readonly format: 'bo1' | 'bo3' | 'bo5';
    readonly mapPool: readonly string[];
  }): Promise<MatchDocumentV1> {
    return this.queue.run(async () => {
      const teamA = input.teamA.trim();
      const teamB = input.teamB.trim();
      if (
        (!teamA && input.teamAId === undefined) ||
        (!teamB && input.teamBId === undefined) ||
        teamA.length > 128 ||
        teamB.length > 128
      )
        throw new Error('local_match_names_invalid');
      const event =
        input.eventId === undefined
          ? ({
              eventId: randomUUID(),
              name: '本地赛事',
              logoUrl: null,
              themeColor: null,
              mapPool: input.mapPool,
              matchIds: [],
            } satisfies LocalEventV1)
          : this.state.events.find((item) => item.eventId === input.eventId);
      if (event === undefined) throw new Error('local_event_not_found');
      const a =
        input.teamAId === undefined
          ? { teamId: randomUUID(), name: teamA, logoUrl: null, players: [] }
          : this.state.teams.find((team) => team.teamId === input.teamAId);
      const b =
        input.teamBId === undefined
          ? { teamId: randomUUID(), name: teamB, logoUrl: null, players: [] }
          : this.state.teams.find((team) => team.teamId === input.teamBId);
      if (a === undefined || b === undefined) throw new Error('local_team_not_found');
      if (a.teamId === b.teamId) throw new Error('local_match_entrants_equal');
      const document = parseMatchDocumentV1({
        schemaVersion: 'mizar.match-document.v1',
        matchId: randomUUID(),
        competition: {
          competitionId: event.eventId,
          slug: event.eventId,
          name: event.name,
          logoUrl: event.logoUrl,
          themeColor: event.themeColor,
        },
        status: 'scheduled',
        format: input.format,
        stage: '本地比赛',
        stageKey: null,
        stageLabel: '本地比赛',
        round: null,
        roundLabel: null,
        entryRound: null,
        matchLabel: null,
        stakesLabel: null,
        scheduledAt: null,
        startedAt: null,
        completedAt: null,
        scoreA: null,
        scoreB: null,
        isForfeit: false,
        entrants: {
          a: {
            entryId: a.teamId,
            name: a.name,
            logoUrl: a.logoUrl,
            rosterId: null,
            players: a.players,
          },
          b: {
            entryId: b.teamId,
            name: b.name,
            logoUrl: b.logoUrl,
            rosterId: null,
            players: b.players,
          },
        },
        mapPool: event.mapPool,
        maps: [],
        veto: [],
        commentators: [],
      });
      const next: LocalTournamentState = {
        ...this.state,
        events:
          input.eventId === undefined
            ? [...this.state.events, { ...event, matchIds: [document.matchId] }]
            : this.state.events.map((item) =>
                item.eventId === event.eventId
                  ? { ...item, matchIds: [...item.matchIds, document.matchId] }
                  : item,
              ),
        teams: [
          ...this.state.teams,
          ...[a, b].filter((team) => !this.state.teams.some((old) => old.teamId === team.teamId)),
        ],
        matches: [...this.state.matches, document],
        selectedMatchId: document.matchId,
        selectedAt: new Date().toISOString(),
      };
      await this.commit(next);
      return document;
    });
  }

  async selectMatch(matchId: string): Promise<MatchDocumentV1> {
    return this.queue.run(async () => {
      const document = this.state.matches.find((match) => match.matchId === matchId);
      if (document === undefined) throw new Error('local_match_not_found');
      await this.commit({
        ...this.state,
        selectedMatchId: matchId,
        selectedAt: new Date().toISOString(),
      });
      return document;
    });
  }

  async saveMatch(input: unknown): Promise<MatchDocumentV1> {
    const document = parseMatchDocumentV1(input);
    return this.queue.run(async () => {
      const existing = this.state.matches.find((match) => match.matchId === document.matchId);
      if (existing === undefined) throw new Error('local_match_not_found');
      const event = this.state.events.find(
        (item) => item.eventId === existing.competition.competitionId,
      );
      if (
        event === undefined ||
        document.competition.name !== event.name ||
        document.competition.logoUrl !== event.logoUrl ||
        document.competition.themeColor !== event.themeColor ||
        existing.competition.competitionId !== document.competition.competitionId ||
        existing.entrants.a.entryId !== document.entrants.a.entryId ||
        existing.entrants.b.entryId !== document.entrants.b.entryId ||
        (existing.format !== document.format &&
          existing.maps.some((map) => map.completedAt !== null)) ||
        existing.maps.some(
          (map) =>
            map.completedAt !== null &&
            JSON.stringify(map) !==
              JSON.stringify(document.maps.find((next) => next.mapId === map.mapId)),
        )
      )
        throw new Error('local_match_identity_conflict');
      await this.commit({
        ...this.state,
        matches: this.state.matches.map((match) =>
          match.matchId === document.matchId ? document : match,
        ),
        teams: this.state.teams.map((team) => {
          const entry = [document.entrants.a, document.entrants.b].find(
            (item) => item.entryId === team.teamId,
          );
          return entry === undefined
            ? team
            : { ...team, name: entry.name, logoUrl: entry.logoUrl, players: entry.players };
        }),
      });
      return document;
    });
  }

  async saveEvent(input: {
    readonly eventId: string;
    readonly name: string;
    readonly logoUrl: string | null;
    readonly themeColor: string | null;
    readonly mapPool: readonly string[];
  }): Promise<LocalEventV1> {
    return this.queue.run(async () => {
      const existing = this.state.events.find((item) => item.eventId === input.eventId);
      if (
        existing === undefined ||
        !input.name.trim() ||
        input.name.length > 256 ||
        input.mapPool.length > 16 ||
        new Set(input.mapPool).size !== input.mapPool.length
      )
        throw new Error('local_event_invalid');
      const updated: LocalEventV1 = {
        ...existing,
        name: input.name.trim(),
        logoUrl: input.logoUrl,
        themeColor: input.themeColor,
        mapPool: input.mapPool,
      };
      const nextMatches = this.state.matches.map((match) =>
        match.competition.competitionId === input.eventId
          ? parseMatchDocumentV1({
              ...match,
              competition: {
                ...match.competition,
                name: updated.name,
                logoUrl: updated.logoUrl,
                themeColor: updated.themeColor,
              },
              mapPool:
                JSON.stringify(match.mapPool) === JSON.stringify(existing.mapPool)
                  ? updated.mapPool
                  : match.mapPool,
            })
          : match,
      );
      await this.commit({
        ...this.state,
        events: this.state.events.map((event) =>
          event.eventId === input.eventId ? updated : event,
        ),
        matches: nextMatches,
      });
      return updated;
    });
  }

  /** One-time import of a previously saved standalone BP match. */
  async importLegacyMatch(input: unknown): Promise<MatchDocumentV1> {
    const document = parseMatchDocumentV1(input);
    return this.queue.run(async () => {
      const existing = this.state.matches.find((match) => match.matchId === document.matchId);
      if (existing !== undefined) return existing;
      const event: LocalEventV1 = {
        eventId: document.competition.competitionId,
        name: document.competition.name,
        logoUrl: document.competition.logoUrl ?? null,
        themeColor: document.competition.themeColor,
        mapPool: document.mapPool,
        matchIds: [document.matchId],
      };
      const team = (entrant: MatchDocumentV1['entrants']['a']): LocalTeamV1 => ({
        teamId: entrant.entryId,
        name: entrant.name,
        logoUrl: entrant.logoUrl,
        players: entrant.players,
      });
      await this.commit({
        ...this.state,
        events: this.state.events.some((item) => item.eventId === event.eventId)
          ? this.state.events.map((item) =>
              item.eventId === event.eventId
                ? { ...item, matchIds: [...item.matchIds, document.matchId] }
                : item,
            )
          : [...this.state.events, event],
        teams: [...this.state.teams, team(document.entrants.a), team(document.entrants.b)].filter(
          (item, index, all) =>
            all.findIndex((candidate) => candidate.teamId === item.teamId) === index,
        ),
        matches: [...this.state.matches, document],
        selectedMatchId: document.matchId,
        selectedAt: new Date().toISOString(),
      });
      return document;
    });
  }

  async reorder(eventId: string, matchIds: readonly string[]): Promise<void> {
    return this.queue.run(async () => {
      const event = this.state.events.find((item) => item.eventId === eventId);
      if (
        event === undefined ||
        matchIds.length !== event.matchIds.length ||
        new Set(matchIds).size !== matchIds.length ||
        matchIds.some((id) => !event.matchIds.includes(id))
      )
        throw new Error('local_schedule_invalid');
      await this.commit({
        ...this.state,
        events: this.state.events.map((item) =>
          item.eventId === eventId ? { ...item, matchIds } : item,
        ),
      });
    });
  }

  scheduleWindow(eventId: string): ScheduleWindowV1 | null {
    const event = this.state.events.find((item) => item.eventId === eventId);
    if (event === undefined) return null;
    const ordered = event.matchIds
      .map((id) => this.state.matches.find((match) => match.matchId === id)!)
      .filter(Boolean);
    const times = ordered
      .map((match) => match.scheduledAt)
      .filter((time): time is string => time !== null)
      .sort();
    return parseScheduleWindowV1({
      schemaVersion: 'mizar.schedule-window.v1',
      competition: {
        competitionId: event.eventId,
        slug: event.eventId,
        name: event.name,
        logoUrl: event.logoUrl,
        themeColor: event.themeColor,
      },
      from: times[0] ?? null,
      to: times.at(-1) ?? null,
      matches: ordered.map((match) => ({
        matchId: match.matchId,
        scheduledAt: match.scheduledAt,
        startedAt: match.startedAt,
        completedAt: match.completedAt,
        status: match.status,
        format: match.format,
        stage: match.stage,
        stageLabel: match.stageLabel,
        round: match.round,
        roundLabel: match.roundLabel,
        matchLabel: match.matchLabel,
        isForfeit: match.isForfeit,
        scoreA: match.scoreA,
        scoreB: match.scoreB,
        entrants: {
          a: {
            entryId: match.entrants.a.entryId,
            name: match.entrants.a.name,
            logoUrl: match.entrants.a.logoUrl,
          },
          b: {
            entryId: match.entrants.b.entryId,
            name: match.entrants.b.name,
            logoUrl: match.entrants.b.logoUrl,
          },
        },
      })),
    });
  }

  private async commit(next: LocalTournamentState): Promise<void> {
    const validated = readState(next);
    await replaceDurableJson(this.filePath, validated);
    this.state = validated;
  }
}
