import "dotenv/config";

export const GITHUB_REPO = process.env.GITHUB_REPO;
export const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
export const SLACK_TOKEN = process.env.SLACK_TOKEN;
export const SLACK_MAP_PATH = process.env.SLACK_MAP_PATH;
export const DRY_RUN = process.argv.includes("--dry-run");
