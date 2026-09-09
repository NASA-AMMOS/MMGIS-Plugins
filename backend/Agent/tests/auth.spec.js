import { test, expect } from "@playwright/test";
import {
  AGENT_AUTH_OPTIONS,
  getAgentAuthMiddleware,
} from "../auth";

test.describe("@unit Copilot authentication integration", () => {
  test("configures the host API guard with typed Agent failures", () => {
    expect(AGENT_AUTH_OPTIONS).toEqual({
      allowPublic: true,
      code: "AgentAuthenticationRequired",
      message: "Sign in to use MMGIS Copilot.",
      unavailableCode: "AgentAuthenticationUnavailable",
      unavailableMessage: "MMGIS authentication is temporarily unavailable.",
    });
    expect(Object.isFrozen(AGENT_AUTH_OPTIONS)).toBe(true);
  });

  test("installs exactly one host guard and forwards the typed options", () => {
    const guard = (_req, _res, next) => next();
    const calls = [];
    const server = {
      ensureUserForApi(options) {
        calls.push(options);
        return guard;
      },
      ensureUser: () => {
        throw new Error("legacy ensureUser must not be called");
      },
      stopGuests: () => {
        throw new Error("legacy stopGuests must not be called");
      },
    };

    expect(getAgentAuthMiddleware(server)).toBe(guard);
    expect(calls).toEqual([AGENT_AUTH_OPTIONS]);
  });

  test("fails closed when the host does not provide the typed API guard", () => {
    expect(() => getAgentAuthMiddleware({})).toThrow(
      /ensureUserForApi middleware/,
    );
    expect(() => getAgentAuthMiddleware(null)).toThrow(
      /ensureUserForApi middleware/,
    );
  });
});
