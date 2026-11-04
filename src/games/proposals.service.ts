import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { GameNotFoundError } from "../store/errors.js";
import {
  EVENT_STORE,
  type EventStore,
  type ProposalPayload,
  type ProposalRecord,
  type ProposalStatus,
} from "../store/store.js";

const MAX_AUTHOR = 60;
const DEFAULT_AUTHOR = "Verificador";
const PITCH_CALLS = ["B", "C", "S", "F", "T"] as const;
const OUTCOME_CODES = ["out", "1B", "2B", "3B", "HR", "E", "FC"] as const;
const STATUSES: ProposalStatus[] = ["open", "accepted", "rejected"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestException("request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function proposalAuthor(value: unknown): string {
  if (value === undefined || value === null) return DEFAULT_AUTHOR;
  if (typeof value !== "string") {
    throw new BadRequestException(`author must be a string of 1 to ${MAX_AUTHOR} characters`);
  }
  const author = value.trim();
  if (author.length === 0 || author.length > MAX_AUTHOR) {
    throw new BadRequestException(`author must be a string of 1 to ${MAX_AUTHOR} characters`);
  }
  return author;
}

/**
 * A proposal is a suggestion, not an event: it is validated against the small
 * vocabulary a spotter can send and never parsed by the event contract.
 */
function proposalPayload(value: unknown): ProposalPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadRequestException("payload must be a JSON object");
  }
  const payload = value as Record<string, unknown>;

  if (payload.kind === "pitch") {
    if (
      typeof payload.call !== "string" ||
      !PITCH_CALLS.includes(payload.call as (typeof PITCH_CALLS)[number])
    ) {
      throw new BadRequestException(`payload.call must be one of: ${PITCH_CALLS.join(", ")}`);
    }
    return { kind: "pitch", call: payload.call as (typeof PITCH_CALLS)[number] };
  }

  if (payload.kind === "outcome") {
    if (
      typeof payload.code !== "string" ||
      !OUTCOME_CODES.includes(payload.code as (typeof OUTCOME_CODES)[number])
    ) {
      throw new BadRequestException(`payload.code must be one of: ${OUTCOME_CODES.join(", ")}`);
    }
    return { kind: "outcome", code: payload.code as (typeof OUTCOME_CODES)[number] };
  }

  throw new BadRequestException('payload.kind must be "pitch" or "outcome"');
}

function listStatus(value: string | undefined): ProposalStatus | undefined {
  if (value === undefined || value === "all") return undefined;
  if (!STATUSES.includes(value as ProposalStatus)) {
    throw new BadRequestException(`status must be one of: open, accepted, rejected, all`);
  }
  return value as ProposalStatus;
}

function resolveStatus(value: unknown): "accepted" | "rejected" {
  if (value !== "accepted" && value !== "rejected") {
    throw new BadRequestException('status must be "accepted" or "rejected"');
  }
  return value;
}

@Injectable()
export class ProposalsService {
  constructor(@Inject(EVENT_STORE) private readonly store: EventStore) {}

  async createProposal(gameId: string, body: unknown): Promise<ProposalRecord> {
    const input = assertObject(body);
    if (!(await this.store.getGame(gameId))) throw new GameNotFoundError(gameId);

    return this.store.createProposal({
      gameId,
      author: proposalAuthor(input.author),
      payload: proposalPayload(input.payload),
    });
  }

  async listProposals(gameId: string, status?: string): Promise<ProposalRecord[]> {
    if (!(await this.store.getGame(gameId))) throw new GameNotFoundError(gameId);

    // `open` is the inbox default; `all` lifts the filter.
    const filter = status === undefined ? "open" : listStatus(status);
    return this.store.listProposals(gameId, filter);
  }

  async resolveProposal(gameId: string, id: string, body: unknown): Promise<ProposalRecord> {
    // Guard Postgres against a malformed uuid before it reaches the query.
    if (!UUID.test(id)) throw new NotFoundException(`proposal not found: ${id}`);

    const proposal = await this.store.getProposal(id);
    if (!proposal || proposal.gameId !== gameId) {
      throw new NotFoundException(`proposal not found: ${id}`);
    }

    const status = resolveStatus(assertObject(body).status);
    // A retry after the first decision is idempotent: the stored status wins.
    if (proposal.status !== "open") return proposal;

    const resolved = await this.store.resolveProposal(id, status);
    if (!resolved) throw new NotFoundException(`proposal not found: ${id}`);
    return resolved;
  }
}
