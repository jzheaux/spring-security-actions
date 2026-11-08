import { execFileSync } from "node:child_process";

/**
 * Runs git in a directory and returns what it printed, without the last newline. If it
 * fails, the error is what git said, with the command, instead of a stack trace.
 */
export function git(directory, ...args) {
  try {
    return execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/\n$/, "");
  } catch (error) {
    const said = `${error.stderr ?? ""}${error.stdout ?? ""}`.trim();
    throw new Error(`git ${args.join(" ")} failed: ${said || error.message}`);
  }
}
