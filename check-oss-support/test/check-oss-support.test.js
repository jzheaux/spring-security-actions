import { describe, expect, it } from "vitest";
import { generationOf, run } from "../src/index.js";

const generations = [
  { name: "6.4.x", ossSupportEndDate: "2025-12-31" },
  { name: "7.0.x", ossSupportEndDate: "2026-12-31" },
  { name: "9.0.x", ossSupportEndDate: null },
];
const fetchOf =
  (body, status = 200) =>
  async (url) => ({
    ok: status < 400,
    status,
    statusText: status === 200 ? "OK" : "Error",
    url,
    json: async () => body,
  });
const api = fetchOf({ _embedded: { generations } });
const base = {
  project: "spring-security",
  version: "7.0.9",
  date: "2026-11-19",
};

describe("generationOf", () => {
  it.each([
    ["7.0.9", "7.0.x"],
    ["7.0.9.1", "7.0.x"],
    ["7.2.0", "7.2.x"],
  ])("%s is of %s", (version, generation) => {
    expect(generationOf(version)).toBe(generation);
  });

  it("does not take a text that is not a version", () => {
    expect(() => generationOf("main")).toThrow("is not a version");
  });
});

describe("run", () => {
  it("passes while OSS support lasts, and on its last day", async () => {
    expect(await run(base, { fetch: api })).toEqual({
      generation: "7.0.x",
      ossSupportEnd: "2026-12-31",
    });
    expect(
      (await run({ ...base, date: "2026-12-31" }, { fetch: api })).generation,
    ).toBe("7.0.x");
  });

  it("passes for a generation with no end", async () => {
    expect(await run({ ...base, version: "9.0.1" }, { fetch: api })).toEqual({
      generation: "9.0.x",
      ossSupportEnd: "",
    });
  });

  it("fails if OSS support ends before the date, and says to use the lts branch", async () => {
    let error;
    try {
      await run(
        { ...base, version: "6.4.5", branch: "embargoed/frozen/6.4.x" },
        { fetch: api },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error.title).toBe("OSS support of 6.4.x ended");
    expect(error.message).toBe(
      "OSS support of 6.4.x ended on 2025-12-31, before the disclosure date 2026-11-19 of embargoed/frozen/6.4.x: replace embargoed/frozen/6.4.x and embargoed/active/6.4.x with the embargoed/lts branch of the generation, which is for the generations that are commercial.",
    );
  });

  it("fails for a generation that the API does not have", async () => {
    await expect(
      run({ ...base, version: "3.0.1" }, { fetch: api }),
    ).rejects.toThrow("has no generation 3.0.x");
  });

  it("fails if the API does not answer, or answers with something else", async () => {
    await expect(run(base, { fetch: fetchOf({}, 404) })).rejects.toThrow(
      "failed with 404",
    );
    await expect(run(base, { fetch: fetchOf({}) })).rejects.toThrow(
      "has no generations",
    );
    await expect(
      run(base, {
        fetch: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow("failed: offline");
  });

  it("fails for a date that is not a date", async () => {
    await expect(
      run({ ...base, date: "soon" }, { fetch: api }),
    ).rejects.toThrow("expected YYYY-MM-DD");
  });
});
