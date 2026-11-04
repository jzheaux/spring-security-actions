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

function identify(directory) {
  git(directory, "config", "user.name", "Alice");
  git(directory, "config", "user.email", "alice@example.com");
  git(directory, "config", "commit.gpgsign", "false");
}

/** Writes a file and commits it, in a working copy. Returns the commit. */
export function commitFile(directory, file, content, message) {
  fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
  fs.writeFileSync(path.join(directory, file), content);
  git(directory, "add", "-A");
  git(directory, "commit", "-q", "-m", message);
  return git(directory, "rev-parse", "HEAD");
}

/**
 * Two bare repositories, as a project has them, and a clone of the commercial one, as the
 * workflow has it checked out (its remote is origin, with all the branches):
 *
 * the OSS repository, `oss.git`:
 *   7.0.x (7.0.5-SNAPSHOT) <- 7.1.x (7.1.1-SNAPSHOT) <- main (7.2.0-SNAPSHOT)
 *
 * the commercial repository, `commercial.git`, which has none of the OSS branches (a
 * commercial `main` and `7.0.x` with commercial-only commits if `collide` is set):
 *   embargoed/frozen/<branch>   the OSS branch and an embargoed fix (a secret file), and the
 *                               frozen branch of the generation before it merged in
 *   embargoed/active/<branch>   the frozen branch and one more embargoed fix
 *   embargoed/lts/6.4.x (6.4.13-SNAPSHOT) <- embargoed/lts/6.5.x (6.5.11-SNAPSHOT)
 *   release/7.0.5 (frozen/7.0.x), release/7.1.1 (frozen/7.1.x), release/7.2.0-M2
 *   (frozen/main), release/7.0.5.1 and release/7.1.1.1 (the hotfixes, from active) and release/6.5.11
 *
 * `work` is the clone of the commercial repository; the OSS remote is not in it.
 */
export function createFixture({ collide = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freeze-"));
  const oss = path.join(root, "oss.git");
  const commercial = path.join(root, "commercial.git");
  const seed = path.join(root, "seed");
  const work = path.join(root, "work");
  git(root, "init", "-q", "--bare", "-b", "main", oss);
  git(root, "init", "-q", "--bare", "-b", "main", commercial);
  fs.mkdirSync(seed);
  git(seed, "init", "-q", "-b", "7.0.x");
  identify(seed);
  git(seed, "remote", "add", "oss", oss);
  git(seed, "remote", "add", "commercial", commercial);

  const version = (v, message = `Set the version to ${v}`) =>
    commitFile(
      seed,
      "gradle.properties",
      `org.gradle.jvmargs=-Xmx2g\nversion=${v}\n`,
      message,
    );
  const branch = (name, from) => git(seed, "switch", "-q", "-c", name, from);

  commitFile(seed, "README.txt", "A project\n", "Initial commit");
  const initial = git(seed, "rev-parse", "HEAD");
  version("7.0.5-SNAPSHOT");
  branch("7.1.x", "7.0.x");
  version("7.1.1-SNAPSHOT");
  branch("main", "7.1.x");
  version("7.2.0-SNAPSHOT");
  git(seed, "push", "-q", "oss", "7.0.x", "7.1.x", "main");

  // the embargoed branches, in order: each generation merges the one before it
  let previous;
  for (const name of ["7.0.x", "7.1.x", "main"]) {
    branch(`embargoed/frozen/${name}`, name);
    if (previous) {
      git(seed, "merge", "-q", "--no-edit", `embargoed/frozen/${previous}`);
    }
    commitFile(
      seed,
      `src/Secret-${name}.txt`,
      "embargoed\n",
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
    commitFile(
      seed,
      `src/Next-${name}.txt`,
      "embargoed\n",
      `Fix another vulnerability in ${name}`,
    );
    previous = name;
  }
  branch("embargoed/lts/6.4.x", initial);
  version("6.4.13-SNAPSHOT");
  branch("embargoed/lts/6.5.x", "embargoed/lts/6.4.x");
  version("6.5.11-SNAPSHOT");

  const release = (name, from, v) => {
    branch(`release/${name}`, from);
    version(v, `Release ${name}`);
  };
  release("7.0.5", "embargoed/frozen/7.0.x", "7.0.5");
  release("7.1.1", "embargoed/frozen/7.1.x", "7.1.1");
  release("7.2.0-M2", "embargoed/frozen/main", "7.2.0-M2");
  release("7.0.5.1", "embargoed/active/7.0.x", "7.0.5.1");
  release("7.1.1.1", "embargoed/active/7.1.x", "7.1.1.1");
  release("6.5.11", "embargoed/lts/6.5.x", "6.5.11");

  const refs = git(
    seed,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/embargoed",
    "refs/heads/release",
  ).split("\n");
  if (collide) {
    // the commercial repository has a main, its default branch, and a 7.0.x of its own
    branch("main-commercial", initial);
    commitFile(
      seed,
      "src/Commercial-only.txt",
      "commercial\n",
      "Commercial only, on main",
    );
    git(
      seed,
      "push",
      "-q",
      "commercial",
      "main-commercial:main",
      "main-commercial:7.0.x",
    );
  }
  git(seed, "push", "-q", "commercial", ...refs);

  git(root, "clone", "-q", commercial, work);
  identify(work);
  // as the workflow has it: a branch of the repository checked out
  git(work, "checkout", "-q", "--detach", "origin/embargoed/active/main");
  return {
    root,
    oss,
    commercial,
    work,
    seed,
    initial,
    /** Adds a commit to a branch of a bare repository, through the seed. */
    pushCommit(remote, branchName, file, content, message) {
      git(seed, "fetch", "-q", remote, branchName);
      git(seed, "switch", "-q", "--detach", "FETCH_HEAD");
      const commit = commitFile(seed, file, content, message);
      git(seed, "push", "-q", remote, `HEAD:refs/heads/${branchName}`);
      return commit;
    },
  };
}

/** A train, as load-train writes it: project -> version -> commit-hashes. */
export function trainWith(project, entries) {
  return {
    state: "pending",
    releases: {
      [project]: Object.fromEntries(
        Object.entries(entries).map(([version, hashes]) => [
          version,
          { "commit-hashes": hashes },
        ]),
      ),
    },
  };
}
