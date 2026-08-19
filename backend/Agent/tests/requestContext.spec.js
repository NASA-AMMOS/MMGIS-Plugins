import { test, expect } from "@playwright/test";
import {
  sanitizeConversationHistory,
  sanitizeRuntimeContext,
} from "../requestContext";

test.describe("@unit Copilot request context", () => {
  test("keeps bounded prior turns while dropping unsafe raw fields", () => {
    const history = sanitizeConversationHistory([
      {
        role: "user",
        text: "Turn SWOT on.",
        token: "secret",
        rawResponse: { stack: "private" },
      },
      {
        role: "tool",
        text: "must be dropped",
      },
      {
        role: "assistant",
        content: "SWOT is now visible.",
        arbitrary: { ignored: true },
      },
    ]);
    expect(history).toEqual([
      { role: "user", text: "Turn SWOT on." },
      { role: "assistant", text: "SWOT is now visible." },
    ]);
  });

  test("preserves map, home, time, active layer/feature, and tool state only", () => {
    const safe = sanitizeRuntimeContext(
      {
        map: {
          center: [-145, 72],
          bounds: [-160, 68, -125, 78],
          zoom: 4,
          home: { center: [-140, 70], zoom: 2 },
        },
        time: {
          current: "2026-08-15T12:00:00Z",
          start: "2026-08-01T00:00:00Z",
          end: "2026-08-31T00:00:00Z",
          playing: true,
        },
        activeLayer: { name: "SWOT freeboard", type: "data", visible: true },
        selectedFeature: { id: 42, layer: "Stations", label: "Station A" },
        loadedTools: ["Analysis", { name: "Frozon" }, "bad tool"],
        activeTools: ["Analysis"],
        rawDom: "<html>secret</html>",
        authToken: "secret",
      },
      [{ role: "user", text: "What about this layer?" }],
    );
    expect(safe.runtime.map.center).toEqual([-145, 72]);
    expect(safe.runtime.temporal.current).toBe("2026-08-15T12:00:00Z");
    expect(safe.runtime.activeLayer.name).toBe("SWOT freeboard");
    expect(safe.runtime.selectedFeature.id).toBe("42");
    expect(safe.runtime.loadedTools).toEqual(["Analysis", "Frozon"]);
    expect(safe.runtime.rawDom).toBeUndefined();
    expect(safe.runtime.authToken).toBeUndefined();
    expect(safe.history[0].text).toMatch(/this layer/);
  });

  test("preserves dedicated AOI and selection extents without deriving them from viewport bounds", () => {
    const safe = sanitizeRuntimeContext({
      map: {
        bounds: [-180, 70, 180, 90],
        areaOfInterest: {
          name: "Validation AOI",
          bbox: [-160, 72, -130, 82],
        },
      },
      selectionExtent: {
        label: "Drawn selection",
        bounds: [-150, 68, -140, 75],
      },
    });
    expect(safe.runtime.map.bounds).toEqual([-180, 70, 180, 90]);
    expect(safe.runtime.areaOfInterest).toEqual({
      name: "Validation AOI",
      bbox: [-160, 72, -130, 82],
    });
    expect(safe.runtime.selectionExtent).toEqual({
      name: "Drawn selection",
      bbox: [-150, 68, -140, 75],
    });

    const viewportOnly = sanitizeRuntimeContext({
      map: { bounds: [-180, 70, 180, 90] },
    });
    expect(viewportOnly.runtime.areaOfInterest).toBeUndefined();
    expect(viewportOnly.runtime.selectionExtent).toBeUndefined();
  });
});
