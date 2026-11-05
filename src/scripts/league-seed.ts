import type { LeagueStore } from "../store/league.store.js";

/**
 * Idempotent seed for the fictional Liga Metropolitana. Every identity is
 * fixed so a second run updates the same rows instead of creating duplicates.
 * Fictional clubs only: no MLB or LMB marks.
 */

const NAMESPACE = "0192f3d0-0000-7000-8000";

function id(value: number): string {
  return `${NAMESPACE}-${String(value).padStart(12, "0")}`;
}

export const SEED_ORGANIZATION_ID = id(1);
export const SEED_SEASON_ID = id(2);
export const SEED_COMPETITION_IDS = [id(10), id(11)] as const;
export const SEED_TEAM_SEASON_IDS = [id(30), id(31), id(32), id(33)] as const;

const SEED_CREATED_AT = "2026-01-01T00:00:00.000Z";
const SEED_SUMMARY_AT = "2026-03-30T00:00:00.000Z";
const SEASON_START = "2026-03-01";

const POSITIONS = [
  "C",
  "C",
  "1B",
  "2B",
  "3B",
  "SS",
  "LF",
  "CF",
  "RF",
  "DH",
  "P",
  "P",
  "P",
  "P",
  "1B",
  "2B",
  "SS",
  "LF",
] as const;

/** Rotated per club so the four 18-man rosters do not share one number set. */
const JERSEYS = [
  "2",
  "7",
  "11",
  "13",
  "17",
  "21",
  "24",
  "27",
  "31",
  "33",
  "38",
  "41",
  "44",
  "48",
  "51",
  "55",
  "59",
  "62",
] as const;

/** One distinct surname per player: four clubs of 18, no repeats. */
const SURNAMES = [
  "Aguilar",
  "Bermúdez",
  "Castillo",
  "Domínguez",
  "Escobar",
  "Fuentes",
  "Guerrero",
  "Herrera",
  "Ibarra",
  "Jiménez",
  "Lara",
  "Medina",
  "Navarro",
  "Ortiz",
  "Paredes",
  "Quiñones",
  "Ramírez",
  "Salazar",
  "Tapia",
  "Urbina",
  "Valdez",
  "Zambrano",
  "Acosta",
  "Barrera",
  "Cabrera",
  "Delgado",
  "Espinoza",
  "Figueroa",
  "Galván",
  "Hernández",
  "Islas",
  "Juárez",
  "Lozano",
  "Maldonado",
  "Núñez",
  "Ochoa",
  "Padilla",
  "Quintero",
  "Rojas",
  "Sandoval",
  "Trejo",
  "Uribe",
  "Vargas",
  "Zamora",
  "Arreola",
  "Bustamante",
  "Cárdenas",
  "Duarte",
  "Estrada",
  "Fierro",
  "Gutiérrez",
  "Huerta",
  "Infante",
  "Jaramillo",
  "Leal",
  "Meza",
  "Nieves",
  "Orozco",
  "Pacheco",
  "Quiroz",
  "Reyes",
  "Serrano",
  "Torres",
  "Ulloa",
  "Villalobos",
  "Yáñez",
  "Zepeda",
  "Alvarado",
  "Beltrán",
  "Cuevas",
  "Del Río",
  "Enríquez",
] as const;

const FIRST_NAMES = [
  "Alejandro",
  "Bruno",
  "Camilo",
  "Diego",
  "Emilio",
  "Facundo",
  "Gabriel",
  "Héctor",
  "Iván",
  "Joaquín",
  "Lucas",
  "Mateo",
  "Nicolás",
  "Óscar",
  "Pablo",
  "Rodrigo",
  "Santiago",
  "Tomás",
] as const;

interface TeamSeed {
  id: string;
  name: string;
  slug: string;
  abbreviation: string;
  competitionIndex: 0 | 1;
  venue: string;
}

const TEAMS: TeamSeed[] = [
  {
    id: id(20),
    name: "Tiburones",
    slug: "tiburones",
    abbreviation: "TIB",
    competitionIndex: 0,
    venue: "Estadio Metropolitano",
  },
  {
    id: id(21),
    name: "Faros",
    slug: "faros",
    abbreviation: "FAR",
    competitionIndex: 0,
    venue: "Estadio Metropolitano",
  },
  {
    id: id(22),
    name: "Mantarrayos",
    slug: "mantarrayos",
    abbreviation: "MAN",
    competitionIndex: 1,
    venue: "Parque del Sur",
  },
  {
    id: id(23),
    name: "Corsarios",
    slug: "corsarios",
    abbreviation: "COR",
    competitionIndex: 1,
    venue: "Parque del Sur",
  },
];

interface GameSeed {
  home: number;
  away: number;
  competitionIndex: 0 | 1;
  scheduledStart: string;
  summary?: { homeScore: number; awayScore: number };
}

