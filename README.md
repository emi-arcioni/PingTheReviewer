# PingTheReviewer

Finds your open (non-draft) PRs on `VantaInc/obsidian` and sends a friendly Slack DM to each requested reviewer.

## Setup

### 1. Configure your environment

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

```ini
GITHUB_REPO=VantaInc/obsidian
GITHUB_USERNAME=your-github-username
SLACK_TOKEN=xoxp-your-token-here
SLACK_MAP_PATH=/path/to/obsidian/.github/github_to_slack_usernames.yml
```

### 2. Get a Slack token

You need a Slack **user token** (starts with `xoxp-`) so the message appears as coming from you.

1. Go to **https://api.slack.com/apps** and click **Create New App → From scratch**.
2. Name it (e.g. "PingTheReviewer"), select the **Vanta** workspace.
3. In the left sidebar go to **OAuth & Permissions**.
4. Under **User Token Scopes** add: `chat:write`, `im:write`.
5. Click **Install to Workspace** → authorize.
6. Copy the **User OAuth Token** (`xoxp-...`) and set it as `SLACK_TOKEN` in your `.env`.

### 3. Install dependencies

```bash
npm install
```

## Usage

```bash
# Preview without sending anything
node index.js --dry-run

# Send the pings
node index.js
```

## How it works

1. Uses `gh` CLI to list your open, non-draft PRs on `VantaInc/obsidian`.
2. Reads the YAML file at `SLACK_MAP_PATH` to resolve GitHub usernames → Slack member IDs.
3. Opens a DM channel with each reviewer and sends a message.

Team reviewer handles (e.g. `design-systems-global-approvers`) are silently skipped since they're not in the user map.

## Project structure

```
config.js    # env vars loaded from .env
helpers.js   # loadSlackMap, getOpenPRs, Slack API calls, message builder
index.js     # main orchestration
```
