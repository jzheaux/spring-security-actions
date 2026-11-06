import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Runs git in a directory, and returns what it printed without the last newline. */
export function git(directory, ...args) {
  try {
    return execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/\n$/, "");
  } catch (error) {
    // what git said, so that a failure of the fixture says why
    error.message = `${error.message}\n${error.stderr ?? ""}`;
    throw error;
  }
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
  git(directory, "config", "tag.gpgsign", "false");
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
const built = new Map();

export function createFixture({ conflict = false, fresh = false } = {}) {
  // The repositories are made once for the tests of a file, and each test gets a clone of
  // the commercial one of its own. A test that pushes to the repositories asks for fresh ones.
  const key = String(conflict);
  if (!fresh && built.has(key)) {
    return cloneOf(built.get(key));
  }
  const repositories = buildRepositories({ conflict });
  if (!fresh) {
    built.set(key, repositories);
  }
  return cloneOf(repositories);
}

function cloneOf(repositories) {
  const work = fs.mkdtempSync(path.join(repositories.root, "work-"));
  git(repositories.root, "clone", "-q", repositories.commercial, work);
  identify(work);
  git(work, "checkout", "-q", "--detach", "origin/embargoed/active/main");
  return { ...repositories, work };
}

function buildRepositories({ conflict }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "post-publish-"));
  const oss = path.join(root, "owner", "spring-security.git");
  const commercial = path.join(root, "owner", "spring-security-commercial.git");
  const seed = path.join(root, "seed");
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

  return {
    root,
    oss,
    commercial,
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

/**
 * What merge-tag leaves in the clone, made by hand (this action does not use the other): the OSS
 * remote with the branch 7.0.x and the tag 7.0.9 fetched, the work ref of 7.0.x with the
 * tag merged into it, and the work ref of the frozen branch with 7.0.x merged down. It returns the
 * merge file that merge-tag writes. With `leak`, one more thing goes to OSS, as a bug could make
 * it: "commit" (a commit that merge-tag did not make), "message" (a merge that names an embargoed
 * branch) or "commercial" (a merge of a commit that only the commercial repository has).
 */
export function simulateMerges(f, { leak, kind = "oss" } = {}) {
  const w = f.work;
  const oss = "refs/post-publish/oss/7.0.x";
  const frozen = "refs/post-publish/commercial/embargoed/frozen/7.0.x";
  const rev = (ref) => git(w, "rev-parse", ref);
  // the content of the merges of a leak does not matter, so the strategy `ours` keeps them from
  // conflicting; the merge of the tag is real, as the fix has to come
  const merge = (message, ref, strategy = []) => {
    git(w, "merge", "-q", "--no-ff", ...strategy, "-m", message, ref);
    return rev("HEAD");
  };
  git(w, "remote", "add", "oss", f.oss);
  git(
    w,
    "fetch",
    "-q",
    "--no-tags",
    "oss",
    "+refs/heads/7.0.x:refs/remotes/oss/7.0.x",
    "+refs/heads/7.1.x:refs/remotes/oss/7.1.x",
    "+refs/tags/7.0.9:refs/post-publish/tag",
  );
  git(
    w,
    "update-ref",
    "refs/post-publish/tag",
    rev("refs/post-publish/tag^{commit}"),
  );
  git(w, "update-ref", oss, "refs/remotes/oss/7.0.x");
  git(w, "update-ref", frozen, "refs/remotes/origin/embargoed/frozen/7.0.x");
  const before = { oss: rev(oss), frozen: rev(frozen) };

  git(w, "checkout", "-q", "--detach", oss);
  const created = { oss: [], commercial: [] };
  created.oss.push(
    merge("Merge tag '7.0.9' into 7.0.x", "refs/post-publish/tag"),
  );
  if (leak === "commit") {
    commitFiles(w, { "src/Sneaky.txt": "x\n" }, "A commit that no merge made");
  } else if (leak === "message") {
    created.oss.push(
      merge(
        "Merge embargoed/frozen/7.0.x into 7.0.x",
        "refs/remotes/oss/7.1.x",
        ["-s", "ours"],
      ),
    );
  } else if (leak === "commercial") {
    created.oss.push(
      merge(
        "Merge branch '7.0.x' into 7.0.x",
        "refs/remotes/origin/embargoed/active/7.0.x",
      ),
    );
  }
  git(w, "update-ref", oss, "HEAD");
  git(w, "checkout", "-q", "--detach", frozen);
  created.commercial.push(merge("Merge branch '7.0.x' into 7.0.x", oss));
  git(w, "update-ref", frozen, "HEAD");

  return {
    kind,
    tag: "7.0.9",
    branches: [
      {
        repository: "oss",
        branch: "7.0.x",
        ref: oss,
        before: before.oss,
        after: rev(oss),
        changed: true,
      },
      {
        repository: "commercial",
        branch: "embargoed/frozen/7.0.x",
        ref: frozen,
        before: before.frozen,
        after: rev(frozen),
        changed: true,
      },
    ],
    merges: [],
    created,
  };
}

/** Makes a bare repository refuse every push, as a protection of the branch does. */
export function refusePushes(repository) {
  const hook = path.join(repository, "hooks", "pre-receive");
  fs.writeFileSync(hook, '#!/bin/sh\necho "protected branch" >&2\nexit 1\n', {
    mode: 0o755,
  });
}

/** The commit of a branch of a bare repository. */
export const head = (repository, branch) =>
  git(repository, "rev-parse", `refs/heads/${branch}`);