const GAMES: GameSeed[] = [
  {
    home: 0,
    away: 1,
    competitionIndex: 0,
    scheduledStart: "2026-03-07T23:00:00.000Z",
    summary: { homeScore: 5, awayScore: 3 },
  },
  {
    home: 1,
    away: 0,
    competitionIndex: 0,
    scheduledStart: "2026-03-14T23:00:00.000Z",
  },
  {
    home: 2,
    away: 3,
    competitionIndex: 1,
    scheduledStart: "2026-03-21T23:00:00.000Z",
    summary: { homeScore: 2, awayScore: 1 },
  },
  {
    home: 3,
    away: 2,
    competitionIndex: 1,
    scheduledStart: "2026-03-28T23:00:00.000Z",
  },
  {
    home: 0,
    away: 1,
    competitionIndex: 0,
    scheduledStart: "2026-04-04T23:00:00.000Z",
  },
  {
    home: 2,
    away: 3,
    competitionIndex: 1,
    scheduledStart: "2026-04-11T23:00:00.000Z",
  },
  {
    home: 1,
    away: 0,
    competitionIndex: 0,
    scheduledStart: "2026-04-18T23:00:00.000Z",
  },
  {
    home: 3,
    away: 2,
    competitionIndex: 1,
    scheduledStart: "2026-04-25T23:00:00.000Z",
  },
];

export async function seedLeague(store: LeagueStore): Promise<void> {
  await store.upsertOrganization({
    id: SEED_ORGANIZATION_ID,
    name: "Liga Metropolitana",
    slug: "liga-metropolitana",
    createdAt: SEED_CREATED_AT,
  });

  await store.upsertSeason({
    id: SEED_SEASON_ID,
    organizationId: SEED_ORGANIZATION_ID,
    name: "2026",
    year: 2026,
    status: "active",
    startsOn: SEASON_START,
    endsOn: "2026-11-30",
  });

  const competitions = [
    {
      id: SEED_COMPETITION_IDS[0],
      seasonId: SEED_SEASON_ID,
      parentId: null,
      name: "Zona Norte",
      kind: "division" as const,
      level: 1,
      sortOrder: 1,
    },
    {
      id: SEED_COMPETITION_IDS[1],
      seasonId: SEED_SEASON_ID,
      parentId: null,
      name: "Zona Sur",
      kind: "division" as const,
      level: 1,
      sortOrder: 2,
    },
  ];

  for (const competition of competitions) {
    await store.upsertCompetition(competition);
  }

  for (const team of TEAMS) {
    await store.upsertTeam({
      id: team.id,
      organizationId: SEED_ORGANIZATION_ID,
      name: team.name,
      slug: team.slug,
      abbreviation: team.abbreviation,
      createdAt: SEED_CREATED_AT,
    });
  }

  for (const [teamIndex, team] of TEAMS.entries()) {
    const teamSeasonId = SEED_TEAM_SEASON_IDS[teamIndex]!;
    const competitionId = SEED_COMPETITION_IDS[team.competitionIndex]!;

    await store.upsertTeamSeason({
      id: teamSeasonId,
      teamId: team.id,
      seasonId: SEED_SEASON_ID,
      competitionId,
      name: team.name,
      abbreviation: team.abbreviation,
    });

    for (let playerIndex = 0; playerIndex < FIRST_NAMES.length; playerIndex += 1) {
      const playerId = id(100 + teamIndex * FIRST_NAMES.length + playerIndex);
      const firstName = FIRST_NAMES[playerIndex]!;
      const lastName = SURNAMES[teamIndex * FIRST_NAMES.length + playerIndex]!;

      await store.upsertPlayer({
        id: playerId,
        organizationId: SEED_ORGANIZATION_ID,
        firstName,
        lastName,
        createdAt: SEED_CREATED_AT,
      });

      await store.upsertRosterEntry({
        id: id(300 + teamIndex * FIRST_NAMES.length + playerIndex),
        teamSeasonId,
        playerId,
        jersey: JERSEYS[(teamIndex + playerIndex) % JERSEYS.length]!,
        primaryPosition: POSITIONS[playerIndex]!,
        eligibilityStart: SEASON_START,
        eligibilityEnd: null,
        status: "active",
      });
    }
  }

  for (const [gameIndex, game] of GAMES.entries()) {
    const home = TEAMS[game.home]!;
    const away = TEAMS[game.away]!;
    const gameId = id(200 + gameIndex);

    await store.upsertGame({
      id: gameId,
      seasonId: SEED_SEASON_ID,
      competitionId: SEED_COMPETITION_IDS[game.competitionIndex]!,
      homeTeamSeasonId: SEED_TEAM_SEASON_IDS[game.home]!,
      awayTeamSeasonId: SEED_TEAM_SEASON_IDS[game.away]!,
      homeTeam: home.name,
      awayTeam: away.name,
      scheduledStart: game.scheduledStart,
      venue: home.venue,
      coverage: game.summary ? "summary" : "full",
      dataSource: game.summary ? "import" : "official",
      rulesProfile: null,
      createdAt: SEED_CREATED_AT,
      lastSeq: -1,
    });

    if (game.summary) {
      await store.upsertGameSummary({
        gameId,
        homeScore: game.summary.homeScore,
        awayScore: game.summary.awayScore,
        linescore: null,
        teamBox: null,
        source: "seed",
        updatedAt: SEED_SUMMARY_AT,
      });
    }
  }
}
