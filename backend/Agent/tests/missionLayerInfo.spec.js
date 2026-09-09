import path from "path";
import { test, expect } from "@playwright/test";
import {
  sanitizeMissionName,
  resolveMissionPath,
  setBoundedCache,
  createLayerInfoMiddleware,
} from "../missionLayerInfo";

test.describe("@unit Agent mission layer context isolation", () => {
  test("rejects traversal and keeps resolved paths under Missions", () => {
    expect(sanitizeMissionName("../private")).toBe("");
    expect(sanitizeMissionName("Arctic_Mission-1")).toBe(
      "Arctic_Mission-1",
    );
    const root = path.join(process.cwd(), "Missions");
    expect(resolveMissionPath(root, "..\\private")).toBeNull();
    expect(resolveMissionPath(root, "Arctic")).toBe(
      path.join(root, "Arctic"),
    );
  });

  test("bounds the mission cache deterministically", () => {
    const cache = new Map();
    setBoundedCache(cache, "one", 1, 2);
    setBoundedCache(cache, "two", 2, 2);
    setBoundedCache(cache, "three", 3, 2);
    expect([...cache.keys()]).toEqual(["two", "three"]);
  });

  test("attaches mission stores to each request without shared cross-talk", () => {
    const middleware = createLayerInfoMiddleware({
      missionsRoot: process.cwd(),
      loadDynamic: (missionPath) => ({
        items: [{ name: path.basename(missionPath) }],
        index: [],
        loadedAt: new Date().toISOString(),
      }),
      loadStatic: () => ({ items: [], index: [] }),
      maxCacheEntries: 4,
    });
    const response = {
      status() { return this; },
      json() { throw new Error("unexpected rejection"); },
    };
    const first = { query: { mission: "plugins" }, body: {} };
    const second = { query: { mission: "src" }, body: {} };
    middleware(first, response, () => {});
    middleware(second, response, () => {});
    expect(first.agentLayerInfo.items[0].name).toBe("plugins");
    expect(second.agentLayerInfo.items[0].name).toBe("src");
    expect(first.agentLayerInfo).not.toBe(second.agentLayerInfo);
  });
});
