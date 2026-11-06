import { spawnSync } from "node:child_process";

/**
 * Runs git, with the token as the credentials of the requests to GitHub (a basic
 * authorization header, set through the environment so that it is in no argument, which
 * an error would print). It gives the exit code, what git printed and what it said, and
 * never throws for a git that failed: its failure is an answer to handle.
 */
export function gitTry(directory, token, ...args) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraheader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: basic ${basic}`;
  }
  const result = spawnSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    env,
  });
  return {
    code: result.status ?? 1,
    stdout: (result.stdout ?? "").replace(/\n$/, ""),
    stderr: (result.stderr ?? "").replace(/\n$/, ""),
  };
}

/** Like gitTry, but a git that failed is an error with what it said. */
export function git(directory, token, ...args) {
  const result = gitTry(directory, token, ...args);
  if (result.code !== 0) {
    const said = `${result.stderr}\n${result.stdout}`.trim();
    throw new Error(`git ${args[0]} failed: ${said}`);
  }
  return result.stdout;
}
