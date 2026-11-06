import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Runs git in a directory, and returns what it printed without the last newline. */
export function git(directory, ...args) {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).replace(/\n$/, "");
}

/** The version catalog: a line between two versions, so that two changes are never adjacent. */
export function catalog({ framework, reactor, micrometer }) {
  return [
    "[versions]",
    `spring-framework = "${framework}"`,
    'filler-a = "1"',
    `reactor = "${reactor}"`,
    'filler-b = "2"',
    `micrometer = "${micrometer}"`,
    'filler-c = "3"',
    "",
    "[libraries]",
    'junit = "org.junit:junit:5"',
    "",
  ].join("\n");
}

export const properties = (version) =>
  `org.gradle.jvmargs=-Xmx2g\nversion=${version}\n`;

/** Writes the files (an object from the path to the content) and commits them. */
export function commitFiles(directory, files, message) {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), content);
  }
  git(directory, "add", "-A");
  git(directory, "commit", "-q", "-m", message);
  return git(directory, "rev-parse", "HEAD");
}

function identify(directory) {
  git(directory, "config", "user.name", "Alice");
  git(directory, "config", "user.email", "alice@example.com");
  git(directory, "config", "commit.gpgsign", "false");
}

// what each generation has in its catalog
export const CATALOGS = {
  "7.0.x": { framework: "7.0.8", reactor: "2025.0.6", micrometer: "1.16.6" },
  "7.1.x": { framework: "7.0.8", reactor: "2025.0.7", micrometer: "1.17.1" },
  main: {
    framework: "7.1.0-M2",
    reactor: "2026.0.0-M1",
    micrometer: "1.18.0-M1",
  },
  "5.8.x": { framework: "5.3.40", reactor: "2020.0.40", micrometer: "1.9.17" },
  "6.4.x": { framework: "6.1.20", reactor: "2022.0.20", micrometer: "1.12.13" },
  "6.5.x": { framework: "6.2.9", reactor: "2024.0.8", micrometer: "1.14.9" },
};

/**
 * The repositories of a project, as they are just after a release was made public:
 *
 * the OSS repository, `oss.git`:
 *   7.0.x (7.0.9-SNAPSHOT) <- 7.1.x (7.1.3-SNAPSHOT) <- main (7.2.0-SNAPSHOT)
 *   and the tag 7.0.9 (annotated): the embargoed fix, the dependency updates of the release
 *   train (the framework, reactor and micrometer) and `Release 7.0.9`, on the frozen branch.
 *   The tag is not in a branch of OSS yet.
 *
 * the commercial repository, `commercial.git`:
 *   embargoed/frozen/<b> and embargoed/active/<b> for 7.0.x, 7.1.x and main: the OSS branch,
 *   an embargoed fix, and the branch of the generation before it merged in
 *   embargoed/lts/5.8.x (5.8.30-SNAPSHOT) <- 6.4.x (6.4.21-SNAPSHOT) <- 6.5.x (6.5.14-SNAPSHOT)
 *   release/7.0.9, release/5.8.30 and the tag 5.8.30 (annotated): an embargoed fix, the
 *   dependency updates and `Release 5.8.30`.
 *
 * `work` is the clone of the commercial repository, as the workflow has it: with an identity,
 * and no OSS remote.
 *
 * `conflict` makes the tag change a file that 7.1.x changes too, in another way.
 */
