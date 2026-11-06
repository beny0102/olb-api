import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.service.js";
import type { Role } from "../auth/auth.store.js";
import { hasAnyRole, hasCompetitionAdmin, hasOrgAdmin, hasTeamRole } from "../auth/scopes.js";
import { isUuidV7 } from "../domain/uuid7.js";
import { GameNotFoundError } from "../store/errors.js";
import {
  LEAGUE_STORE,
  type LeagueGameRecord,
  type LeagueStore,
} from "../store/league.store.js";
import { EVENT_STORE, type EventStore } from "../store/store.js";

/** Roles that may write game data. The verifier is added for proposals only. */
const SCORING_ROLES: readonly Role[] = ["org_admin", "competition_admin", "team_admin", "scorer"];
const TEAM_SCORING_ROLES: readonly Role[] = ["team_admin", "scorer"];
const PROPOSING_ROLES: readonly Role[] = [...SCORING_ROLES, "verifier"];

function hasAnyMembershipRole(auth: AuthContext, roles: readonly Role[]): boolean {
  return auth.memberships.some((membership) => roles.includes(membership.role));
}

/**
 * Postgres keeps league and legacy games in the same `games` table, so a
 * legacy row is still returned by `LeagueStore.getGame` with every league
 * link set to null. Only a row with at least one league link is catalogued.
 */
function hasLeagueIdentity(game: LeagueGameRecord): boolean {
  return (
    game.seasonId !== null ||
    game.competitionId !== null ||
    game.homeTeamSeasonId !== null ||
    game.awayTeamSeasonId !== null
  );
}

/**
 * Authorizes the legacy game writes against the league catalog.
 *
 * A game with no league row is legacy: its event log is the only record and
 * there is no team or competition scope to check, so any scoring membership
 * is enough. A catalog game is checked against its season's organization,
 * its competition and the two team seasons.
 */
@Injectable()
export class GameAccessService {
  constructor(
    @Inject(LEAGUE_STORE) private readonly league: LeagueStore,
    @Inject(EVENT_STORE) private readonly events: EventStore,
  ) {}

  assertCanCreate(auth: AuthContext): void {
    if (!hasAnyMembershipRole(auth, SCORING_ROLES)) {
      throw new ForbiddenException("scorer, team, competition or organization role required");
    }
  }

  async assertCanScore(auth: AuthContext, gameId: string): Promise<void> {
    await this.assertGameAccess(auth, gameId, SCORING_ROLES, false);
  }

  async assertCanPropose(auth: AuthContext, gameId: string): Promise<void> {
    await this.assertGameAccess(auth, gameId, PROPOSING_ROLES, true);
  }

  async assertCanResolve(auth: AuthContext, gameId: string): Promise<void> {
    await this.assertGameAccess(auth, gameId, SCORING_ROLES, false);
  }

  private async assertGameAccess(
    auth: AuthContext,
    gameId: string,
    roles: readonly Role[],
    allowVerifier: boolean,
  ): Promise<void> {
    // A malformed id cannot exist, and Postgres would reject the cast before
    // the game-not-found filter could answer 404.
    if (!isUuidV7(gameId)) throw new GameNotFoundError(gameId);

    const game = await this.league.getGame(gameId);

    if (game === null || !hasLeagueIdentity(game)) {
      // Reject a game that exists in neither catalog nor event log before
      // checking roles, so a missing legacy game still answers 404.
      if (!(await this.events.getGame(gameId))) throw new GameNotFoundError(gameId);
      if (!hasAnyMembershipRole(auth, roles)) {
        throw new ForbiddenException("scoring membership required for a legacy game");
      }
      return;
    }

    if (await this.canWriteLeagueGame(auth, game, roles, allowVerifier)) return;
    throw new ForbiddenException("game is outside the caller's scope");
  }

  private async canWriteLeagueGame(
    auth: AuthContext,
    game: LeagueGameRecord,
    roles: readonly Role[],
    allowVerifier: boolean,
  ): Promise<boolean> {
    if (game.seasonId !== null) {
      const season = await this.league.getSeason(game.seasonId);
      if (season && hasOrgAdmin(auth, season.organizationId)) return true;
    }

    if (game.competitionId !== null) {
      if (hasCompetitionAdmin(auth, game.competitionId)) return true;
      if (allowVerifier && hasAnyRole(auth, "competition", game.competitionId, ["verifier"])) {
        return true;
      }
    }

    for (const teamSeasonId of [game.homeTeamSeasonId, game.awayTeamSeasonId]) {
      if (teamSeasonId !== null && hasTeamRole(auth, teamSeasonId, TEAM_SCORING_ROLES)) {
        return true;
      }
    }

    return false;
  }
}
