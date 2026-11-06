import fs from "node:fs";
import * as core from "@actions/core";

/**
 * Adds markdown to the summary of the step (the file named by GITHUB_STEP_SUMMARY). Run
 * locally, where there is no such file, it prints the markdown instead.
 */
export function addSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) {
    fs.appendFileSync(file, `${markdown}\n`);
  } else {
    core.info(markdown);
  }
}

/** A markdown table from a header and rows, each a list of cells. */
export function table(header, rows) {
  const line = (cells) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join(
    "\n",
  );
}
