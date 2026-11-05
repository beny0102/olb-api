import { ForbiddenException, Injectable } from "@nestjs/common";
import type { Role, ScopeType } from "./auth.store.js";
import type { AuthContext } from "./auth.service.js";

export function hasAnyRole(
  auth: AuthContext,
  scopeType: ScopeType,
  scopeId: string,
  roles: readonly Role[],
): boolean {
  return auth.memberships.some(
    (membership) =>
      membership.scopeType === scopeType &&
      membership.scopeId === scopeId &&
      roles.includes(membership.role),
  );
}

export function hasOrgAdmin(auth: AuthContext, organizationId: string): boolean {
  return hasAnyRole(auth, "organization", organizationId, ["org_admin"]);
}

export function hasCompetitionAdmin(auth: AuthContext, competitionId: string): boolean {
  return hasAnyRole(auth, "competition", competitionId, ["competition_admin"]);
}

export function hasTeamRole(
  auth: AuthContext,
  teamSeasonId: string,
  roles: readonly Role[],
): boolean {
  return hasAnyRole(auth, "team_season", teamSeasonId, roles);
}

/** Assertion wrappers for services; the guard supplies the context. */
@Injectable()
export class ScopesService {
  assertAnyRole(
    auth: AuthContext,
    scopeType: ScopeType,
    scopeId: string,
    roles: readonly Role[],
  ): void {
    if (!hasAnyRole(auth, scopeType, scopeId, roles)) {
      throw new ForbiddenException(`insufficient ${scopeType} scope`);
    }
  }

  assertOrgAdmin(auth: AuthContext, organizationId: string): void {
    if (!hasOrgAdmin(auth, organizationId)) {
      throw new ForbiddenException("organization admin role required");
    }
  }

  assertCompetitionAdmin(auth: AuthContext, competitionId: string): void {
    if (!hasCompetitionAdmin(auth, competitionId)) {
      throw new ForbiddenException("competition admin role required");
    }
  }

  assertTeamRole(auth: AuthContext, teamSeasonId: string, roles: readonly Role[]): void {
    if (!hasTeamRole(auth, teamSeasonId, roles)) {
      throw new ForbiddenException("team role required");
    }
  }
}