export function createFixture({ conflict = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "post-publish-"));
  const oss = path.join(root, "owner", "spring-security.git");
  const commercial = path.join(root, "owner", "spring-security-commercial.git");
  const seed = path.join(root, "seed");
  const work = path.join(root, "work");
  fs.mkdirSync(path.dirname(oss), { recursive: true });
  git(root, "init", "-q", "--bare", "-b", "main", oss);
  git(root, "init", "-q", "--bare", "-b", "main", commercial);
  fs.mkdirSync(seed);
  git(seed, "init", "-q", "-b", "7.0.x");
  identify(seed);
  git(seed, "remote", "add", "oss", oss);
  git(seed, "remote", "add", "commercial", commercial);
  const branch = (name, from) => git(seed, "switch", "-q", "-c", name, from);
  const setup = (generation, version) =>
    commitFiles(
      seed,
      {
        "gradle.properties": properties(version),
        "gradle/libs.versions.toml": catalog(CATALOGS[generation]),
      },
      `Set up ${generation}`,
    );

  commitFiles(
    seed,
    { "README.txt": "A project\n", "src/Core.txt": "core\n" },
    "Initial commit",
  );
  const initial = git(seed, "rev-parse", "HEAD");
  setup("7.0.x", "7.0.9-SNAPSHOT");
  branch("7.1.x", "7.0.x");
  setup("7.1.x", "7.1.3-SNAPSHOT");
  if (conflict) {
    commitFiles(seed, { "src/Core.txt": "core of 7.1.x\n" }, "Change the core");
  }
  branch("main", "7.1.x");
  setup("main", "7.2.0-SNAPSHOT");
  git(seed, "push", "-q", "oss", "7.0.x", "7.1.x", "main");

  // the embargoed branches, in order: each generation merges the one before it
  let previous;
  for (const name of ["7.0.x", "7.1.x", "main"]) {
    branch(`embargoed/frozen/${name}`, name);
    if (previous) {
      git(seed, "merge", "-q", "--no-edit", `embargoed/frozen/${previous}`);
    }
    commitFiles(
      seed,
      { [`src/Secret-${name}.txt`]: "embargoed\n" },
      `Fix a vulnerability in ${name}`,
    );
    previous = name;
  }
  previous = undefined;
  for (const name of ["7.0.x", "7.1.x", "main"]) {
    branch(`embargoed/active/${name}`, `embargoed/frozen/${name}`);
    if (previous) {
      git(seed, "merge", "-q", "--no-edit", `embargoed/active/${previous}`);
    }
    commitFiles(
      seed,
      { [`src/Next-${name}.txt`]: "embargoed\n" },
      `Fix another vulnerability in ${name}`,
    );
    previous = name;
  }

  // long-term support
  branch("embargoed/lts/5.8.x", initial);
  setup("5.8.x", "5.8.30-SNAPSHOT");
  branch("embargoed/lts/6.4.x", "embargoed/lts/5.8.x");
  setup("6.4.x", "6.4.21-SNAPSHOT");
  branch("embargoed/lts/6.5.x", "embargoed/lts/6.4.x");
  setup("6.5.x", "6.5.14-SNAPSHOT");

  // the release of 7.0.9: from the frozen branch, with the fix that becomes public
  branch("release/7.0.9", "embargoed/frozen/7.0.x");
  commitFiles(
    seed,
    {
      "src/Fixed.txt":
        "the fix of the vulnerability, public with the release\n",
      ...(conflict ? { "src/Core.txt": "core of the release\n" } : {}),
    },
    "Fix CVE-2026-0001",
  );
  commitFiles(
    seed,
    {
      "gradle/libs.versions.toml": catalog({
        framework: "7.0.11",
        reactor: "2025.0.9",
        micrometer: "1.16.9",
      }),
    },
    "Update the dependencies of the release train",
  );
  commitFiles(
    seed,
    { "gradle.properties": properties("7.0.9") },
    "Release 7.0.9",
  );
  git(seed, "tag", "-a", "-m", "Release 7.0.9", "7.0.9");
  git(seed, "push", "-q", "oss", "refs/tags/7.0.9");

  // the release of 5.8.30, which is commercial only
  branch("release/5.8.30", "embargoed/lts/5.8.x");
  commitFiles(
    seed,
    { "src/Fixed.txt": "the fix of 5.8\n" },
    "Fix CVE-2026-0002",
  );
  commitFiles(
    seed,
    {
      "gradle/libs.versions.toml": catalog({
        framework: "5.3.44",
        reactor: "2020.0.44",
        micrometer: "1.9.20",
      }),
    },
    "Update the dependencies of the release train",
  );
  commitFiles(
    seed,
    { "gradle.properties": properties("5.8.30") },
    "Release 5.8.30",
  );
  git(seed, "tag", "-a", "-m", "Release 5.8.30", "5.8.30");

  const refs = git(
    seed,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/embargoed",
    "refs/heads/release",
  ).split("\n");
  git(seed, "push", "-q", "commercial", ...refs, "refs/tags/5.8.30");

  git(root, "clone", "-q", commercial, work);
  identify(work);
  git(work, "checkout", "-q", "--detach", "origin/embargoed/active/main");
  return {
    root,
    oss,
    commercial,
    work,
    seed,
    /** What a branch of a bare repository has in a file, or undefined. */
    show(repository, ref, file) {
      try {
        return git(repository, "show", `${ref}:${file}`);
      } catch {
        return undefined;
      }
    },
    version(repository, ref) {
      return /^version=(.*)$/m.exec(
        git(repository, "show", `${ref}:gradle.properties`),
      )[1];
    },
    catalogOf(repository, ref) {
      const text = git(repository, "show", `${ref}:gradle/libs.versions.toml`);
      return Object.fromEntries(
        [
          ...text.matchAll(
            /^(spring-framework|reactor|micrometer) = "([^"]*)"/gm,
          ),
        ].map((m) => [m[1], m[2]]),
      );
    },
  };
}

/** The plan of an OSS release, as plan-post-publish writes it, for a chain of OSS branches. */
export function ossPlan(tag, branches) {
  return {
    tag,
    ossRepository: "owner/spring-security",
    commercialRepository: "owner/spring-security-commercial",
    kind: "oss",
    merge: {
      kind: "oss",
      tagRepository: "owner/spring-security",
      branches: branches.map((branch) => ({
        generation: branch === "main" ? "7.2.x" : branch,
        branch,
        frozen: `embargoed/frozen/${branch}`,
        active: `embargoed/active/${branch}`,
      })),
    },
  };
}

export function ltsPlan(tag, generations) {
  return {
    tag,
    ossRepository: "owner/spring-security",
    commercialRepository: "owner/spring-security-commercial",
    kind: "lts",
    merge: {
      kind: "lts",
      tagRepository: "owner/spring-security-commercial",
      branches: generations.map((generation) => ({
        generation,
        branch: `embargoed/lts/${generation}`,
      })),
    },
  };
}
