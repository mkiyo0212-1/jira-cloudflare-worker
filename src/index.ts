export interface Env {
  JIRA_UPDATE_BUCKET: R2Bucket;
  R2_UPDATE_PREFIX?: string;
  R2_DONE_PREFIX?: string;
  R2_FAILED_PREFIX?: string;
  JIRA_BASE_URL: string;
  JIRA_EMAIL: string;
  JIRA_API_TOKEN: string;
  JIRA_SPRINT_FIELD?: string;
  MOVE_FAILED?: string;
  DRY_RUN?: string;
}

interface JiraMention {
  name: string;
  jira_id?: string;
  team_id?: string;
}

interface JiraUpdate {
  issue: string;
  assignee?: string;
  status?: number;
  sprint?: number;
  labels?: string[];
  comment?: {
    to?: JiraMention;
    body?: string;
    cc?: JiraMention[];
  };
}

interface RunResult {
  processed: string[];
  failed: Array<{ key: string; error: string }>;
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDailyUpdate(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/run") {
      return new Response("OK");
    }

    const result = await runDailyUpdate(env);
    return Response.json(result, { status: result.failed.length === 0 ? 200 : 207 });
  },
};

async function runDailyUpdate(env: Env): Promise<RunResult> {
  const prefix = normalizePrefix(env.R2_UPDATE_PREFIX || "update/");
  const objects = await listAllObjects(env.JIRA_UPDATE_BUCKET, prefix);
  const jsonObjects = objects.filter((object) => object.key.endsWith(".json"));
  const processed: string[] = [];
  const failed: Array<{ key: string; error: string }> = [];

  for (const object of jsonObjects) {
    try {
      const source = await readR2Text(env.JIRA_UPDATE_BUCKET, object.key);
      const ticket = JSON.parse(source) as JiraUpdate;
      validateTicket(ticket, object.key);
      await applyJiraUpdate(ticket, env);
      await moveR2Object(env, object.key, source, doneKey(env, object.key));
      processed.push(object.key);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed: ${object.key}`, error);
      failed.push({ key: object.key, error: message });

      if (env.MOVE_FAILED === "true") {
        await moveFailedObject(env, object.key, message);
      }
    }
  }

  console.log(`Jira daily update processed=${processed.length} failed=${failed.length}`);
  return { processed, failed };
}

async function listAllObjects(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;

  do {
    const page = await bucket.list({ prefix, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return objects;
}

async function readR2Text(bucket: R2Bucket, key: string): Promise<string> {
  const object = await bucket.get(key);
  if (!object) {
    throw new Error(`R2 object not found: ${key}`);
  }
  return object.text();
}

async function moveR2Object(env: Env, sourceKey: string, body: string, destinationKey: string): Promise<void> {
  if (env.DRY_RUN === "true") {
    console.log(`DRY_RUN move ${sourceKey} -> ${destinationKey}`);
    return;
  }

  await env.JIRA_UPDATE_BUCKET.put(destinationKey, body, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  await env.JIRA_UPDATE_BUCKET.delete(sourceKey);
}

async function moveFailedObject(env: Env, sourceKey: string, error: string): Promise<void> {
  if (env.DRY_RUN === "true") {
    return;
  }

  const object = await env.JIRA_UPDATE_BUCKET.get(sourceKey);
  if (!object) {
    return;
  }

  const source = await object.text();
  const destinationKey = failedKey(env, sourceKey);
  await env.JIRA_UPDATE_BUCKET.put(destinationKey, source, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { error: error.slice(0, 512) },
  });
  await env.JIRA_UPDATE_BUCKET.delete(sourceKey);
}

async function applyJiraUpdate(ticket: JiraUpdate, env: Env): Promise<void> {
  if (env.DRY_RUN === "true") {
    console.log("DRY_RUN", JSON.stringify(ticket));
    return;
  }

  if (ticket.assignee) {
    await jiraFetch(env, `/rest/api/3/issue/${ticket.issue}/assignee`, {
      method: "PUT",
      body: JSON.stringify({ accountId: ticket.assignee }),
    });
  }

  if (typeof ticket.status === "number") {
    await jiraFetch(env, `/rest/api/3/issue/${ticket.issue}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: String(ticket.status) } }),
    });
  }

  const fields: Record<string, unknown> = {};
  if (typeof ticket.sprint === "number" && env.JIRA_SPRINT_FIELD) {
    fields[env.JIRA_SPRINT_FIELD] = ticket.sprint;
  }

  const labels = uniqueLabels(ticket.labels ?? []);
  const update: Record<string, unknown[]> = {};
  if (labels.length > 0) {
    update.labels = labels.map((label) => ({ add: label }));
  }

  if (Object.keys(fields).length > 0 || Object.keys(update).length > 0) {
    await jiraFetch(env, `/rest/api/3/issue/${ticket.issue}`, {
      method: "PUT",
      body: JSON.stringify({ fields, update }),
    });
  }

  if (ticket.comment?.body) {
    await jiraFetch(env, `/rest/api/3/issue/${ticket.issue}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: toAtlassianDoc(ticket.comment) }),
    });
  }
}

async function jiraFetch(env: Env, path: string, init: RequestInit): Promise<void> {
  const response = await fetch(`${env.JIRA_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Authorization": `Basic ${btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`)}`,
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Jira API failed ${path}: ${response.status} ${await response.text()}`);
  }
}

function toAtlassianDoc(comment: NonNullable<JiraUpdate["comment"]>): unknown {
  const content = [];
  const mentions = [comment.to, ...(comment.cc ?? [])].filter((mention): mention is JiraMention => Boolean(mention?.jira_id));

  if (mentions.length > 0) {
    content.push({
      type: "paragraph",
      content: mentions.flatMap((mention, index) => [
        ...(index === 0 ? [] : [{ type: "text", text: " " }]),
        { type: "mention", attrs: { id: mention.jira_id, text: `@${mention.name}` } },
      ]),
    });
  }

  for (const line of comment.body?.split("\n") ?? []) {
    content.push({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    });
  }

  return {
    type: "doc",
    version: 1,
    content,
  };
}

function validateTicket(ticket: JiraUpdate, key: string): void {
  if (!ticket.issue) {
    throw new Error(`${key}: issue is required`);
  }
}

function uniqueLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const label of labels) {
    const normalized = label.toLocaleLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(label);
    }
  }

  return unique;
}

function doneKey(env: Env, sourceKey: string): string {
  const prefix = datedPrefix(env.R2_DONE_PREFIX || "done/");
  return `${prefix}${baseName(sourceKey)}`;
}

function failedKey(env: Env, sourceKey: string): string {
  const prefix = datedPrefix(env.R2_FAILED_PREFIX || "failed/");
  return `${prefix}${timestamp()}-${baseName(sourceKey)}`;
}

function datedPrefix(prefix: string): string {
  return `${normalizePrefix(prefix)}${new Date().toISOString().slice(0, 10)}/`;
}

function normalizePrefix(value: string): string {
  const trimmed = value.replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/` : "";
}

function baseName(key: string): string {
  return key.split("/").filter(Boolean).at(-1) || key;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
