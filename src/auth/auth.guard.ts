import {
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import type { AuthContext } from "./auth.service.js";
import { AuthService } from "./auth.service.js";

export interface AuthenticatedRequest extends Request {
  auth?: AuthContext;
}

function bearerToken(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    return authenticateRequest(context, this.auth, false);
  }
}

/**
 * Logout must be idempotent: a token that was already revoked still proves
 * the caller owns that session, so the second call succeeds as a no-op.
 */
@Injectable()
export class LogoutGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    return authenticateRequest(context, this.auth, true);
  }
}

async function authenticateRequest(
  context: ExecutionContext,
  authService: AuthService,
  allowRevoked: boolean,
): Promise<boolean> {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  const token = bearerToken(request.headers.authorization);

  if (token === null) {
    throw new UnauthorizedException("bearer token required");
  }

  const auth = await authService.authenticate(token, { allowRevoked });
  if (auth === null) {
    throw new UnauthorizedException("invalid or expired token");
  }

  request.auth = auth;
  return true;
}

/** The context `AuthGuard` stored on the request. */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.auth) {
      throw new UnauthorizedException("missing auth context");
    }
    return request.auth;
  },
);
