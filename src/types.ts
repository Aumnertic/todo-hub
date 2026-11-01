export interface Env {
  DB: D1Database;
  MAILER?: SendEmail;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  PUBLIC_URL: string;
  MAIL_FROM: string;
  DEV_AUTH?: string;
}

export type ActorKind = "human" | "agent" | "system";

export interface Actor {
  id: string;
  kind: ActorKind;
  display_name: string;
  email: string | null;
  access_client_id: string | null;
  active: number;
}

export const STATUSES = ["proposed", "todo", "claimed", "blocked", "review", "done", "cancelled"] as const;
export type Status = (typeof STATUSES)[number];

export interface Task {
  id: string;
  title: string;
  description: string;
  acceptance: string;
  project: string | null;
  priority: number;
  status: Status;
  assignee: string | null;
  created_by: string;
  claimed_by: string | null;
  lease_until: number | null;
  due_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

export interface TaskEvent {
  id: string;
  task_id: string;
  actor: string;
  type: string;
  from_status: Status | null;
  to_status: Status | null;
  body: string | null;
  created_at: number;
}

export interface Artifact {
  id: string;
  task_id: string;
  kind: string;
  url: string;
  note: string | null;
  created_by: string;
  created_at: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public task?: Task,
  ) {
    super(message);
  }
}
