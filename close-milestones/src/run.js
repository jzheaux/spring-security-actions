import fs from "node:fs";
import { pathToFileURL } from "node:url";
import * as core from "@actions/core";

/**
 * Whether the module with the given import.meta.url is the program being run,
 * as in `node src/<action>/index.js`, and not imported by a test. The path of the
 * program is resolved first: Node reports the real path of the main module, so a
 * path through a symbolic link (/tmp on macOS) would never match otherwise.
 */
export function isMain(metaUrl) {
  const program = process.argv[1];
  if (!program) {
    return false;
  }
  return metaUrl === pathToFileURL(fs.realpathSync(program)).href;
}

/** An error that GitHub shows with a title: ::error title=...::message */
export class TitledError extends Error {
  constructor(title, message) {
    super(message);
    this.title = title;
  }
}

/**
 * Runs an action, and reports an error the way GitHub shows it (and sets a failing
 * exit code), instead of printing a stack trace.
 */
export async function execute(action) {
  try {
    await action();
  } catch (error) {
    if (error.title) {
      // an error with a title, as GitHub shows it in the summary of the run
      core.error(error.message, { title: error.title });
      process.exitCode = 1;
    } else {
      core.setFailed(error.message);
    }
  }
}
