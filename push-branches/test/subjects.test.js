import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SUBJECTS } from "../src/steps.js";

const root = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// The summary reads what the run did from the subjects of the commits that it made. They are
// made by the other actions of this repository and by the workflow: if one of them is
// changed, this fails, and the summary has to be changed with it.
describe("the subjects of the commits that the actions make", () => {
  it("are what the summary reads", () => {
    expect(
      SUBJECTS.merge.exec("Merge release/7.0.9 into release/7.0.9.1")?.slice(1),
    ).toEqual(["release/7.0.9", "release/7.0.9.1"]);
    expect(SUBJECTS.license.exec("Commercial changes for 7.0.9.1")?.[1]).toBe(
      "7.0.9.1",
    );
    expect(
      SUBJECTS.version.exec("Set the version to 7.0.9.1-SNAPSHOT")?.[1],
    ).toBe("7.0.9.1-SNAPSHOT");
    expect(SUBJECTS.release.exec("Release 7.0.9.1")?.[1]).toBe("7.0.9.1");
    expect(
      SUBJECTS.dependency.exec("Update spring-framework to 7.0.10")?.slice(1),
    ).toEqual(["spring-framework", "7.0.10"]);
  });

  it("are still made by merge-release", () => {
    expect(read("merge-release/src/index.js")).toContain(
      "`Merge ${release} into ${current}`",
    );
  });

  it("are still made by update-versions", () => {
    expect(read("update-versions/src/index.js")).toContain(
      "`Update ${dependency} to ${version}`",
    );
  });

  it("are still given by the workflow", () => {
    const workflow = read(".github/workflows/release-branches.yml");
    expect(workflow).toContain("commit-message: Commercial changes for ${{");
    expect(workflow).toContain("message: Set the version to ${{");
    expect(workflow).toContain("message: Release ${{");
  });
});
